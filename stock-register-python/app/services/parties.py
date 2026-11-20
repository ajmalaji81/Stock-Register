"""Parties (customers / suppliers), payments, expenses and the cash book.
Every query is scoped by actor.account_id (the owner's User.id).
"""
from __future__ import annotations

import re
from typing import Any, Optional

from pydantic import ValidationError
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..core.engine import today_iso
from ..core.errors import StockError
from ..core.money import (
    BALANCE_SIGN, BalanceParts, CashFlow, LedgerSource, build_party_ledger, party_balance, reminder_message,
    round2, summarize_cash, whatsapp_link,
)
from ..models import Expense, Party, PartyPayment, Voucher
from ..schemas import ExpenseInput, PartyInput, PaymentInput, first_message
from .activity import iso, log_activity
from .actor import Actor, assert_can
from .stock import fmt_num

BALANCE_KINDS = list(BALANCE_SIGN)
LEDGER_KIND_LABEL = {"SALE": "Sale", "SALE_RETURN": "Sales return", "PURCHASE": "Purchase", "PURCHASE_RETURN": "Purchase return"}


def _parts(opening: float = 0) -> BalanceParts:
    return BalanceParts(opening_balance=opening)


def balance_parts(db: Session, account_id: str, parties: list[Any]) -> dict[str, BalanceParts]:
    """Balance parts for many parties with two grouped queries (no N+1)."""
    out = {p.id: _parts(p.openingBalance) for p in parties}
    if not parties:
        return out
    ids = list(out)
    vouchers = db.execute(
        select(Voucher.partyId, Voucher.kind, func.sum(Voucher.total))
        .where(Voucher.userId == account_id, Voucher.partyId.in_(ids), Voucher.kind.in_(BALANCE_KINDS), Voucher.status != "CANCELLED", Voucher.history.is_(False))
        .group_by(Voucher.partyId, Voucher.kind)
    ).all()
    payments = db.execute(
        select(PartyPayment.partyId, PartyPayment.direction, func.sum(PartyPayment.amount))
        .where(PartyPayment.userId == account_id, PartyPayment.partyId.in_(ids))
        .group_by(PartyPayment.partyId, PartyPayment.direction)
    ).all()
    for party_id, kind, total in vouchers:
        parts = out.get(party_id)
        if parts is None:
            continue
        t = total or 0
        if kind == "SALE":
            parts.sale += t
        elif kind == "SALE_RETURN":
            parts.sale_return += t
        elif kind == "PURCHASE":
            parts.purchase += t
        elif kind == "PURCHASE_RETURN":
            parts.purchase_return += t
    for party_id, direction, amount in payments:
        parts = out.get(party_id)
        if parts is None:
            continue
        if direction == "IN":
            parts.paid_in += amount or 0
        else:
            parts.paid_out += amount or 0
    return out


def to_row(p: Party, parts: BalanceParts) -> dict:
    return {
        "id": p.id, "name": p.name, "type": p.type or "CUSTOMER", "phone": p.phone, "email": p.email, "gstin": p.gstin,
        "state": p.state, "address": p.address, "openingBalance": p.openingBalance, "balance": party_balance(parts),
        "sales": round2(parts.sale - parts.sale_return), "purchases": round2(parts.purchase - parts.purchase_return),
    }


def assert_can_view_parties(actor: Actor) -> None:
    if not actor.can("parties.manage") and not actor.can("payments.manage"):
        assert_can(actor, "parties.manage")


def get_party(db: Session, account_id: str, party_id: str) -> Party:
    p = db.execute(select(Party).where(Party.id == party_id, Party.userId == account_id)).scalar_one_or_none()
    if p is None:
        raise StockError("Party not found", 404)
    return p


# ---------------- Parties ----------------


def list_parties(db: Session, actor: Actor, q: dict) -> dict:
    assert_can_view_parties(actor)
    t = q.get("type")
    type_filter = (
        ["CUSTOMER", "BOTH"] if t == "CUSTOMER" else ["SUPPLIER", "BOTH"] if t == "SUPPLIER" else ["BOTH"] if t == "BOTH" else None
    )
    stmt = select(Party).where(Party.userId == actor.account_id)
    if type_filter:
        stmt = stmt.where(Party.type.in_(type_filter))
    if q.get("q"):
        s = q["q"]
        stmt = stmt.where(
            or_(Party.name.contains(s, autoescape=True), Party.phone.contains(s, autoescape=True), Party.gstin.contains(s.upper(), autoescape=True))
        )
    parties = db.execute(stmt.order_by(Party.name).limit(2000)).scalars().all()
    parts = balance_parts(db, actor.account_id, parties)
    rows = [to_row(p, parts.get(p.id) or _parts(p.openingBalance)) for p in parties]
    if q.get("sort") == "balance_desc":
        rows.sort(key=lambda r: -r["balance"])
    if q.get("sort") == "balance_asc":
        rows.sort(key=lambda r: r["balance"])
    # Totals over every party of the account, not just the filtered page.
    receivable = payable = 0.0
    if q.get("q") or type_filter:
        everyone = db.execute(select(Party.id, Party.openingBalance).where(Party.userId == actor.account_id)).all()

        class _P:
            def __init__(self, id_, ob):
                self.id, self.openingBalance = id_, ob

        everyone = [_P(i, ob) for i, ob in everyone]
        all_parts = balance_parts(db, actor.account_id, everyone)
    else:
        everyone, all_parts = parties, parts
    for p in everyone:
        b = party_balance(all_parts.get(p.id) or _parts(p.openingBalance))
        if b > 0:
            receivable += b
        else:
            payable -= b
    return {"parties": rows, "totals": {"receivable": round2(receivable), "payable": round2(payable)}}


def get_party_row(db: Session, actor: Actor, party_id: str) -> dict:
    assert_can_view_parties(actor)
    p = get_party(db, actor.account_id, party_id)
    parts = balance_parts(db, actor.account_id, [p]).get(p.id) or _parts(p.openingBalance)
    row = to_row(p, parts)
    business = actor.owner.businessName or actor.owner.name
    link = whatsapp_link(p.phone, reminder_message(p.name, row["balance"], business)) if row["balance"] > 0 and p.phone else None
    return {**row, "reminderLink": link}


def create_party(db: Session, actor: Actor, inp: PartyInput) -> dict:
    assert_can(actor, "parties.manage")
    if db.execute(select(Party.id).where(Party.userId == actor.account_id, Party.name == inp.name)).first():
        raise StockError(f'A party named "{inp.name}" already exists', 409)
    p = Party(userId=actor.account_id, **inp.model_dump())
    db.add(p)
    db.flush()
    log_activity(db, actor, "party.create", f"{p.name} ({p.type.lower()})")
    return {"id": p.id}


def update_party(db: Session, actor: Actor, party_id: str, inp: PartyInput) -> None:
    assert_can(actor, "parties.manage")
    p = get_party(db, actor.account_id, party_id)
    clash = db.execute(select(Party.id).where(Party.userId == actor.account_id, Party.name == inp.name, Party.id != party_id)).first()
    if clash:
        raise StockError(f'A party named "{inp.name}" already exists', 409)
    for k, v in inp.model_dump().items():
        setattr(p, k, v)
    db.flush()
    log_activity(db, actor, "party.update", inp.name)


def delete_party(db: Session, actor: Actor, party_id: str) -> None:
    assert_can(actor, "parties.manage")
    p = get_party(db, actor.account_id, party_id)
    v = db.execute(select(func.count()).select_from(Voucher).where(Voucher.userId == actor.account_id, Voucher.partyId == party_id)).scalar_one()
    pay = db.execute(
        select(func.count()).select_from(PartyPayment).where(PartyPayment.userId == actor.account_id, PartyPayment.partyId == party_id)
    ).scalar_one()
    if v or pay:
        raise StockError("This party has bills or payments, so it can't be deleted.", 409)
    name = p.name
    db.execute(delete(Party).where(Party.id == party_id))
    db.expire_all()
    log_activity(db, actor, "party.delete", name)


def _pick(row: dict, *names: str) -> Any:
    """Lenient column lookup: "Opening Balance", "opening_balance", "openingBalance" all match."""

    def norm(s: str) -> str:
        return re.sub(r"[^a-z]", "", s.lower())

    wanted = [norm(n) for n in names]
    for k, v in row.items():
        if norm(str(k)) in wanted:
            return v
    return None


def _norm_type(v: Any) -> str:
    s = str(v if v is not None else "").strip().upper()
    if s.startswith("SUP") or s == "VENDOR":
        return "SUPPLIER"
    if s == "BOTH":
        return "BOTH"
    return "CUSTOMER"


def import_parties(db: Session, actor: Actor, rows: list[dict]) -> dict:
    assert_can(actor, "parties.manage")
    existing = {n.lower() for n in db.execute(select(Party.name).where(Party.userId == actor.account_id)).scalars()}
    errors: list[dict] = []
    results: list[dict] = []
    data: list[Party] = []

    def s(v: Any) -> str:
        return "" if v is None else str(v)

    for i, raw in enumerate(rows):
        line = raw["line"] if isinstance(raw.get("line"), (int, float)) and not isinstance(raw.get("line"), bool) else i + 1
        ob = _pick(raw, "openingbalance", "opening", "balance")
        try:
            parsed = PartyInput.model_validate(
                {
                    "name": s(_pick(raw, "name", "party", "partyname")),
                    "type": _norm_type(_pick(raw, "type", "partytype")),
                    "phone": s(_pick(raw, "phone", "mobile", "phoneno", "contact")),
                    "email": s(_pick(raw, "email", "mail")),
                    "gstin": s(_pick(raw, "gstin", "gst", "gstno")),
                    "state": s(_pick(raw, "state")),
                    "address": s(_pick(raw, "address")),
                    "openingBalance": 0 if ob is None or ob == "" else ob,
                }
            )
        except ValidationError as e:
            error = first_message(e)
            errors.append({"row": i + 1, "error": error})
            results.append({"line": line, "ok": False, "error": error})
            continue
        key = parsed.name.lower()
        if key in existing:
            error = f'"{parsed.name}" already exists'
            errors.append({"row": i + 1, "error": error})
            results.append({"line": line, "ok": False, "error": error})
            continue
        existing.add(key)
        data.append(Party(userId=actor.account_id, **parsed.model_dump()))
        results.append({"line": line, "ok": True})
    if data:
        db.add_all(data)
        db.flush()
        log_activity(db, actor, "party.import", f"{len(data)} parties imported")
    return {"created": len(data), "failed": len(errors), "errors": errors, "results": results}


def party_ledger(db: Session, actor: Actor, party_id: str, from_: Optional[str] = None, to: Optional[str] = None) -> dict:
    assert_can_view_parties(actor)
    p = get_party(db, actor.account_id, party_id)
    vouchers = db.execute(
        select(Voucher).where(
            Voucher.userId == actor.account_id, Voucher.partyId == party_id, Voucher.kind.in_(BALANCE_KINDS), Voucher.status != "CANCELLED", Voucher.history.is_(False)
        )
    ).scalars().all()
    payments = db.execute(select(PartyPayment).where(PartyPayment.userId == actor.account_id, PartyPayment.partyId == party_id)).scalars().all()
    sources = [
        LedgerSource(
            id=v.id, date=v.date, created_at=iso(v.createdAt), kind=v.kind, ref=f"{LEDGER_KIND_LABEL.get(v.kind, v.kind)} #{v.number}",
            amount=v.total, notes=v.notes,
        )
        for v in vouchers
    ] + [
        LedgerSource(
            id=x.id, date=x.date, created_at=iso(x.createdAt), kind="PAYMENT_IN" if x.direction == "IN" else "PAYMENT_OUT",
            ref=f"{'Payment received' if x.direction == 'IN' else 'Payment made'} ({x.mode}{' · ' + x.reference if x.reference else ''})",
            amount=x.amount, notes=x.notes,
        )
        for x in payments
    ]
    rows = build_party_ledger(p.openingBalance, sources, from_, to)
    closing = rows[-1].balance if rows else round2(p.openingBalance)
    return {
        "party": {"id": p.id, "name": p.name},
        "rows": [
            {"id": r.id, "date": r.date, "createdAt": r.created_at, "kind": r.kind, "ref": r.ref, "amount": r.amount,
             "notes": r.notes, "debit": r.debit, "credit": r.credit, "balance": r.balance}
            for r in rows
        ],
        "closing": closing,
    }


# ---------------- Payments ----------------


def _payment_row(r: PartyPayment) -> dict:
    return {
        "id": r.id, "partyId": r.partyId, "partyName": r.party.name, "direction": r.direction, "amount": r.amount,
        "mode": r.mode, "date": r.date, "reference": r.reference, "notes": r.notes, "voucherId": r.voucherId,
        "createdBy": r.createdBy, "createdAt": iso(r.createdAt),
    }


def list_payments(db: Session, actor: Actor, f: dict) -> list[dict]:
    assert_can(actor, "payments.manage")
    stmt = select(PartyPayment).where(PartyPayment.userId == actor.account_id)
    if f.get("partyId"):
        stmt = stmt.where(PartyPayment.partyId == f["partyId"])
    if f.get("direction"):
        stmt = stmt.where(PartyPayment.direction == f["direction"])
    if f.get("mode"):
        stmt = stmt.where(PartyPayment.mode == f["mode"])
    if f.get("from"):
        stmt = stmt.where(PartyPayment.date >= f["from"])
    if f.get("to"):
        stmt = stmt.where(PartyPayment.date <= f["to"])
    rows = db.execute(stmt.order_by(PartyPayment.date.desc(), PartyPayment.createdAt.desc()).limit(1000)).scalars().all()
    return [_payment_row(r) for r in rows]


def create_payment(db: Session, actor: Actor, inp: PaymentInput) -> dict:
    assert_can(actor, "payments.manage")
    party = get_party(db, actor.account_id, inp.partyId)
    if inp.voucherId:
        v = db.execute(select(Voucher).where(Voucher.id == inp.voucherId, Voucher.userId == actor.account_id)).scalar_one_or_none()
        if v is None:
            raise StockError("Bill not found", 404)
        if v.partyId != party.id:
            raise StockError("That bill belongs to a different party", 400)
    p = PartyPayment(
        userId=actor.account_id, partyId=party.id, direction=inp.direction, amount=round2(inp.amount), mode=inp.mode,
        date=inp.date, reference=inp.reference, notes=inp.notes, voucherId=inp.voucherId or None, createdBy=actor.name,
    )
    db.add(p)
    db.flush()
    log_activity(
        db, actor, "payment.create",
        f"{'Received from' if inp.direction == 'IN' else 'Paid to'} {party.name}: ₹{fmt_num(round2(inp.amount))} ({inp.mode})",
    )
    return {"id": p.id}


def reverse_payment(db: Session, actor: Actor, payment_id: str) -> dict:
    """Payments are never deleted; a mistake is undone by an equal opposite entry."""
    assert_can(actor, "payments.manage")
    orig = db.execute(select(PartyPayment).where(PartyPayment.id == payment_id, PartyPayment.userId == actor.account_id)).scalar_one_or_none()
    if orig is None:
        raise StockError("Payment not found", 404)
    if orig.notes.startswith("Reversal of "):
        raise StockError("A reversal can't be reversed again", 400)
    if db.execute(
        select(PartyPayment.id).where(
            PartyPayment.userId == actor.account_id, PartyPayment.notes.startswith(f"Reversal of {orig.id}", autoescape=True)
        )
    ).first():
        raise StockError("This payment has already been reversed", 409)
    p = PartyPayment(
        userId=actor.account_id, partyId=orig.partyId, direction="OUT" if orig.direction == "IN" else "IN", amount=orig.amount,
        mode=orig.mode, date=today_iso(), reference=orig.reference,
        notes=f"Reversal of {orig.id} ({orig.date}, ₹{fmt_num(orig.amount)})", voucherId=orig.voucherId, createdBy=actor.name,
    )
    db.add(p)
    db.flush()
    log_activity(db, actor, "payment.reverse", f"{orig.party.name}: ₹{fmt_num(orig.amount)} ({orig.date})")
    return {"id": p.id}


# ---------------- Expenses ----------------


def list_expenses(db: Session, actor: Actor, f: dict) -> dict:
    assert_can(actor, "expenses.manage")
    stmt = select(Expense).where(Expense.userId == actor.account_id)
    if f.get("category"):
        stmt = stmt.where(Expense.category == f["category"])
    if f.get("from"):
        stmt = stmt.where(Expense.date >= f["from"])
    if f.get("to"):
        stmt = stmt.where(Expense.date <= f["to"])
    rows = db.execute(stmt.order_by(Expense.date.desc(), Expense.createdAt.desc()).limit(2000)).scalars().all()
    today = today_iso()
    by_cat: dict[str, float] = {}
    by_month: dict[str, float] = {}
    total = 0.0
    for r in rows:
        by_cat[r.category] = by_cat.get(r.category, 0) + r.amount
        by_month[r.date[:7]] = by_month.get(r.date[:7], 0) + r.amount
        total += r.amount
    return {
        "expenses": [
            {
                "id": r.id, "category": r.category, "amount": r.amount, "mode": r.mode, "date": r.date, "notes": r.notes,
                "createdBy": r.createdBy, "createdAt": iso(r.createdAt),
                "canDelete": today_iso(r.createdAt.astimezone()) == today,
            }
            for r in rows
        ],
        "byCategory": sorted(({"category": c, "total": round2(t)} for c, t in by_cat.items()), key=lambda x: -x["total"]),
        "byMonth": sorted(({"month": m, "total": round2(t)} for m, t in by_month.items()), key=lambda x: x["month"], reverse=True),
        "total": round2(total),
    }


def create_expense(db: Session, actor: Actor, inp: ExpenseInput) -> dict:
    assert_can(actor, "expenses.manage")
    e = Expense(
        userId=actor.account_id, category=inp.category, amount=round2(inp.amount), mode=inp.mode, date=inp.date,
        notes=inp.notes, createdBy=actor.name,
    )
    db.add(e)
    db.flush()
    log_activity(db, actor, "expense.create", f"{inp.category}: ₹{fmt_num(round2(inp.amount))} ({inp.mode})")
    return {"id": e.id}


def delete_expense(db: Session, actor: Actor, expense_id: str) -> None:
    """Only on the day it was recorded, so past cash books don't silently change."""
    assert_can(actor, "expenses.manage")
    e = db.execute(select(Expense).where(Expense.id == expense_id, Expense.userId == actor.account_id)).scalar_one_or_none()
    if e is None:
        raise StockError("Expense not found", 404)
    if today_iso(e.createdAt.astimezone()) != today_iso():
        raise StockError("Expenses can only be deleted on the day they were recorded.", 409)
    cat, amount, date = e.category, e.amount, e.date
    db.execute(delete(Expense).where(Expense.id == expense_id))
    db.expire_all()
    log_activity(db, actor, "expense.delete", f"{cat}: ₹{fmt_num(amount)} ({date})")


# ---------------- Cash book ----------------


def cashbook(db: Session, actor: Actor, from_: Optional[str] = None, to: Optional[str] = None) -> dict:
    if not actor.can("reports.view") and not actor.can("payments.manage"):
        assert_can(actor, "reports.view")
    pq = select(PartyPayment.date, PartyPayment.mode, PartyPayment.amount, PartyPayment.direction).where(PartyPayment.userId == actor.account_id)
    eq = select(Expense.date, Expense.mode, Expense.amount).where(Expense.userId == actor.account_id)
    if to:
        pq, eq = pq.where(PartyPayment.date <= to), eq.where(Expense.date <= to)
    flows = [CashFlow(d, m, a if direction == "IN" else -a) for d, m, a, direction in db.execute(pq).all()]
    flows += [CashFlow(d, m, -a) for d, m, a in db.execute(eq).all()]
    s = summarize_cash(flows, from_, to)
    return {
        "openingCash": s.opening_cash, "openingBank": s.opening_bank, "closingCash": s.closing_cash, "closingBank": s.closing_bank,
        "days": [
            {"date": d.date, "cashIn": d.cash_in, "cashOut": d.cash_out, "bankIn": d.bank_in, "bankOut": d.bank_out}
            for d in s.days
        ],
    }

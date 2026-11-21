"""Read-only books for the Display menu: day book, ledgers, summaries, receivables, ageing and bill-wise outstanding.

Every query is scoped by actor.account_id. Nothing here writes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.errors import StockError
from ..core.gst import KIND_LABEL
from ..core.jsmath import r2
from ..core.money import ledger_sign, party_balance
from ..models import Account, AccountEntry, AccountVoucher, Expense, Party, PartyPayment, Voucher
from .activity import iso
from .actor import Actor
from .parties import balance_parts, party_ledger

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NOTE_LABEL = {"CREDIT_NOTE": "Credit note", "DEBIT_NOTE": "Debit note", "JOURNAL": "Journal"}
#: Voucher kinds that change a party's balance (the other kinds are documents: quotations, orders, challans).
LEDGER_VOUCHER_KINDS = ("SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN")
#: Dr / Cr as the party's ledger sees it (Dr = they owe us more).
VOUCHER_SIDE = {"SALE": "Dr", "SALE_RETURN": "Cr", "PURCHASE": "Cr", "PURCHASE_RETURN": "Dr"}
NOTE_SIDE = {"CREDIT_NOTE": "Cr", "DEBIT_NOTE": "Dr"}

DAY_BOOK_TYPES = [
    ("", "All types"), ("SALE", "Sales"), ("SALE_RETURN", "Sales return"), ("PURCHASE", "Purchase"), ("PURCHASE_RETURN", "Purchase return"),
    ("RECEIPT", "Receipt"), ("PAYMENT", "Payment"), ("EXPENSE", "Expense"), ("CREDIT_NOTE", "Credit note"), ("DEBIT_NOTE", "Debit note"),
    ("JOURNAL", "Journal"), ("DOCUMENT", "Quotations, orders & challans"),
]


def clean_date(raw: Optional[str], default: str = "") -> str:
    raw = (raw or "").strip()
    if not DATE_RE.match(raw):
        return default
    try:
        date.fromisoformat(raw)
    except ValueError:
        return default
    return raw


def _kind_label(kind: str) -> str:
    return KIND_LABEL.get(kind, kind.replace("_", " ").capitalize())


# ---------------------------------------------------------------- day book


def day_book(db: Session, actor: Actor, frm: str, to: str, type_: str = "") -> dict:
    uid = actor.account_id
    rows: list[dict] = []

    vq = (
        select(Voucher, Party.name)
        .outerjoin(Party, Party.id == Voucher.partyId)
        .where(Voucher.userId == uid, Voucher.status != "CANCELLED", Voucher.date >= frm, Voucher.date <= to)
    )
    if actor.godown_ids is not None:
        vq = vq.where(Voucher.godownId.in_(actor.godown_ids or [""]))
    for v, pname in db.execute(vq).all():
        ledger = v.kind in LEDGER_VOUCHER_KINDS
        rows.append({
            "date": v.date, "at": iso(v.createdAt), "code": v.kind if ledger else "DOCUMENT",
            "type": _kind_label(v.kind) + (" (old year)" if v.history else ""), "ref": v.number, "who": pname or ("Cash" if ledger else ""),
            "amount": v.total, "side": VOUCHER_SIDE.get(v.kind, "") if ledger else "", "by": v.createdBy, "href": f"/app/billing/{v.id}",
            "doc": not ledger,
        })

    pq = (
        select(PartyPayment, Party.name)
        .join(Party, Party.id == PartyPayment.partyId)
        .where(PartyPayment.userId == uid, PartyPayment.date >= frm, PartyPayment.date <= to)
    )
    for x, pname in db.execute(pq).all():
        recv = x.direction == "IN"
        rows.append({
            "date": x.date, "at": iso(x.createdAt), "code": "RECEIPT" if recv else "PAYMENT", "type": "Receipt" if recv else "Payment",
            "ref": f"{x.mode}{' · ' + x.reference if x.reference else ''}", "who": pname, "amount": x.amount,
            "side": "Cr" if recv else "Dr", "by": x.createdBy, "href": f"/app/parties/{x.partyId}", "doc": False,
        })

    for e in db.execute(select(Expense).where(Expense.userId == uid, Expense.date >= frm, Expense.date <= to)).scalars():
        rows.append({
            "date": e.date, "at": iso(e.createdAt), "code": "EXPENSE", "type": "Expense", "ref": e.mode, "who": e.category,
            "amount": e.amount, "side": "Dr", "by": e.createdBy, "href": "/app/expenses", "doc": False,
        })

    aq = (
        select(AccountVoucher, Party.name)
        .outerjoin(Party, Party.id == AccountVoucher.partyId)
        .where(AccountVoucher.userId == uid, AccountVoucher.status != "CANCELLED", AccountVoucher.date >= frm, AccountVoucher.date <= to)
    )
    for a, pname in db.execute(aq).all():
        rows.append({
            "date": a.date, "at": iso(a.createdAt), "code": a.kind, "type": NOTE_LABEL.get(a.kind, a.kind), "ref": a.number,
            "who": pname or a.narration, "amount": a.amount, "side": NOTE_SIDE.get(a.kind, ""), "by": a.createdBy,
            "href": f"/app/accounts/vouchers?kind={a.kind}", "doc": False,
        })

    if type_:
        rows = [r for r in rows if r["code"] == type_]
    rows.sort(key=lambda r: (r["date"], r["at"]))
    days: list[dict] = []
    for r in rows:
        if not days or days[-1]["date"] != r["date"]:
            days.append({"date": r["date"], "rows": [], "dr": 0.0, "cr": 0.0})
        d = days[-1]
        d["rows"].append(r)
        if r["side"] == "Dr":
            d["dr"] = r2(d["dr"] + r["amount"])
        elif r["side"] == "Cr":
            d["cr"] = r2(d["cr"] + r["amount"])
    return {"days": days, "count": len(rows), "dr": r2(sum(d["dr"] for d in days)), "cr": r2(sum(d["cr"] for d in days))}


# ---------------------------------------------------------------- ledger


def ledger_choices(db: Session, actor: Actor) -> dict:
    parties = db.execute(select(Party.id, Party.name).where(Party.userId == actor.account_id).order_by(Party.name)).all()
    accounts = db.execute(
        select(Account).where(Account.userId == actor.account_id, Account.isGroup.is_(False)).order_by(Account.type, Account.name)
    ).scalars().all()
    return {"parties": [{"id": i, "name": n} for i, n in parties], "accounts": [{"id": a.id, "name": a.name, "type": a.type} for a in accounts]}


def _dr_cr(balance: float) -> str:
    return "Dr" if balance > 0 else "Cr" if balance < 0 else ""


def account_ledger(db: Session, actor: Actor, account_id: str, frm: str, to: str) -> dict:
    a = db.execute(select(Account).where(Account.id == account_id, Account.userId == actor.account_id)).scalar_one_or_none()
    if a is None:
        raise StockError("Account not found", 404)
    q = (
        select(AccountEntry, AccountVoucher, Party.name)
        .join(AccountVoucher, AccountVoucher.id == AccountEntry.voucherId)
        .outerjoin(Party, Party.id == AccountVoucher.partyId)
        .where(AccountEntry.accountId == a.id, AccountVoucher.userId == actor.account_id, AccountVoucher.status != "CANCELLED")
        .order_by(AccountVoucher.date, AccountVoucher.createdAt, AccountEntry.id)
    )
    bal = r2(a.openingBalance)
    rows: list[dict] = []
    carried = False
    folded = False  # entries before `frm` were rolled into the balance
    for e, v, pname in db.execute(q).all():
        if to and v.date > to:
            break
        if frm and v.date < frm:
            bal = r2(bal + e.debit - e.credit)
            folded = True
            continue
        if not carried:
            carried = True
            if bal != 0:
                rows.append({"date": frm or v.date, "ref": "Balance b/f" if folded else "Opening balance", "debit": bal if bal > 0 else 0,
                             "credit": -bal if bal < 0 else 0, "balance": bal, "href": ""})
        bal = r2(bal + e.debit - e.credit)
        ref = f"{NOTE_LABEL.get(v.kind, v.kind)} #{v.number}" + (f" · {pname}" if pname else "") + (f" · {v.narration}" if v.narration else "")
        rows.append({"date": v.date, "ref": ref, "debit": e.debit, "credit": e.credit, "balance": bal, "href": f"/app/accounts/vouchers?kind={v.kind}"})
    if not carried and bal != 0:  # no movement in the period: just the balance carried
        rows.append({"date": frm or "", "ref": "Balance b/f" if folded else "Opening balance", "debit": bal if bal > 0 else 0, "credit": -bal if bal < 0 else 0, "balance": bal, "href": ""})
    closing = rows[-1]["balance"] if rows else 0.0
    for r in rows:
        r["side"] = _dr_cr(r["balance"])
    return {"name": a.name, "type": a.type, "rows": rows, "closing": closing, "closingSide": _dr_cr(closing)}


def party_ledger_view(db: Session, actor: Actor, party_id: str, frm: str, to: str) -> dict:
    data = party_ledger(db, actor, party_id, frm or None, to or None)
    rows = [
        {"date": r["date"], "ref": r["ref"], "debit": r["debit"], "credit": r["credit"], "balance": r["balance"], "side": _dr_cr(r["balance"]),
         "href": ""}
        for r in data["rows"]
    ]
    return {"name": data["party"]["name"], "type": "PARTY", "rows": rows, "closing": data["closing"], "closingSide": _dr_cr(data["closing"]),
            "partyId": party_id}


# ---------------------------------------------------------------- summaries


@dataclass
class Bucketed:
    """count / amount per (bucket, key), bucket = '' for a whole period or 'YYYY-MM' for months."""

    cells: dict = field(default_factory=dict)

    def add(self, bucket: str, key: str, count: int, amount: float) -> None:
        c, a = self.cells.get((bucket, key), (0, 0.0))
        self.cells[(bucket, key)] = (c + int(count or 0), r2(a + float(amount or 0)))

    def get(self, bucket: str, key: str) -> tuple[int, float]:
        return self.cells.get((bucket, key), (0, 0.0))


def period_totals(db: Session, uid: str, frm: str, to: str, monthly: bool = False) -> Bucketed:
    """Count and amount of each transaction type in [frm, to] (cancelled ones are left out)."""
    out = Bucketed()

    def bucket(col):
        return func.substr(col, 1, 7) if monthly else func.substr(col, 1, 0)

    for b, kind, n, total in db.execute(
        select(bucket(Voucher.date), Voucher.kind, func.count(), func.sum(Voucher.total))
        .where(Voucher.userId == uid, Voucher.status != "CANCELLED", Voucher.kind.in_(LEDGER_VOUCHER_KINDS), Voucher.date >= frm, Voucher.date <= to)
        .group_by(bucket(Voucher.date), Voucher.kind)
    ).all():
        out.add(b or "", kind, n, total)
    for b, direction, n, total in db.execute(
        select(bucket(PartyPayment.date), PartyPayment.direction, func.count(), func.sum(PartyPayment.amount))
        .where(PartyPayment.userId == uid, PartyPayment.date >= frm, PartyPayment.date <= to)
        .group_by(bucket(PartyPayment.date), PartyPayment.direction)
    ).all():
        out.add(b or "", "RECEIPT" if direction == "IN" else "PAYMENT", n, total)
    for b, n, total in db.execute(
        select(bucket(Expense.date), func.count(), func.sum(Expense.amount))
        .where(Expense.userId == uid, Expense.date >= frm, Expense.date <= to).group_by(bucket(Expense.date))
    ).all():
        out.add(b or "", "EXPENSE", n, total)
    for b, kind, n, total in db.execute(
        select(bucket(AccountVoucher.date), AccountVoucher.kind, func.count(), func.sum(AccountVoucher.amount))
        .where(AccountVoucher.userId == uid, AccountVoucher.status != "CANCELLED", AccountVoucher.date >= frm, AccountVoucher.date <= to)
        .group_by(bucket(AccountVoucher.date), AccountVoucher.kind)
    ).all():
        out.add(b or "", kind, n, total)
    return out


SUMMARY_ROWS = [
    ("SALE", "Sales"), ("SALE_RETURN", "Sales return"), ("PURCHASE", "Purchase"), ("PURCHASE_RETURN", "Purchase return"),
    ("RECEIPT", "Receipts"), ("PAYMENT", "Payments"), ("EXPENSE", "Expenses"),
    ("CREDIT_NOTE", "Credit notes"), ("DEBIT_NOTE", "Debit notes"), ("JOURNAL", "Journal"),
]


def transaction_summary(db: Session, actor: Actor, frm: str, to: str) -> dict:
    t = period_totals(db, actor.account_id, frm, to)
    rows = [{"key": k, "label": label, "count": t.get("", k)[0], "amount": t.get("", k)[1]} for k, label in SUMMARY_ROWS]
    amt = {k: t.get("", k)[1] for k, _ in SUMMARY_ROWS}
    return {
        "rows": rows,
        "netSales": r2(amt["SALE"] - amt["SALE_RETURN"]),
        "netPurchases": r2(amt["PURCHASE"] - amt["PURCHASE_RETURN"]),
    }


def _months(frm: str, to: str, limit: int = 36) -> list[str]:
    y, m = int(frm[:4]), int(frm[5:7])
    ey, em = int(to[:4]), int(to[5:7])
    out: list[str] = []
    while (y, m) <= (ey, em) and len(out) < limit:
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def monthly_summary(db: Session, actor: Actor, frm: str, to: str) -> dict:
    t = period_totals(db, actor.account_id, frm, to, monthly=True)
    keys = ("SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN", "RECEIPT", "PAYMENT", "EXPENSE")
    rows = []
    for m in _months(frm, to):
        a = {k: t.get(m, k)[1] for k in keys}
        label = date(int(m[:4]), int(m[5:7]), 1).strftime("%b %Y")
        rows.append({"month": m, "label": label, **{k.lower(): a[k] for k in keys},
                     "net": r2(a["SALE"] - a["SALE_RETURN"] - (a["PURCHASE"] - a["PURCHASE_RETURN"]) - a["EXPENSE"])})
    total = {k.lower(): r2(sum(r[k.lower()] for r in rows)) for k in keys}
    total["net"] = r2(sum(r["net"] for r in rows))
    return {"rows": rows, "total": total}


# ---------------------------------------------------------------- receivables


def receivables(db: Session, actor: Actor) -> dict:
    """Party-wise amounts to receive / pay, from the same numbers as the Parties page."""
    parties = db.execute(select(Party).where(Party.userId == actor.account_id).order_by(Party.name)).scalars().all()
    parts = balance_parts(db, actor.account_id, parties)
    recv, pay = [], []
    for p in parties:
        bal = party_balance(parts[p.id])
        row = {"id": p.id, "name": p.name, "phone": p.phone, "balance": abs(bal)}
        if bal > 0:
            recv.append(row)
        elif bal < 0:
            pay.append(row)
    recv.sort(key=lambda r: -r["balance"])
    pay.sort(key=lambda r: -r["balance"])
    return {"receivable": recv, "payable": pay, "totalReceivable": r2(sum(r["balance"] for r in recv)), "totalPayable": r2(sum(r["balance"] for r in pay))}


# ---------------------------------------------------------------- bill-wise outstanding (FIFO)

OPENING_DATE = ""  # the opening balance has no date: it sorts before every real bill


@dataclass
class Bill:
    key: str
    date: str
    ref: str
    amount: float
    settled: float = 0.0
    seq: int = 0

    @property
    def outstanding(self) -> float:
        return r2(self.amount - self.settled)


@dataclass
class Settlement:
    amount: float
    bill_key: Optional[str] = None  # a payment taken together with its bill settles that bill first


def allocate(bills: list[Bill], settlements: list[Settlement]) -> tuple[list[Bill], float]:
    """Settle bills oldest first (FIFO by bill date); returns (bills sorted oldest first, unallocated amount).

    1. A settlement tied to a bill (a payment taken with the bill) goes to that bill first; any excess joins the pool.
    2. Every other settlement is pooled and spent on the oldest outstanding bills first.
    3. What is left in the pool after all bills are settled is returned as the unallocated amount (an advance).
    """
    ordered = sorted(bills, key=lambda b: (b.date, b.seq))
    by_key = {b.key: b for b in ordered}
    pool = 0.0
    for s in settlements:
        amount = r2(s.amount)
        b = by_key.get(s.bill_key or "")
        if b is not None:
            take = min(amount, b.outstanding)
            b.settled = r2(b.settled + take)
            amount = r2(amount - take)
        pool = r2(pool + amount)
    for b in ordered:
        if pool <= 0:
            break
        take = min(pool, b.outstanding)
        b.settled = r2(b.settled + take)
        pool = r2(pool - take)
    return ordered, pool


def _events(db: Session, uid: str, as_on: str) -> dict[str, list[dict]]:
    """Every party's ledger events up to `as_on` (cancelled and old-year vouchers are left out, like the Parties page)."""
    ev: dict[str, list[dict]] = {}

    def add(pid: Optional[str], **kw: Any) -> None:
        if pid:
            ev.setdefault(pid, []).append(kw)

    for v in db.execute(
        select(Voucher).where(Voucher.userId == uid, Voucher.partyId.is_not(None), Voucher.kind.in_(LEDGER_VOUCHER_KINDS),
                              Voucher.status != "CANCELLED", Voucher.history.is_(False), Voucher.date <= as_on)
    ).scalars():
        add(v.partyId, kind=v.kind, date=v.date, at=iso(v.createdAt), ref=v.number, amount=v.total, key=v.id)
    for x in db.execute(select(PartyPayment).where(PartyPayment.userId == uid, PartyPayment.date <= as_on)).scalars():
        add(x.partyId, kind="PAYMENT_IN" if x.direction == "IN" else "PAYMENT_OUT", date=x.date, at=iso(x.createdAt),
            ref="Payment received" if x.direction == "IN" else "Payment made", amount=x.amount, key=x.voucherId if x.withBill else None)
    for n in db.execute(
        select(AccountVoucher).where(AccountVoucher.userId == uid, AccountVoucher.partyId.is_not(None),
                                     AccountVoucher.kind.in_(("CREDIT_NOTE", "DEBIT_NOTE")), AccountVoucher.status != "CANCELLED",
                                     AccountVoucher.date <= as_on)
    ).scalars():
        add(n.partyId, kind=n.kind, date=n.date, at=iso(n.createdAt), ref=f"{NOTE_LABEL[n.kind]} {n.number}", amount=n.amount, key=n.id)
    return ev


def outstanding(db: Session, actor: Actor, side: str, as_on: str) -> list[dict]:
    """Bill-wise outstanding per party. side: 'receivable' (they owe us) or 'payable' (we owe them).

    Receivable view: sales, debit notes, payments we made and purchase returns are bills; receipts, sales returns, credit notes
    and purchases settle them. The payable view is the mirror image. The opening balance is the oldest bill.
    """
    want = 1 if side == "receivable" else -1  # ledger sign of events that count as bills in this view
    parties = db.execute(select(Party).where(Party.userId == actor.account_id).order_by(Party.name)).scalars().all()
    events = _events(db, actor.account_id, as_on)
    today = date.fromisoformat(as_on)
    out = []
    for p in parties:
        bills: list[Bill] = []
        settles: list[Settlement] = []
        opening = r2(p.openingBalance) * want
        if opening > 0:
            bills.append(Bill("OPENING", OPENING_DATE, "Opening balance", opening, seq=-1))
        elif opening < 0:
            settles.append(Settlement(-opening))
        for i, e in enumerate(sorted(events.get(p.id, []), key=lambda e: (e["date"], e["at"]))):
            if ledger_sign(e["kind"]) == want:
                bills.append(Bill(f"{e['kind']}:{e['key']}:{i}", e["date"], e["ref"], e["amount"], seq=i))
                if e["kind"] in LEDGER_VOUCHER_KINDS:
                    bills[-1].key = e["key"]  # a payment taken with the bill points at the voucher id
            else:
                settles.append(Settlement(e["amount"], e["key"] if e["kind"] in ("PAYMENT_IN", "PAYMENT_OUT") else None))
        if not bills and not settles:
            continue
        ordered, unallocated = allocate(bills, settles)
        rows = []
        for b in ordered:
            if b.outstanding <= 0:
                continue
            age = None if b.key == "OPENING" else (today - date.fromisoformat(b.date)).days
            rows.append({"ref": b.ref, "date": b.date, "age": age, "amount": b.amount, "settled": b.settled, "outstanding": b.outstanding,
                         "opening": b.key == "OPENING"})
        total = r2(sum(r["outstanding"] for r in rows))
        if not rows:  # nothing due on this side (an advance alone is not an outstanding bill)
            continue
        out.append({"id": p.id, "name": p.name, "bills": rows, "total": total, "advance": unallocated})
    out.sort(key=lambda r: (-r["total"], r["name"].lower()))
    return out


BUCKETS = [("b0", "0-30 days", 0, 30), ("b1", "31-60 days", 31, 60), ("b2", "61-90 days", 61, 90), ("b3", "Over 90 days", 91, 10**9)]


def bucket_of_age(age: Optional[int]) -> str:
    if age is None:  # the undated opening balance is the oldest money: it sits in the last bucket
        return "b3"
    for key, _, lo, hi in BUCKETS:
        if lo <= age <= hi:
            return key
    return "b0"


def ageing(db: Session, actor: Actor, side: str, as_on: str) -> dict:
    rows = []
    totals = {k: 0.0 for k, *_ in BUCKETS}
    totals.update(total=0.0, advance=0.0)
    for p in outstanding(db, actor, side, as_on):
        r = {"id": p["id"], "name": p["name"], **{k: 0.0 for k, *_ in BUCKETS}, "total": p["total"], "advance": p["advance"]}
        for b in p["bills"]:
            k = bucket_of_age(b["age"])
            r[k] = r2(r[k] + b["outstanding"])
        if r["total"] <= 0:
            continue
        rows.append(r)
        for k in totals:
            totals[k] = r2(totals[k] + r[k])
    return {"rows": rows, "totals": totals, "buckets": [(k, label) for k, label, *_ in BUCKETS]}


def default_as_on() -> str:
    return date.today().isoformat()


def shift_days(iso_date: str, days: int) -> str:
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()

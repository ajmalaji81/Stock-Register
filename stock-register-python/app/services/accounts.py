"""Account groups and accounts (ledgers), journal entries, credit notes and debit notes.

Account GROUPS are containers arranged as a tree at most 3 levels deep (group > sub group > sub-sub group).
ACCOUNTS (ledgers, Account.isGroup = False) live under any group; only ledgers can be posted to.

Standalone ledger: sales, purchases and payments do NOT post here. Credit / debit notes do change the party's balance
(see services/parties.py). Every query is scoped by actor.account_id.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from ..core.errors import StockError
from ..core.gst import format_number
from ..core.jsmath import r2
from ..models import Account, AccountEntry, AccountVoucher, Party, PartyPayment
from .activity import log_activity
from .actor import Actor, assert_can
from .stock import fmt_num

MAX_GROUP_DEPTH = 3
MAX_DEPTH = MAX_GROUP_DEPTH  # kept for older callers
TYPES = ("ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE")
TYPE_LABEL = {"ASSET": "Assets", "LIABILITY": "Liabilities", "EQUITY": "Equity", "INCOME": "Income", "EXPENSE": "Expenses"}
GROUP_LEVEL = {1: "Group", 2: "Sub group", 3: "Sub-sub group"}
KINDS = {
    "JOURNAL": ("JV", "Journal"), "CREDIT_NOTE": ("CN", "Credit note"), "DEBIT_NOTE": ("DN", "Debit note"),
}
NOTE_KINDS = ("CREDIT_NOTE", "DEBIT_NOTE")
#: kinds whose list shows the posted lines instead of a party
LINE_KINDS = ("JOURNAL",)

#: (top level group, [ledgers]) created the first time the accounts are opened.
DEFAULT_CHART: list[tuple[str, str, list[str]]] = [
    ("Assets", "ASSET", ["Cash in hand", "Bank accounts", "Stock in hand"]),
    ("Liabilities", "LIABILITY", ["Duties & taxes", "Loans"]),
    ("Equity", "EQUITY", ["Capital", "Drawings"]),
    ("Income", "INCOME", ["Sales", "Other income"]),
    ("Expenses", "EXPENSE", ["Purchases", "Rent", "Salary", "Sales returns & discounts"]),
]


def _clean(name: str) -> str:
    n = " ".join((name or "").split())
    if not 1 <= len(n) <= 60:
        raise StockError("Name is required (up to 60 characters)")
    return n


def _money(v: Any, label: str = "Amount") -> float:
    try:
        n = r2(float(v or 0))
    except (TypeError, ValueError):
        raise StockError(f"{label} must be a number")
    if n < 0 or n > 1e10:
        raise StockError(f"{label} must be 0 or more")
    return n


def ensure_chart(db: Session, account_id: str) -> None:
    """Create the default groups and ledgers once per business (existing users start with none)."""
    if db.execute(select(func.count()).select_from(Account).where(Account.userId == account_id)).scalar_one():
        if db.execute(select(Account.id).where(Account.userId == account_id, Account.depth == 1, Account.isGroup.is_(False)).limit(1)).first():
            db.execute(update(Account).where(Account.userId == account_id, Account.depth == 1).values(isGroup=True))  # top level is always a group
            db.flush()
        return
    for top, typ, ledgers in DEFAULT_CHART:
        root = Account(userId=account_id, name=top, type=typ, depth=1, isGroup=True)
        db.add(root)
        db.flush()
        for s in ledgers:
            db.add(Account(userId=account_id, parentId=root.id, name=s, type=typ, depth=2, isGroup=False))
    db.flush()


def _get(db: Session, account_id: str, acc_id: Optional[str]) -> Account:
    a = db.execute(select(Account).where(Account.id == (acc_id or ""), Account.userId == account_id)).scalar_one_or_none()
    if a is None:
        raise StockError("Account not found", 404)
    return a


def _get_ledger(db: Session, account_id: str, acc_id: Optional[str]) -> Account:
    a = _get(db, account_id, acc_id)
    if a.isGroup:
        raise StockError(f"{a.name} is an account group. Choose an account (ledger) under it.")
    return a


def _movement(db: Session, account_id: str) -> dict[str, float]:
    """Net debit - credit per account from entries of vouchers that are not cancelled."""
    rows = db.execute(
        select(AccountEntry.accountId, func.sum(AccountEntry.debit - AccountEntry.credit))
        .join(AccountVoucher, AccountVoucher.id == AccountEntry.voucherId)
        .where(AccountVoucher.userId == account_id, AccountVoucher.status != "CANCELLED")
        .group_by(AccountEntry.accountId)
    ).all()
    return {a: float(v or 0) for a, v in rows}


def chart(db: Session, actor: Actor) -> list[dict]:
    """The whole tree (groups and ledgers), each node with its own balance and the total of everything under it."""
    ensure_chart(db, actor.account_id)
    accs = db.execute(select(Account).where(Account.userId == actor.account_id).order_by(Account.createdAt, Account.id)).scalars().all()
    move = _movement(db, actor.account_id)
    kids: dict[Optional[str], list[Account]] = {}
    for a in accs:
        kids.setdefault(a.parentId, []).append(a)
    used = {x for (x,) in db.execute(
        select(AccountEntry.accountId).join(AccountVoucher, AccountVoucher.id == AccountEntry.voucherId).where(AccountVoucher.userId == actor.account_id).distinct()
    ).all()} | {
        x for (x,) in db.execute(select(AccountVoucher.accountId).where(AccountVoucher.userId == actor.account_id, AccountVoucher.accountId.is_not(None)).distinct()).all()
    }

    def node(a: Account) -> dict:
        children = [node(c) for c in kids.get(a.id, [])]
        own = r2(a.openingBalance + move.get(a.id, 0))
        return {
            "id": a.id, "name": a.name, "type": a.type, "depth": a.depth, "parentId": a.parentId, "isGroup": bool(a.isGroup),
            "level": GROUP_LEVEL.get(a.depth, "Group") if a.isGroup else "Account",
            "opening": a.openingBalance, "own": own, "total": r2(own + sum(c["total"] for c in children)),
            "children": children,
            "canAddGroup": bool(a.isGroup) and a.depth < MAX_GROUP_DEPTH,  # a ledger group can't go deeper than 3 levels
            "canAddLedger": bool(a.isGroup),
            "canDelete": a.depth > 1 and not children and a.id not in used,
            "canEdit": a.depth > 1,
        }

    return [node(r) for r in kids.get(None, [])]


def _walk(nodes: list[dict], path: str, out: list[dict], want: str) -> None:
    for n in nodes:
        p = f"{path} › {n['name']}" if path else n["name"]
        if (want == "ledger" and not n["isGroup"]) or (want == "group" and n["isGroup"]) or want == "all":
            out.append({"id": n["id"], "path": p, "depth": n["depth"], "type": n["type"], "name": n["name"], "isGroup": n["isGroup"],
                        "canAddGroup": n["canAddGroup"]})
        _walk(n["children"], p, out, want)


def flat_chart(tree: list[dict]) -> list[dict]:
    """Ledgers only, with their group path: what journal and note dropdowns offer."""
    out: list[dict] = []
    _walk(tree, "", out, "ledger")
    return out


def flat_groups(tree: list[dict]) -> list[dict]:
    """Groups only (for the 'under which group' pickers)."""
    out: list[dict] = []
    _walk(tree, "", out, "group")
    return out


def flat_all(tree: list[dict]) -> list[dict]:
    out: list[dict] = []
    _walk(tree, "", out, "all")
    return out


def ledger_rows(tree: list[dict]) -> list[dict]:
    """Flat table of ledgers for the Accounts master."""
    by_id = {n["id"]: n for n in flat_all(tree)}
    out = []

    def walk(nodes: list[dict]) -> None:
        for n in nodes:
            if not n["isGroup"]:
                out.append({**n, "path": by_id[n["id"]]["path"], "group": by_id[n["id"]]["path"].rsplit(" › ", 1)[0] if " › " in by_id[n["id"]]["path"] else ""})
            walk(n["children"])

    walk(tree)
    return out


# ---------------- vouchers ----------------


def _next_number(db: Session, account_id: str, kind: str) -> str:
    prefix = KINDS[kind][0]
    nums = db.execute(select(AccountVoucher.number).where(AccountVoucher.userId == account_id, AccountVoucher.kind == kind)).scalars().all()
    top = 0
    for n in nums:
        try:
            top = max(top, int(n.rsplit("-", 1)[-1]))
        except ValueError:
            continue
    return format_number(prefix, top + 1)


def _check_date(date: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or ""):
        raise StockError("Date must be YYYY-MM-DD")
    return date


def create_journal(db: Session, actor: Actor, date: str, narration: str, lines: list[dict]) -> dict:
    """lines: [{accountId, debit, credit, narration}]. Needs 2+ lines, one side each, and debit total == credit total."""
    assert_can(actor, "payments.manage")
    ensure_chart(db, actor.account_id)
    date = _check_date(date)
    clean = []
    for ln in lines:
        acc_id = (ln.get("accountId") or "").strip()
        dr, cr = _money(ln.get("debit"), "Debit"), _money(ln.get("credit"), "Credit")
        if not acc_id and dr == 0 and cr == 0:
            continue  # an untouched blank row
        if not acc_id:
            raise StockError("Choose an account on every line")
        if (dr > 0) == (cr > 0):
            raise StockError("Each line needs either a debit or a credit amount, not both or neither")
        _get_ledger(db, actor.account_id, acc_id)
        clean.append((acc_id, dr, cr, (ln.get("narration") or "").strip()[:200]))
    if len(clean) < 2:
        raise StockError("A journal needs at least two lines")
    total_dr, total_cr = r2(sum(c[1] for c in clean)), r2(sum(c[2] for c in clean))
    if total_dr != total_cr:
        raise StockError(f"Debit ₹{fmt_num(total_dr)} and credit ₹{fmt_num(total_cr)} must be equal")
    v = AccountVoucher(userId=actor.account_id, kind="JOURNAL", number=_next_number(db, actor.account_id, "JOURNAL"), date=date,
                       amount=total_dr, narration=(narration or "").strip()[:300], createdBy=actor.name)
    v.entries = [AccountEntry(accountId=a, debit=d, credit=c, narration=n) for a, d, c, n in clean]
    db.add(v)
    db.flush()
    log_activity(db, actor, "journal.create", f"{v.number}: ₹{fmt_num(total_dr)}")
    return {"id": v.id, "number": v.number}


def create_note(db: Session, actor: Actor, kind: str, date: str, party_id: str, account_id: str, amount: Any, narration: str) -> dict:
    """Credit note: the party owes us less (we owe them more). Debit note: the opposite. Amount only, no stock, no GST."""
    if kind not in NOTE_KINDS:
        raise StockError("Unknown note type")
    assert_can(actor, "payments.manage")
    ensure_chart(db, actor.account_id)
    date = _check_date(date)
    party = db.execute(select(Party).where(Party.id == (party_id or ""), Party.userId == actor.account_id)).scalar_one_or_none()
    if party is None:
        raise StockError("Choose a customer or supplier")
    acc = _get_ledger(db, actor.account_id, account_id) if account_id else None
    if acc is None:
        raise StockError("Choose the account for the other side of the note")
    amt = _money(amount)
    if amt <= 0:
        raise StockError("Amount must be more than 0")
    v = AccountVoucher(userId=actor.account_id, kind=kind, number=_next_number(db, actor.account_id, kind), date=date, partyId=party.id,
                       accountId=acc.id, amount=amt, narration=(narration or "").strip()[:300], createdBy=actor.name)
    # the account's side: a credit note is debited there (e.g. sales returns), a debit note is credited
    v.entries = [AccountEntry(accountId=acc.id, debit=amt if kind == "CREDIT_NOTE" else 0, credit=amt if kind == "DEBIT_NOTE" else 0)]
    db.add(v)
    db.flush()
    log_activity(db, actor, f"{kind.lower()}.create", f"{v.number}: {party.name} ₹{fmt_num(amt)}")
    return {"id": v.id, "number": v.number}


def cancel_voucher(db: Session, actor: Actor, voucher_id: str) -> None:
    assert_can(actor, "payments.manage")
    v = db.execute(select(AccountVoucher).where(AccountVoucher.id == voucher_id, AccountVoucher.userId == actor.account_id)).scalar_one_or_none()
    if v is None:
        raise StockError("Entry not found", 404)
    if v.status == "CANCELLED":
        raise StockError("This is already cancelled", 409)
    v.status = "CANCELLED"
    db.flush()
    log_activity(db, actor, f"{v.kind.lower()}.cancel", v.number)


def list_vouchers(db: Session, actor: Actor, kind: str, frm: str = "", to: str = "") -> list[dict]:
    if kind not in KINDS:
        raise StockError("Unknown entry type")
    assert_can(actor, "payments.manage")
    stmt = select(AccountVoucher).options(selectinload(AccountVoucher.entries), selectinload(AccountVoucher.party)).where(
        AccountVoucher.userId == actor.account_id, AccountVoucher.kind == kind)
    if frm:
        stmt = stmt.where(AccountVoucher.date >= frm)
    if to:
        stmt = stmt.where(AccountVoucher.date <= to)
    rows = db.execute(stmt.order_by(AccountVoucher.date.desc(), AccountVoucher.createdAt.desc())).scalars().all()
    names = {a.id: a.name for a in db.execute(select(Account).where(Account.userId == actor.account_id)).scalars()}
    return [
        {"id": v.id, "number": v.number, "date": v.date, "party": v.party.name if v.party else "", "amount": v.amount,
         "account": names.get(v.accountId or "", ""), "narration": v.narration, "status": v.status, "by": v.createdBy,
         "lines": [{"account": names.get(e.accountId, "?"), "debit": e.debit, "credit": e.credit, "narration": e.narration} for e in v.entries]}
        for v in rows
    ]


# ---------------- receipts and payments (lists over PartyPayment) ----------------


def list_money(db: Session, actor: Actor, direction: str, frm: str = "", to: str = "") -> list[dict]:
    """Receipts (IN) or payments (OUT) recorded against parties, newest first, with whether each has been reversed."""
    assert_can(actor, "payments.manage")
    stmt = select(PartyPayment).options(selectinload(PartyPayment.party)).where(
        PartyPayment.userId == actor.account_id, PartyPayment.direction == ("OUT" if direction == "OUT" else "IN"))
    if frm:
        stmt = stmt.where(PartyPayment.date >= frm)
    if to:
        stmt = stmt.where(PartyPayment.date <= to)
    rows = db.execute(stmt.order_by(PartyPayment.date.desc(), PartyPayment.createdAt.desc()).limit(1000)).scalars().all()
    reversed_ids = set()
    for (n,) in db.execute(select(PartyPayment.notes).where(PartyPayment.userId == actor.account_id, PartyPayment.notes.startswith("Reversal of ", autoescape=True))).all():
        m = re.match(r"Reversal of (\S+)", n or "")
        if m:
            reversed_ids.add(m.group(1))
    return [
        {"id": r.id, "partyId": r.partyId, "party": r.party.name if r.party else "", "date": r.date, "mode": r.mode, "reference": r.reference,
         "amount": r.amount, "notes": r.notes, "by": r.createdBy, "isReversal": (r.notes or "").startswith("Reversal of "),
         "reversed": r.id in reversed_ids}
        for r in rows
    ]

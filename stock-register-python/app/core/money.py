"""Pure money helpers for parties, payments, expenses and the cash book (port of lib/money.ts)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import quote

from .jsmath import r2 as round2

PAYMENT_MODES = ["CASH", "BANK", "UPI", "CHEQUE", "CARD", "FINANCE"]

#: Finance companies offered when a sale is (part-)paid through finance; "Other" lets the user type one.
FINANCE_COMPANIES = ["Bajaj Finance", "HDFC Bank", "TVS Credit", "IDFC First Bank", "ICICI Bank", "Hero FinCorp", "Home Credit", "Kotak Mahindra", "Axis Bank"]
EXPENSE_CATEGORIES = ["Rent", "Salary", "Transport", "Electricity", "Repairs", "Packaging", "Other"]

#: Voucher kinds that change a party's balance, and the sign (+ = party owes us more).
BALANCE_SIGN = {"SALE": 1, "SALE_RETURN": -1, "PURCHASE": -1, "PURCHASE_RETURN": 1}


def is_balance_kind(kind: str) -> bool:
    return kind in BALANCE_SIGN


def payment_sign(direction: str) -> int:
    """Receiving money reduces what they owe us."""
    return -1 if direction == "IN" else 1


@dataclass
class BalanceParts:
    opening_balance: float = 0
    sale: float = 0
    sale_return: float = 0
    purchase: float = 0
    purchase_return: float = 0
    paid_in: float = 0
    paid_out: float = 0
    credit_note: float = 0  # we reduced what they owe us (or increased what we owe them)
    debit_note: float = 0  # the opposite


def party_balance(p: BalanceParts) -> float:
    """Positive = receivable (they owe us), negative = payable (we owe them)."""
    return round2(p.opening_balance + p.sale - p.sale_return - p.purchase + p.purchase_return - p.paid_in + p.paid_out - p.credit_note + p.debit_note)


@dataclass
class LedgerSource:
    date: str
    created_at: str
    kind: str  # OPENING | SALE | ... | PAYMENT_IN | PAYMENT_OUT
    ref: str
    amount: float  # always positive
    notes: str
    id: str


@dataclass
class PartyLedgerRow:
    id: str
    date: str
    created_at: str
    kind: str
    ref: str
    amount: float
    notes: str
    debit: float  # increases what they owe us
    credit: float  # decreases what they owe us
    balance: float


def ledger_sign(kind: str) -> int:
    if kind == "OPENING":
        return 1
    if kind == "PAYMENT_IN":
        return -1
    if kind == "PAYMENT_OUT":
        return 1
    if kind == "CREDIT_NOTE":
        return -1
    if kind == "DEBIT_NOTE":
        return 1
    return BALANCE_SIGN[kind]


def build_party_ledger(
    opening_balance: float, entries: list[LedgerSource], from_: Optional[str] = None, to: Optional[str] = None
) -> list[PartyLedgerRow]:
    """Chronological running balance. Rows before `from_` fold into a "Balance b/f" row."""
    ordered = sorted(entries, key=lambda e: (e.date, e.created_at, e.id))
    bal = round2(opening_balance)
    rows: list[PartyLedgerRow] = []
    carried = False

    def push_opening(date: str, label: str) -> None:
        rows.append(
            PartyLedgerRow("opening", date, "", "OPENING", label, abs(bal), "", bal if bal > 0 else 0, -bal if bal < 0 else 0, bal)
        )

    if not from_ and bal != 0:
        push_opening(ordered[0].date if ordered else "", "Opening balance")
    for e in ordered:
        if to and e.date > to:
            break
        signed = ledger_sign(e.kind) * abs(e.amount)
        if from_ and e.date < from_:
            bal = round2(bal + signed)
            continue
        if from_ and not carried:
            carried = True
            if bal != 0:
                push_opening(from_, "Balance b/f")
        bal = round2(bal + signed)
        rows.append(
            PartyLedgerRow(
                e.id, e.date, e.created_at, e.kind, e.ref, abs(e.amount), e.notes,
                abs(e.amount) if signed > 0 else 0, abs(e.amount) if signed < 0 else 0, bal,
            )
        )
    if from_ and not carried and bal != 0:
        push_opening(from_, "Balance b/f")
    return rows


def wa_phone(phone: str) -> Optional[str]:
    """wa.me phone: digits only, Indian 10-digit numbers get 91 prefixed. None if unusable."""
    d = re.sub(r"\D", "", phone)
    if len(d) == 11 and d.startswith("0"):
        d = d[1:]
    if len(d) == 10:
        d = "91" + d
    return d if 11 <= len(d) <= 15 else None


def format_inr(amount: float) -> str:
    """en-IN currency with up to 2 decimals, e.g. ₹1,50,000.5"""
    neg = amount < 0
    s = f"{abs(amount):.2f}".rstrip("0").rstrip(".")
    whole, _, frac = s.partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return f"{'-' if neg else ''}₹{whole}{'.' + frac if frac else ''}"


def reminder_message(party_name: str, due: float, business: str) -> str:
    return (
        f"Namaste {party_name}, this is a gentle reminder from {business} that {format_inr(due)} is pending "
        "on your account. Kindly arrange the payment at your earliest convenience. Thank you!"
    )


def whatsapp_link(phone: str, text: str) -> Optional[str]:
    p = wa_phone(phone)
    return f"https://wa.me/{p}?text={quote(text, safe='')}" if p else None


def bucket_of(mode: str) -> str:
    """Cash vs bank bucket for a payment / expense mode."""
    return "cash" if mode == "CASH" else "bank"


@dataclass
class CashFlow:
    date: str
    mode: str
    amount: float  # + money in, - money out


@dataclass
class CashDay:
    date: str
    cash_in: float = 0
    cash_out: float = 0
    bank_in: float = 0
    bank_out: float = 0


@dataclass
class CashSummary:
    opening_cash: float
    opening_bank: float
    closing_cash: float
    closing_bank: float
    days: list[CashDay] = field(default_factory=list)


def summarize_cash(flows: list[CashFlow], from_: Optional[str] = None, to: Optional[str] = None) -> CashSummary:
    """Cash book over [from_, to]; flows before `from_` form the opening balances."""
    opening_cash = opening_bank = 0.0
    by_day: dict[str, CashDay] = {}
    for f in flows:
        if to and f.date > to:
            continue
        b = bucket_of(f.mode)
        if from_ and f.date < from_:
            if b == "cash":
                opening_cash += f.amount
            else:
                opening_bank += f.amount
            continue
        d = by_day.setdefault(f.date, CashDay(f.date))
        if b == "cash":
            if f.amount >= 0:
                d.cash_in += f.amount
            else:
                d.cash_out -= f.amount
        elif f.amount >= 0:
            d.bank_in += f.amount
        else:
            d.bank_out -= f.amount
    days = [
        CashDay(d.date, round2(d.cash_in), round2(d.cash_out), round2(d.bank_in), round2(d.bank_out))
        for d in sorted(by_day.values(), key=lambda x: x.date)
    ]
    closing_cash = round2(opening_cash + sum(d.cash_in - d.cash_out for d in days))
    closing_bank = round2(opening_bank + sum(d.bank_in - d.bank_out for d in days))
    return CashSummary(round2(opening_cash), round2(opening_bank), closing_cash, closing_bank, days)

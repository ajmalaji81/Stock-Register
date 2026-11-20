"""Pure GST maths for bills (port of lib/gst.ts)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .jsmath import js_round, r2

INDIAN_STATES: list[str] = [
    "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
    "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
    "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
    "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
    "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
    "West Bengal",
]

GST_RATES = [0, 0.25, 3, 5, 12, 18, 28]


@dataclass
class LineInput:
    qty: float
    rate: float  # price per unit before tax
    discount_pct: float = 0
    tax_rate: float = 0


@dataclass
class LineResult:
    taxable: float
    tax: float
    amount: float


def godown_identity(godown, owner) -> dict:
    """State / GSTIN / address a godown bills under. A godown with its own state or GSTIN uses those; otherwise the business profile."""
    if godown is not None and (godown.state or godown.gstin):
        return {"state": godown.state or owner.state, "gstin": godown.gstin, "address": godown.address or owner.address, "own": True}
    return {"state": owner.state, "gstin": owner.gstin, "address": owner.address, "own": False}


def calc_line(l: LineInput, gst_enabled: bool = True) -> LineResult:
    gross = l.qty * l.rate
    disc = min(100, max(0, l.discount_pct or 0))
    taxable = r2(gross * (1 - disc / 100))
    tax = r2((taxable * max(0, l.tax_rate or 0)) / 100) if gst_enabled else 0
    return LineResult(taxable=taxable, tax=tax, amount=r2(taxable + tax))


def _norm(s: Optional[str]) -> str:
    return (s or "").strip().lower()


def is_inter_state(business_state: Optional[str], place_of_supply: Optional[str]) -> bool:
    """Inter-state supply (IGST) when both states are known and differ."""
    a, b = _norm(business_state), _norm(place_of_supply)
    return a != "" and b != "" and a != b


@dataclass
class Totals:
    subtotal: float  # sum of taxable values
    discount: float  # total discount given on lines
    cgst: float
    sgst: float
    igst: float
    round_off: float
    total: float
    lines: list[LineResult] = field(default_factory=list)


def calc_totals(lines: list[LineInput], gst_enabled: bool, inter_state: bool, round_off: bool = True) -> Totals:
    results = [calc_line(l, gst_enabled) for l in lines]
    subtotal = r2(sum(r.taxable for r in results))
    gross = r2(sum(l.qty * l.rate for l in lines))
    tax = r2(sum(r.tax for r in results))
    cgst = sgst = igst = 0.0
    if inter_state:
        igst = tax
    else:
        cgst = r2(tax / 2)
        sgst = r2(tax - cgst)
    exact = r2(subtotal + tax)
    total = js_round(exact) if round_off else exact
    return Totals(subtotal, r2(gross - subtotal), cgst, sgst, igst, r2(total - exact), total, results)


# ---------- Amount in words (Indian numbering) ----------

_ONES = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
    "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two_digits(n: int) -> str:
    if n < 20:
        return _ONES[n]
    return f"{_TENS[n // 10]}{' ' + _ONES[n % 10] if n % 10 else ''}"


def _three_digits(n: int) -> str:
    h, rest = n // 100, n % 100
    return " ".join(p for p in (f"{_ONES[h]} Hundred" if h else "", _two_digits(rest) if rest else "") if p)


def _integer_words(n: int) -> str:
    if n == 0:
        return "Zero"
    parts: list[str] = []
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1000)
    if crore:
        parts.append(f"{_integer_words(crore)} Crore")
    if lakh:
        parts.append(f"{_two_digits(lakh)} Lakh")
    if thousand:
        parts.append(f"{_two_digits(thousand)} Thousand")
    if n:
        parts.append(_three_digits(n))
    return " ".join(parts)


def amount_in_words(amount: float) -> str:
    """e.g. 1234.5 -> "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only"."""
    neg = amount < 0
    abs_amt = abs(r2(amount))
    rupees = int(abs_amt // 1)
    paise = int(js_round((abs_amt - rupees) * 100))
    words = f"Rupees {_integer_words(rupees)}{f' and {_two_digits(paise)} Paise' if paise else ''} Only"
    return f"Minus {words}" if neg else words


# ---------- Voucher kinds ----------

VOUCHER_KINDS = ["SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN", "QUOTATION", "SALES_ORDER", "PURCHASE_ORDER", "CHALLAN"]

KIND_LABEL = {
    "SALE": "Sales invoice",
    "SALE_RETURN": "Sales return",
    "PURCHASE": "Purchase bill",
    "PURCHASE_RETURN": "Purchase return",
    "QUOTATION": "Quotation",
    "SALES_ORDER": "Sales order",
    "PURCHASE_ORDER": "Purchase order",
    "CHALLAN": "Delivery challan",
}

#: Number prefix per kind. SALE uses the business's invoicePrefix instead.
KIND_PREFIX = {
    "SALE": "INV", "SALE_RETURN": "SR", "PURCHASE": "PB", "PURCHASE_RETURN": "PR",
    "QUOTATION": "QT", "SALES_ORDER": "SO", "PURCHASE_ORDER": "PO", "CHALLAN": "DC",
}


def stock_effect(kind: str) -> Optional[str]:
    """Stock effect of a kind: OUT, IN or none."""
    if kind in ("SALE", "PURCHASE_RETURN", "CHALLAN"):
        return "OUT"
    if kind in ("PURCHASE", "SALE_RETURN"):
        return "IN"
    return None


#: Which kinds each kind may be converted into.
CONVERSIONS: dict[str, list[str]] = {
    "QUOTATION": ["SALES_ORDER", "SALE"],
    "SALES_ORDER": ["SALE"],
    "PURCHASE_ORDER": ["PURCHASE"],
    "CHALLAN": ["SALE"],
}


def is_purchase_side(kind: str) -> bool:
    """Purchase-side kinds use the supplier view (cost rates)."""
    return kind in ("PURCHASE", "PURCHASE_RETURN", "PURCHASE_ORDER")


def format_number(prefix: str, seq: int) -> str:
    return f"{prefix}-{str(seq).zfill(4)}"

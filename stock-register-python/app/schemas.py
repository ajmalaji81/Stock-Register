"""Request validation (pydantic equivalents of the zod schemas in lib/*schemas.ts).

Error messages match the TypeScript app, so the API answers with the same `{"error": ...}` text.
"""
from __future__ import annotations

import re
from typing import Annotated, Any, Literal, Optional

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, ValidationError, model_validator

from .core.gst import INDIAN_STATES, VOUCHER_KINDS

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def first_message(err: ValidationError | Any) -> str:
    """First issue's message, the way the TS API reports ZodError."""
    errors = err.errors() if hasattr(err, "errors") else []
    if not errors:
        return "Invalid input"
    e = errors[0]
    if e.get("type") == "json_invalid":
        return "Invalid JSON body"
    msg = str(e.get("msg", "Invalid input"))
    return msg.removeprefix("Value error, ")


def _strip(v: Any) -> Any:
    return v.strip() if isinstance(v, str) else v


def _check(pred, message: str):
    def fn(v):
        if not pred(v):
            raise ValueError(message)
        return v

    return AfterValidator(fn)


def Text(max_len: int) -> Any:  # noqa: N802 - mirrors the zod helper name
    return Annotated[str, BeforeValidator(_strip), _check(lambda v: len(v) <= max_len, f"Must be at most {max_len} characters")]


Date = Annotated[str, _check(lambda v: bool(DATE_RE.match(v)), "Date must be YYYY-MM-DD")]
Money = Annotated[float, _check(lambda v: 0 <= v <= 1e10, "Must be 0 or more")]
Qty = Annotated[float, _check(lambda v: 0 < v <= 1e9, "Quantity must be more than 0")]


def _lower_email(v: Any) -> Any:
    return v.strip().lower() if isinstance(v, str) else v


Email = Annotated[str, BeforeValidator(_lower_email), _check(lambda v: bool(EMAIL_RE.match(v)), "Enter a valid email")]
Password8 = Annotated[str, _check(lambda v: 8 <= len(v) <= 200, "Password must be at least 8 characters")]


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


def _serial_list(v: Any) -> Any:
    """IMEIs may arrive as a list or as pasted text (separated by lines, spaces, commas or semicolons)."""
    if isinstance(v, str):
        return [t for t in re.split(r"[\s,;]+", v.upper()) if t]
    if isinstance(v, list):
        return [str(t).strip().upper() for t in v if str(t).strip()]
    return v


# ---------------- stock ----------------


class ItemInput(Model):
    name: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 120, "Item name is required")]
    sku: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 60, "SKU / barcode is required")]
    category: Text(60) = ""
    unit: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 20, "Unit is required")]
    purchasePrice: Money
    salePrice: Money
    minStockAlert: Annotated[float, _check(lambda v: 0 <= v <= 1e9, "Must be 0 or more")]
    hsn: Text(20) = ""
    gstRate: Annotated[float, _check(lambda v: 0 <= v <= 100, "Must be between 0 and 100")] = 0
    openingQty: Optional[Annotated[float, _check(lambda v: 0 <= v <= 1e9, "Must be 0 or more")]] = None
    openingGodownId: Optional[str] = None
    trackSerial: bool = False


class MovementInput(Model):
    itemId: Annotated[str, _check(lambda v: len(v) > 0, "Choose an item")]
    godownId: Annotated[str, _check(lambda v: len(v) > 0, "Choose a godown")]
    type: Literal["IN", "OUT"]
    qty: Qty
    rate: Money
    party: Text(120) = ""
    remarks: Text(300) = ""
    date: Date


class TransferInput(Model):
    itemId: Annotated[str, _check(lambda v: len(v) > 0, "Choose an item")]
    fromGodownId: Annotated[str, _check(lambda v: len(v) > 0, "Choose a godown")]
    toGodownId: Annotated[str, _check(lambda v: len(v) > 0, "Choose a godown")]
    qty: Qty
    date: Date
    remarks: Text(300) = ""
    serials: Annotated[list[str], BeforeValidator(lambda v: _serial_list(v))] = []


class GodownInput(Model):
    name: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 60, "Godown name is required")]


class SignupInput(Model):
    name: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 80, "Name is required")]
    email: Email
    password: Password8


class LoginInput(Model):
    email: Email
    password: Annotated[str, _check(lambda v: len(v) >= 1, "Password is required")]


class LedgerQuery(Model):
    itemId: Optional[str] = None
    godownId: Optional[str] = None
    type: Optional[Literal["OPENING", "IN", "OUT", "TRANSFER_IN", "TRANSFER_OUT", "ADJUSTMENT"]] = None
    from_: Optional[Date] = Field(default=None, alias="from")
    to: Optional[Date] = None


class ImportItemRow(Model):
    name: str
    sku: str
    category: str = ""
    unit: str = "pcs"
    purchasePrice: float = 0
    salePrice: float = 0
    minStockAlert: float = 0
    hsn: str = ""
    gstRate: float = 0
    openingQty: float = 0
    openingGodown: str = ""
    line: Optional[int] = None


class ItemImportBody(Model):
    rows: Annotated[list[ImportItemRow], _check(lambda v: len(v) >= 1, "Nothing to import"), _check(lambda v: len(v) <= 2000, "Import at most 2000 rows at a time")]


class ProfileBody(Model):
    avatar: Optional[str]


# ---------------- billing ----------------

VoucherKind = Annotated[str, _check(lambda v: v in VOUCHER_KINDS, "Invalid input")]
PayMode = Literal["CASH", "BANK", "UPI", "CHEQUE", "CARD", "FINANCE"]


class VoucherLineInput(Model):
    itemId: Annotated[str, _check(lambda v: len(v) > 0, "Choose an item")]
    description: Text(200) = ""
    qty: Qty
    rate: Annotated[float, _check(lambda v: 0 <= v <= 1e10, "Rate must be 0 or more")]
    discountPct: Annotated[float, _check(lambda v: 0 <= v <= 100, "Must be between 0 and 100")] = 0
    taxRate: Annotated[float, _check(lambda v: 0 <= v <= 100, "Must be between 0 and 100")] = 0
    serials: Annotated[list[str], BeforeValidator(_serial_list), _check(lambda v: len(v) <= 500, "Too many IMEIs on one line")] = []


class PaymentSplitInput(Model):
    """One mode of a (possibly split) payment taken with a bill. FINANCE rows carry the finance company."""

    mode: PayMode
    amount: Annotated[float, _check(lambda v: 0 <= v <= 1e10, "Must be 0 or more")] = 0
    finance: Text(60) = ""


class VoucherCreateInput(Model):
    kind: VoucherKind
    date: Date
    partyId: Optional[str] = None
    godownId: Annotated[str, _check(lambda v: len(v) > 0, "Choose a godown")]
    gstEnabled: bool = True
    placeOfSupply: Text(60) = ""
    notes: Text(500) = ""
    lines: Annotated[list[VoucherLineInput], _check(lambda v: len(v) >= 1, "Add at least one item"), _check(lambda v: len(v) <= 200, "Too many lines")]
    paidNow: Annotated[float, _check(lambda v: 0 <= v <= 1e10, "Must be 0 or more")] = 0
    paymentMode: PayMode = "CASH"
    paymentSplit: Annotated[list[PaymentSplitInput], _check(lambda v: len(v) <= 10, "Too many payment modes")] = []
    paymentInfo: Text(300) = ""
    schemeInfo: Text(300) = ""


class VoucherConvertInput(Model):
    to: VoucherKind
    date: Optional[Date] = None


class VoucherListQuery(Model):
    kind: Optional[str] = None  # one kind or comma-separated kinds
    partyId: Optional[str] = None
    status: Optional[Literal["OPEN", "CONVERTED", "CLOSED", "CANCELLED"]] = None
    from_: Optional[Date] = Field(default=None, alias="from")
    to: Optional[Date] = None
    q: Optional[Annotated[str, BeforeValidator(_strip), _check(lambda v: len(v) <= 100, "Too long")]] = None


def _gstin(v: Any) -> Any:
    return v.strip().upper() if isinstance(v, str) else v


class SettingsInput(Model):
    businessName: Text(120) = ""
    gstin: Annotated[
        str,
        BeforeValidator(_gstin),
        _check(lambda v: len(v) <= 15, "GSTIN must be 15 characters, e.g. 33ABCDE1234F1Z5"),
        _check(lambda v: v == "" or bool(re.match(r"^[0-9]{2}[A-Z0-9]{13}$", v)), "GSTIN must be 15 characters, e.g. 33ABCDE1234F1Z5"),
    ] = ""
    address: Text(300) = ""
    state: Annotated[str, BeforeValidator(_strip), _check(lambda v: v == "" or v in INDIAN_STATES, "Choose a state from the list")] = ""
    phone: Text(30) = ""
    invoicePrefix: Annotated[
        str, BeforeValidator(_strip),
        _check(lambda v: len(v) <= 10, "Must be at most 10 characters"),
        _check(lambda v: bool(re.match(r"^[A-Za-z0-9/]*$", v)), "Prefix can only have letters, numbers and /"),
    ] = "INV"
    invoiceTerms: Text(1000) = ""
    bankDetails: Text(500) = ""


class SalesReportQuery(Model):
    from_: Optional[Date] = Field(default=None, alias="from")
    to: Optional[Date] = None
    side: Literal["sales", "purchases"] = "sales"


# ---------------- parties / money ----------------

PartyType = Literal["CUSTOMER", "SUPPLIER", "BOTH"]
Amount = Annotated[float, _check(lambda v: 0 < v <= 1e11, "Amount must be more than 0")]


def _party_email(v: Any) -> Any:
    return v.strip().lower() if isinstance(v, str) else v


class PartyInput(Model):
    name: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 120, "Party name is required")]
    type: PartyType = "CUSTOMER"
    phone: Text(20) = ""
    email: Annotated[str, BeforeValidator(_party_email), _check(lambda v: v == "" or bool(EMAIL_RE.match(v)), "Enter a valid email")] = ""
    gstin: Annotated[
        str, BeforeValidator(_gstin),
        _check(lambda v: len(v) <= 15, "GSTIN must be 15 letters/digits"),
        _check(lambda v: v == "" or bool(re.match(r"^[0-9A-Z]{15}$", v)), "GSTIN must be 15 letters/digits"),
    ] = ""
    state: Text(60) = ""
    address: Text(300) = ""
    openingBalance: Annotated[float, _check(lambda v: -1e11 <= v <= 1e11, "Opening balance out of range")] = 0


class PartyImportBody(Model):
    rows: Annotated[list[dict[str, Any]], _check(lambda v: len(v) >= 1, "No rows to import"), _check(lambda v: len(v) <= 2000, "Import at most 2000 parties at a time")]


class PartyQuery(Model):
    q: Optional[Annotated[str, BeforeValidator(_strip), _check(lambda v: len(v) <= 100, "Too long")]] = None
    type: Optional[Literal["CUSTOMER", "SUPPLIER", "BOTH", "ALL"]] = None
    sort: Optional[Literal["name", "balance_desc", "balance_asc"]] = None


class DateRange(Model):
    from_: Optional[Date] = Field(default=None, alias="from")
    to: Optional[Date] = None


class PaymentInput(Model):
    partyId: Annotated[str, _check(lambda v: len(v) > 0, "Choose a party")]
    direction: Literal["IN", "OUT"]
    amount: Amount
    mode: PayMode = "CASH"
    date: Date
    reference: Text(80) = ""
    notes: Text(300) = ""
    voucherId: Optional[str] = None


class PaymentQuery(Model):
    partyId: Optional[str] = None
    direction: Optional[Literal["IN", "OUT"]] = None
    mode: Optional[PayMode] = None
    from_: Optional[Date] = Field(default=None, alias="from")
    to: Optional[Date] = None


class ExpenseInput(Model):
    category: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 60, "Category is required")]
    amount: Amount
    mode: PayMode = "CASH"
    date: Date
    notes: Text(300) = ""


class ExpenseQuery(Model):
    category: Optional[Text(60)] = None
    from_: Optional[Date] = Field(default=None, alias="from")
    to: Optional[Date] = None


# ---------------- staff ----------------

StaffRoleName = Literal["STORE_ADMIN", "SALES_PURCHASE", "SALES"]


class StaffCreateInput(Model):
    name: Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 80, "Name is required")]
    email: Email
    password: Password8
    role: StaffRoleName
    godownIds: Annotated[list[str], _check(lambda v: len(v) <= 200, "Too many godowns")] = []

    @model_validator(mode="before")
    @classmethod
    def _role_message(cls, data: Any) -> Any:
        if isinstance(data, dict) and data.get("role") not in ("STORE_ADMIN", "SALES_PURCHASE", "SALES"):
            raise ValueError("Choose a role")
        return data


class StaffUpdateInput(Model):
    name: Optional[Annotated[str, BeforeValidator(_strip), _check(lambda v: 1 <= len(v) <= 80, "Name is required")]] = None
    role: Optional[StaffRoleName] = None
    godownIds: Optional[Annotated[list[str], _check(lambda v: len(v) <= 200, "Too many godowns")]] = None
    active: Optional[bool] = None
    password: Optional[Password8] = None


class AdjustmentInput(Model):
    itemId: Annotated[str, _check(lambda v: len(v) > 0, "Choose an item")]
    godownId: Annotated[str, _check(lambda v: len(v) > 0, "Choose a godown")]
    newQty: Optional[Annotated[float, _check(lambda v: 0 <= v <= 1e9, "Count can't be negative")]] = None
    delta: Optional[Annotated[float, _check(lambda v: -1e9 <= v <= 1e9, "Change out of range")]] = None
    reason: Annotated[str, BeforeValidator(_strip), _check(lambda v: 2 <= len(v) <= 300, "Reason is required")]
    date: Date

    @model_validator(mode="after")
    def _one_of(self) -> "AdjustmentInput":
        if (self.newQty is None) == (self.delta is None):
            raise ValueError("Give either the new count or the change, not both")
        return self


class ActivityQuery(Model):
    actorId: Optional[str] = None
    action: Optional[Annotated[str, _check(lambda v: len(v) <= 60, "Too long")]] = None
    from_: Optional[Date] = Field(default=None, alias="from")
    to: Optional[Date] = None
    page: Annotated[int, _check(lambda v: 1 <= v <= 10000, "Invalid page")] = 1
    size: Annotated[int, _check(lambda v: 1 <= v <= 500, "Invalid page size")] = 100


def parse_query(model: type[Model], params) -> Any:
    """Query strings with blank values are treated as absent (like the TS routes do)."""
    return model.model_validate({k: v for k, v in params.items() if v != ""})

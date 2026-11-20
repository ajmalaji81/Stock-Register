"""SQLAlchemy models mirroring prisma/schema.prisma (same table and column names)."""
from __future__ import annotations

import os
import secrets
import time
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, ForeignKeyConstraint, Index, Integer, String, Text, TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def new_id() -> str:
    """cuid-like id: 'c' + time (base36) + random (base36). 25 chars, sortable by creation time."""

    def b36(n: int, width: int) -> str:
        out = ""
        while n:
            n, r = divmod(n, 36)
            out = _ALPHABET[r] + out
        return out.rjust(width, "0")[-width:]

    return "c" + b36(int(time.time() * 1000), 8) + b36(secrets.randbits(64), 13) + b36(int.from_bytes(os.urandom(2), "big"), 3)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class PrismaDateTime(TypeDecorator):
    """DateTime stored like Prisma does on SQLite: integer milliseconds since the epoch (UTC).

    Reading also accepts ISO-8601 / 'YYYY-MM-DD HH:MM:SS' text, which Prisma writes for column defaults.
    Values always come back timezone-aware (UTC).
    """

    impl = Integer
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, str):
            value = datetime.fromisoformat(value)
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(round(value.timestamp() * 1000))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        text = str(value).replace(" ", "T")
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        d = datetime.fromisoformat(text)
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


class Base(DeclarativeBase):
    pass


def _id() -> Mapped[str]:
    return mapped_column(String, primary_key=True, default=new_id)


def _created() -> Mapped[datetime]:
    return mapped_column("createdAt", PrismaDateTime, default=now_utc)


class User(Base):
    __tablename__ = "User"

    id: Mapped[str] = _id()
    email: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    passwordHash: Mapped[str] = mapped_column(String)
    plan: Mapped[str] = mapped_column(String, default="FREE")  # FREE | PRO
    proSince: Mapped[Optional[datetime]] = mapped_column(PrismaDateTime, nullable=True)
    trialEndsAt: Mapped[Optional[datetime]] = mapped_column(PrismaDateTime, nullable=True)
    avatar: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    createdAt: Mapped[datetime] = _created()
    # Business profile (printed on invoices; state decides CGST+SGST vs IGST)
    businessName: Mapped[str] = mapped_column(String, default="")
    gstin: Mapped[str] = mapped_column(String, default="")
    address: Mapped[str] = mapped_column(String, default="")
    state: Mapped[str] = mapped_column(String, default="")
    phone: Mapped[str] = mapped_column(String, default="")
    invoicePrefix: Mapped[str] = mapped_column(String, default="INV")
    invoiceTerms: Mapped[str] = mapped_column(String, default="")
    bankDetails: Mapped[str] = mapped_column(String, default="")


class Godown(Base):
    __tablename__ = "Godown"
    __table_args__ = (UniqueConstraint("userId", "name"),)

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String)
    # GST identity of this location (blank = use the business profile). Decides CGST+SGST vs IGST and what the invoice prints.
    state: Mapped[str] = mapped_column(String, default="")
    gstin: Mapped[str] = mapped_column(String, default="")
    address: Mapped[str] = mapped_column(String, default="")
    createdAt: Mapped[datetime] = _created()


class Item(Base):
    __tablename__ = "Item"
    __table_args__ = (UniqueConstraint("userId", "sku"),)

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String)
    sku: Mapped[str] = mapped_column(String)
    category: Mapped[str] = mapped_column(String, default="")
    unit: Mapped[str] = mapped_column(String, default="pcs")
    purchasePrice: Mapped[float] = mapped_column(Float, default=0)
    salePrice: Mapped[float] = mapped_column(Float, default=0)
    minStockAlert: Mapped[float] = mapped_column(Float, default=0)
    hsn: Mapped[str] = mapped_column(String, default="")
    gstRate: Mapped[float] = mapped_column(Float, default=0)
    trackSerial: Mapped[bool] = mapped_column(Boolean, default=False)  # every unit has an IMEI / serial number
    createdAt: Mapped[datetime] = _created()
    updatedAt: Mapped[datetime] = mapped_column(PrismaDateTime, default=now_utc, onupdate=now_utc)

    stocks: Mapped[list["Stock"]] = relationship(cascade="all, delete-orphan", passive_deletes=True)


class Stock(Base):
    """Current quantity of one item in one godown. Only changed by ledger entries."""

    __tablename__ = "Stock"

    itemId: Mapped[str] = mapped_column(ForeignKey("Item.id", ondelete="CASCADE"), primary_key=True)
    godownId: Mapped[str] = mapped_column(ForeignKey("Godown.id", ondelete="CASCADE"), primary_key=True)
    quantity: Mapped[float] = mapped_column(Float, default=0)


class LedgerEntry(Base):
    """The khata. Immutable: entries are never edited or deleted (except when their item is deleted)."""

    __tablename__ = "LedgerEntry"
    __table_args__ = (Index("LedgerEntry_userId_createdAt_idx", "userId", "createdAt"),
                      Index("LedgerEntry_userId_itemId_createdAt_idx", "userId", "itemId", "createdAt"))

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    itemId: Mapped[str] = mapped_column(ForeignKey("Item.id", ondelete="CASCADE"))
    godownId: Mapped[str] = mapped_column(ForeignKey("Godown.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String)  # OPENING | IN | OUT | TRANSFER_IN | TRANSFER_OUT | ADJUSTMENT
    qtyIn: Mapped[float] = mapped_column(Float, default=0)
    qtyOut: Mapped[float] = mapped_column(Float, default=0)
    balance: Mapped[float] = mapped_column(Float)
    itemBalance: Mapped[float] = mapped_column(Float)
    rate: Mapped[float] = mapped_column(Float, default=0)
    party: Mapped[str] = mapped_column(String, default="")
    remarks: Mapped[str] = mapped_column(String, default="")
    transferId: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    refType: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    refId: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    actorName: Mapped[str] = mapped_column(String, default="")
    date: Mapped[str] = mapped_column(String)  # YYYY-MM-DD
    createdAt: Mapped[datetime] = _created()

    item: Mapped["Item"] = relationship()
    godown: Mapped["Godown"] = relationship()


class Payment(Base):
    __tablename__ = "Payment"

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    dodoPaymentId: Mapped[str] = mapped_column(String, unique=True)
    status: Mapped[str] = mapped_column(String)
    amount: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String)
    createdAt: Mapped[datetime] = _created()


class WebhookEvent(Base):
    """Webhook ids we've already processed (Dodo may retry deliveries)."""

    __tablename__ = "WebhookEvent"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String)
    receivedAt: Mapped[datetime] = mapped_column(PrismaDateTime, default=now_utc)


class Party(Base):
    __tablename__ = "Party"
    __table_args__ = (UniqueConstraint("userId", "name"),)

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String, default="CUSTOMER")  # CUSTOMER | SUPPLIER | BOTH
    phone: Mapped[str] = mapped_column(String, default="")
    email: Mapped[str] = mapped_column(String, default="")
    gstin: Mapped[str] = mapped_column(String, default="")
    state: Mapped[str] = mapped_column(String, default="")
    address: Mapped[str] = mapped_column(String, default="")
    openingBalance: Mapped[float] = mapped_column(Float, default=0)  # + they owe us, - we owe them
    linkedGodownId: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # this party IS one of our own godowns (branch)
    createdAt: Mapped[datetime] = _created()
    updatedAt: Mapped[datetime] = mapped_column(PrismaDateTime, default=now_utc, onupdate=now_utc)


class Voucher(Base):
    """One table for every trading document (bills, returns, quotations, orders, challans)."""

    __tablename__ = "Voucher"
    __table_args__ = (UniqueConstraint("userId", "kind", "number"), Index("Voucher_userId_kind_date_idx", "userId", "kind", "date"))

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String)
    number: Mapped[str] = mapped_column(String)
    date: Mapped[str] = mapped_column(String)
    partyId: Mapped[Optional[str]] = mapped_column(ForeignKey("Party.id", ondelete="RESTRICT"), nullable=True)
    godownId: Mapped[str] = mapped_column(ForeignKey("Godown.id", ondelete="RESTRICT"))
    status: Mapped[str] = mapped_column(String, default="OPEN")  # OPEN | CONVERTED | CLOSED | CANCELLED
    gstEnabled: Mapped[bool] = mapped_column(Boolean, default=True)
    interState: Mapped[bool] = mapped_column(Boolean, default=False)
    placeOfSupply: Mapped[str] = mapped_column(String, default="")
    subtotal: Mapped[float] = mapped_column(Float, default=0)
    discount: Mapped[float] = mapped_column(Float, default=0)
    cgst: Mapped[float] = mapped_column(Float, default=0)
    sgst: Mapped[float] = mapped_column(Float, default=0)
    igst: Mapped[float] = mapped_column(Float, default=0)
    roundOff: Mapped[float] = mapped_column(Float, default=0)
    total: Mapped[float] = mapped_column(Float, default=0)
    costTotal: Mapped[float] = mapped_column(Float, default=0)
    notes: Mapped[str] = mapped_column(String, default="")
    sourceId: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    createdBy: Mapped[str] = mapped_column(String, default="")
    createdAt: Mapped[datetime] = _created()
    # An old financial year's bill entered for the records: in reports and GST, but no stock, IMEI or customer-due effect.
    history: Mapped[bool] = mapped_column(Boolean, default=False)
    # Branch-to-branch invoice: PENDING (waiting for the receiving godown) -> APPROVED (auto purchase created) | REJECTED | CANCELLED
    branchStatus: Mapped[str] = mapped_column(String, default="")
    branchGodownId: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # receiving godown
    branchVoucherId: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # the purchase created on approval
    branchBy: Mapped[str] = mapped_column(String, default="")  # who approved / rejected
    branchAt: Mapped[Optional[datetime]] = mapped_column(PrismaDateTime, nullable=True)
    linkedVoucherId: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # on the auto purchase: the branch sale it came from
    modifiedBy: Mapped[str] = mapped_column(String, default="")  # set when the owner edits the bill
    modifiedAt: Mapped[Optional[datetime]] = mapped_column(PrismaDateTime, nullable=True)
    paymentInfo: Mapped[str] = mapped_column(String, default="")  # free-text payment details (printed)
    schemeInfo: Mapped[str] = mapped_column(String, default="")  # free-text scheme / offer details (printed)
    paymentSplit: Mapped[str] = mapped_column(Text, default="[]")  # JSON [{mode, amount, finance}] taken with the bill

    party: Mapped[Optional["Party"]] = relationship()
    godown: Mapped["Godown"] = relationship()
    lines: Mapped[list["VoucherLine"]] = relationship(cascade="all, delete-orphan", passive_deletes=True, order_by="VoucherLine.id")
    payments: Mapped[list["PartyPayment"]] = relationship(back_populates="voucher")


class VoucherLine(Base):
    __tablename__ = "VoucherLine"

    id: Mapped[str] = _id()
    voucherId: Mapped[str] = mapped_column(ForeignKey("Voucher.id", ondelete="CASCADE"))
    itemId: Mapped[str] = mapped_column(ForeignKey("Item.id", ondelete="RESTRICT"))
    description: Mapped[str] = mapped_column(String, default="")
    qty: Mapped[float] = mapped_column(Float)
    rate: Mapped[float] = mapped_column(Float)
    discountPct: Mapped[float] = mapped_column(Float, default=0)
    taxRate: Mapped[float] = mapped_column(Float, default=0)
    taxable: Mapped[float] = mapped_column(Float, default=0)
    tax: Mapped[float] = mapped_column(Float, default=0)
    amount: Mapped[float] = mapped_column(Float, default=0)
    costRate: Mapped[float] = mapped_column(Float, default=0)
    serials: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of IMEI / serial numbers on this line

    item: Mapped["Item"] = relationship()


class PartyPayment(Base):
    __tablename__ = "PartyPayment"
    __table_args__ = (Index("PartyPayment_userId_partyId_date_idx", "userId", "partyId", "date"),)

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    partyId: Mapped[str] = mapped_column(ForeignKey("Party.id", ondelete="CASCADE"))
    direction: Mapped[str] = mapped_column(String)  # IN = received from party, OUT = paid to party
    amount: Mapped[float] = mapped_column(Float)
    mode: Mapped[str] = mapped_column(String, default="CASH")
    date: Mapped[str] = mapped_column(String)
    reference: Mapped[str] = mapped_column(String, default="")
    notes: Mapped[str] = mapped_column(String, default="")
    voucherId: Mapped[Optional[str]] = mapped_column(ForeignKey("Voucher.id", ondelete="SET NULL"), nullable=True)
    withBill: Mapped[bool] = mapped_column(Boolean, default=False)  # taken together with the bill (vs. a later receipt)
    createdBy: Mapped[str] = mapped_column(String, default="")
    createdAt: Mapped[datetime] = _created()

    party: Mapped["Party"] = relationship()
    voucher: Mapped[Optional["Voucher"]] = relationship(back_populates="payments")


class Expense(Base):
    __tablename__ = "Expense"
    __table_args__ = (Index("Expense_userId_date_idx", "userId", "date"),)

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    category: Mapped[str] = mapped_column(String)
    amount: Mapped[float] = mapped_column(Float)
    mode: Mapped[str] = mapped_column(String, default="CASH")
    date: Mapped[str] = mapped_column(String)
    notes: Mapped[str] = mapped_column(String, default="")
    createdBy: Mapped[str] = mapped_column(String, default="")
    createdAt: Mapped[datetime] = _created()


class StaffMember(Base):
    __tablename__ = "StaffMember"

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str] = mapped_column(String, unique=True)
    passwordHash: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)  # SALES | SALES_PURCHASE | STORE_ADMIN
    avatar: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    godownIds: Mapped[str] = mapped_column(String, default="[]")  # JSON array; [] = all godowns
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    createdAt: Mapped[datetime] = _created()

    user: Mapped["User"] = relationship()


class ActivityLog(Base):
    __tablename__ = "ActivityLog"
    __table_args__ = (Index("ActivityLog_userId_createdAt_idx", "userId", "createdAt"),)

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    actorId: Mapped[str] = mapped_column(String)
    actorName: Mapped[str] = mapped_column(String)
    action: Mapped[str] = mapped_column(String)
    detail: Mapped[str] = mapped_column(String, default="")
    createdAt: Mapped[datetime] = _created()


class SerialUnit(Base):
    """One physical unit (phone) with its IMEI / serial number. Status and godown are a cache of its latest active event."""

    __tablename__ = "SerialUnit"
    __table_args__ = (UniqueConstraint("userId", "imei"), Index("SerialUnit_userId_itemId_idx", "userId", "itemId"))

    id: Mapped[str] = _id()
    userId: Mapped[str] = mapped_column(ForeignKey("User.id", ondelete="CASCADE"))
    itemId: Mapped[str] = mapped_column(String)
    imei: Mapped[str] = mapped_column(String)
    imei2: Mapped[str] = mapped_column(String, default="")  # second SIM slot, if any
    status: Mapped[str] = mapped_column(String, default="IN_STOCK")  # IN_STOCK | SOLD | RETURNED (to supplier) | VOID
    godownId: Mapped[str] = mapped_column(String, default="")  # where it is (or was sold from); "" when returned / void
    createdAt: Mapped[datetime] = _created()

    events: Mapped[list["SerialEvent"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, order_by="SerialEvent.createdAt, SerialEvent.id"
    )


class SerialEvent(Base):
    """History of a unit: PURCHASE, TRANSFER, SALE, SALE_RETURN, PURCHASE_RETURN. Undone events are kept with voided=True."""

    __tablename__ = "SerialEvent"
    __table_args__ = (Index("SerialEvent_voucherId_idx", "voucherId"),)

    id: Mapped[str] = _id()
    serialId: Mapped[str] = mapped_column(ForeignKey("SerialUnit.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String)
    date: Mapped[str] = mapped_column(String)  # YYYY-MM-DD
    fromGodownId: Mapped[str] = mapped_column(String, default="")
    toGodownId: Mapped[str] = mapped_column(String, default="")
    voucherId: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    voucherNumber: Mapped[str] = mapped_column(String, default="")
    partyName: Mapped[str] = mapped_column(String, default="")
    rate: Mapped[float] = mapped_column(Float, default=0)
    note: Mapped[str] = mapped_column(String, default="")
    actorName: Mapped[str] = mapped_column(String, default="")
    voided: Mapped[bool] = mapped_column(Boolean, default=False)
    createdAt: Mapped[datetime] = _created()

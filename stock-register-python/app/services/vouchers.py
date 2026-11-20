"""Bills and trading documents (vouchers). Bills can be cancelled (which reverses their stock) or, by the account owner only,
edited in place (stock is re-applied, the edit is recorded). They are never deleted.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
from typing import Any, Optional

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from .. import config
from ..core.engine import today_iso
from ..core.errors import StockError
from ..core.gst import (
    godown_identity, CONVERSIONS, KIND_LABEL, KIND_PREFIX, LineInput, calc_totals, format_number, is_inter_state, is_purchase_side,
    stock_effect,
)
from ..core.fy import current_fy, fy_range
from ..core.jsmath import r2, round3
from ..models import Godown, Party, PartyPayment, User, Voucher, VoucherLine, now_utc
from ..schemas import SettingsInput, VoucherCreateInput
from . import branch as branch_svc
from .activity import iso, log_activity
from .actor import Actor, assert_can, assert_godown_access, can_use_godown
from . import serials as serial_svc
from .stock import StockEntryInput, apply_stock_entry, fmt_num, get_godown

# ---------- Permissions ----------


def permission_for(kind: str) -> str:
    if kind in ("SALE", "SALE_RETURN"):
        return "sales.create"
    if kind in ("PURCHASE", "PURCHASE_RETURN"):
        return "purchases.create"
    return "documents.manage"


def can_see_kind(actor: Actor, kind: str) -> bool:
    """Can this actor see vouchers of this kind? Purchase-side documents reveal costs."""
    if is_purchase_side(kind) and not actor.can("costs.view"):
        return False
    return actor.can(permission_for(kind)) or actor.can("reports.view")


# ---------- Public share links ----------


def share_token(voucher_id: str) -> str:
    """Unguessable token for a public, read-only view of one sale-side document."""
    digest = hmac.new(config.auth_secret().encode(), f"voucher-share:{voucher_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()[:32]


def valid_share_token(voucher_id: str, token: str) -> bool:
    return hmac.compare_digest(share_token(voucher_id).encode(), token.encode())


def get_shared_voucher(db: Session, voucher_id: str, token: str) -> Optional[dict]:
    """The document for a public share link, viewed with no access to costs. None if the token is wrong."""
    if not token or not valid_share_token(voucher_id, token):
        return None
    v = db.get(Voucher, voucher_id)
    if v is None or is_purchase_side(v.kind):
        return None
    owner = db.get(User, v.userId)
    viewer = Actor(
        account_id=v.userId, owner=owner, actor_id="share-link", name="Shared link", email="", avatar=None,
        role="SALES", is_owner=False, godown_ids=None, _can=lambda p: p != "costs.view",
    )
    return {"voucher": get_voucher(db, viewer, voucher_id), "profile": profile_of(owner)}


# ---------- Helpers ----------


def _loaded(q):
    return q.options(
        selectinload(Voucher.party), selectinload(Voucher.godown), selectinload(Voucher.payments),
        selectinload(Voucher.lines).selectinload(VoucherLine.item),
    )


def to_dto(v: Voucher, actor: Actor, source_number: Optional[str], converted_to: list[dict], with_lines: bool) -> dict:
    show_costs = actor.can("costs.view")
    kind = v.kind
    sign = -1 if kind in ("SALE_RETURN", "PURCHASE_RETURN") else 1
    profit = r2(sign * (v.subtotal - v.costTotal)) if kind in ("SALE", "SALE_RETURN") else None
    ident = godown_identity(v.godown, actor.owner)
    try:
        split = json.loads(v.paymentSplit or "[]")
    except ValueError:
        split = []
    dto: dict[str, Any] = {
        "id": v.id, "kind": kind, "number": v.number, "date": v.date, "status": v.status,
        "partyId": v.partyId,
        "partyName": v.party.name if v.party else "Cash",
        "partyPhone": v.party.phone if v.party else "",
        "partyGstin": v.party.gstin if v.party else "",
        "partyState": v.party.state if v.party else "",
        "partyAddress": v.party.address if v.party else "",
        "godownId": v.godownId, "godownName": v.godown.name,
        "godownState": ident["state"], "godownGstin": ident["gstin"], "godownAddress": ident["address"],
        "branchStatus": v.branchStatus, "branchGodownId": v.branchGodownId, "branchVoucherId": v.branchVoucherId,
        "linkedVoucherId": v.linkedVoucherId, "branchBy": v.branchBy, "branchAt": iso(v.branchAt) if v.branchAt else None,
        "gstEnabled": v.gstEnabled, "interState": v.interState, "placeOfSupply": v.placeOfSupply,
        "subtotal": v.subtotal, "discount": v.discount, "cgst": v.cgst, "sgst": v.sgst, "igst": v.igst,
        "roundOff": v.roundOff, "total": v.total,
        "paid": r2(sum(p.amount for p in v.payments)) if (v.party and not v.history) else r2(sum(r["amount"] for r in split)),
        "history": v.history,
        "paymentSplit": split, "paymentInfo": v.paymentInfo, "schemeInfo": v.schemeInfo,
        "modifiedBy": v.modifiedBy, "modifiedAt": iso(v.modifiedAt) if v.modifiedAt else None,
        "notes": v.notes, "sourceId": v.sourceId, "sourceNumber": source_number, "convertedTo": converted_to,
        "createdBy": v.createdBy, "createdAt": iso(v.createdAt),
        "costTotal": v.costTotal if show_costs else None,
        "profit": profit if show_costs else None,
        "shareToken": None if is_purchase_side(kind) else share_token(v.id),
    }
    if with_lines:
        dto["lines"] = [
            {
                "id": l.id, "itemId": l.itemId, "itemName": l.item.name, "unit": l.item.unit, "hsn": l.item.hsn,
                "description": l.description, "qty": l.qty, "rate": l.rate, "discountPct": l.discountPct,
                "serials": json.loads(l.serials or "[]"),
                "taxRate": l.taxRate, "taxable": l.taxable, "tax": l.tax, "amount": l.amount,
                "costRate": l.costRate if show_costs else None,
            }
            for l in v.lines
        ]
    return dto


def next_number(db: Session, account_id: str, kind: str, prefix: str) -> str:
    numbers = db.execute(
        select(Voucher.number).where(
            Voucher.userId == account_id, Voucher.kind == kind, Voucher.history.is_(False),
            Voucher.number.startswith(f"{prefix}-", autoescape=True),
        )
    ).scalars().all()
    top = 0.0
    for num in numbers:
        try:
            n = float(num[len(prefix) + 1:] or 0)
        except ValueError:
            continue
        if math.isfinite(n) and n > top:
            top = n
    return format_number(prefix, int(top) + 1)


def prefix_for(kind: str, invoice_prefix: str) -> str:
    return (invoice_prefix.strip() or "INV") if kind == "SALE" else KIND_PREFIX[kind]


def _payment_rows(inp: VoucherCreateInput, kind: str, total: float) -> list[dict]:
    """Normalised payments taken with the bill: [{mode, amount, finance}]. One row = one mode; several = split payment."""
    if inp.paymentSplit:
        rows = [{"mode": r.mode, "amount": r2(r.amount), "finance": r.finance.strip()} for r in inp.paymentSplit]
    elif (inp.paidNow or 0) > 0:
        rows = [{"mode": inp.paymentMode, "amount": r2(inp.paidNow), "finance": ""}]
    else:
        rows = []
    rows = [r for r in rows if r["amount"] > 0 or r["mode"] == "FINANCE"]
    if not rows:
        return []
    if kind not in ("SALE", "PURCHASE"):
        raise StockError("Payments can only be recorded with sales or purchase bills")
    for r in rows:
        if r["mode"] == "FINANCE":
            if not r["finance"]:
                raise StockError("Choose the finance company for the FINANCE payment")
            if r["amount"] <= 0:
                raise StockError("Enter the amount disbursed by the finance company")
        else:
            r["finance"] = ""
    if r2(sum(r["amount"] for r in rows)) > total + 0.005:
        raise StockError("Amount paid can't be more than the bill total")
    return rows


def _net_stock_by_line(db: Session, account_id: str, voucher_id: str) -> list[tuple]:
    """What this voucher currently leaves out of stock, per item+godown, across its original, edit and cancel entries.

    Returns [(itemId, godownId, net_out, rate, party)]; net_out > 0 means stock is still out, < 0 still in.
    """
    from ..models import LedgerEntry

    entries = db.execute(
        select(LedgerEntry).where(
            LedgerEntry.userId == account_id, LedgerEntry.refId == voucher_id,
            LedgerEntry.refType.in_(("VOUCHER", "VOUCHER_EDIT", "VOUCHER_CANCEL")),
        ).order_by(LedgerEntry.createdAt, LedgerEntry.id)
    ).scalars().all()
    net: dict[tuple, list] = {}
    for e in entries:
        n = net.setdefault((e.itemId, e.godownId), [0.0, e.rate, e.party])
        n[0] += e.qtyOut - e.qtyIn
    return [(i, g, round3(n[0]), n[1], n[2]) for (i, g), n in net.items() if abs(round3(n[0])) > 0]


def _reverse_stock(db: Session, actor: Actor, v: Voucher, ref_type: str, remarks: str, date: str) -> None:
    """Put back exactly the stock this voucher still holds (works after any number of edits)."""
    for item_id, godown_id, net_out, rate, party in _net_stock_by_line(db, actor.account_id, v.id):
        apply_stock_entry(
            db, actor,
            StockEntryInput(
                itemId=item_id, godownId=godown_id, type="IN" if net_out > 0 else "OUT", qty=abs(net_out), rate=rate,
                party=party, remarks=remarks, date=date, refType=ref_type, refId=v.id,
            ),
        )


def _check_history(inp: VoucherCreateInput, kind: str, party: Optional[Party], system: bool) -> None:
    if system or kind not in ("SALE", "PURCHASE", "SALE_RETURN", "PURCHASE_RETURN"):
        raise StockError("Only sales and purchase bills (and their returns) can be old-year records")
    if party is not None and party.linkedGodownId:
        raise StockError("An invoice between your own godowns can't be an old-year record")
    start, _ = fy_range(current_fy())
    if inp.date >= start:
        raise StockError(f"Old-year records must be dated before the current financial year (before {start}). For this year, enter a normal bill.")


def _create_in_tx(
    db: Session, actor: Actor, inp: VoucherCreateInput, source_id: Optional[str] = None, skip_stock: bool = False,
    existing: Optional[Voucher] = None, system: bool = False, extra: Optional[dict] = None,
) -> str:
    """Create a bill, or (existing=...) rewrite one in place: same id and number, stock re-applied.

    system=True is for the purchase created by a branch approval: the approver's role isn't checked against purchases.create.
    """
    kind = inp.kind
    if not system:
        assert_can(actor, permission_for(kind))
    assert_godown_access(actor, inp.godownId)
    account_id = actor.account_id
    owner = db.get(User, account_id)
    src_godown = get_godown(db, account_id, inp.godownId)
    home_state = godown_identity(src_godown, owner)["state"]

    party = None
    if inp.partyId:
        party = db.execute(select(Party).where(Party.id == inp.partyId, Party.userId == account_id)).scalar_one_or_none()
        if party is None:
            raise StockError("Party not found", 404)
    if kind in ("PURCHASE", "PURCHASE_RETURN", "PURCHASE_ORDER") and party is None:
        raise StockError("Choose the supplier for this bill")
    if kind == "SALE_RETURN" and party is None:
        raise StockError("Choose the customer returning the goods")
    branch_dest = None
    if party is not None and party.linkedGodownId:
        if kind != "SALE" and not system:
            raise StockError("A godown can only be billed with a sales invoice. To just move stock, use a transfer.")
        if kind == "SALE":
            branch_dest = branch_svc.check_supply(db, account_id, src_godown, party.linkedGodownId, owner)

    from ..models import Item

    ids = list(dict.fromkeys(l.itemId for l in inp.lines))
    items = db.execute(select(Item).where(Item.id.in_(ids), Item.userId == account_id)).scalars().all()
    if len(items) != len(ids):
        raise StockError("One of the items was not found", 404)
    by_id = {i.id: i for i in items}
    history = bool(inp.history)
    if history:
        _check_history(inp, kind, party, system)
        serial_tokens = [[] for _ in inp.lines]  # nothing physical moves, so no IMEIs are recorded
    else:
        serial_tokens = serial_svc.prepare_lines([(l, round3(l.qty)) for l in inp.lines], by_id, kind, source_id)

    place_of_supply = inp.placeOfSupply or (party.state if party else "") or home_state
    inter_state = inp.gstEnabled and is_inter_state(home_state, place_of_supply)
    lines = [(l, round3(l.qty)) for l in inp.lines]
    t = calc_totals(
        [LineInput(qty=q, rate=l.rate, discount_pct=l.discountPct, tax_rate=l.taxRate) for l, q in lines],
        gst_enabled=inp.gstEnabled, inter_state=inter_state,
    )
    cost_total = r2(sum(q * by_id[l.itemId].purchasePrice for l, q in lines))

    pay_rows = _payment_rows(inp, kind, t.total)
    if pay_rows and party is None and kind != "SALE":
        raise StockError("Choose a party to record a payment against")
    if pay_rows and branch_dest is not None:
        raise StockError("An invoice to your own godown can't take a payment. The receiving godown approves it instead.")

    voucher_lines = [
        VoucherLine(
            itemId=l.itemId, description=l.description, qty=q, rate=l.rate, discountPct=l.discountPct,
            taxRate=l.taxRate if inp.gstEnabled else 0, taxable=t.lines[i].taxable, tax=t.lines[i].tax,
            amount=t.lines[i].amount, costRate=by_id[l.itemId].purchasePrice, serials=json.dumps(serial_tokens[i]),
        )
        for i, (l, q) in enumerate(lines)
    ]
    fields = dict(
        date=inp.date, partyId=party.id if party else None, godownId=inp.godownId, gstEnabled=inp.gstEnabled,
        interState=inter_state, placeOfSupply=place_of_supply, subtotal=t.subtotal, discount=t.discount, cgst=t.cgst,
        sgst=t.sgst, igst=t.igst, roundOff=t.round_off, total=t.total, costTotal=cost_total, notes=inp.notes,
        paymentInfo=inp.paymentInfo, schemeInfo=inp.schemeInfo, paymentSplit=json.dumps(pay_rows),
        branchStatus=branch_svc.PENDING if branch_dest is not None else "", branchGodownId=branch_dest.id if branch_dest is not None else None,
        branchBy="", branchAt=None, history=history,
    )

    if existing is None:
        if history:
            number = inp.oldNumber.strip()
            if not number:
                raise StockError("Enter the old invoice number from your books")
            if db.execute(select(Voucher.id).where(Voucher.userId == account_id, Voucher.kind == kind, Voucher.number == number)).first():
                raise StockError(f"{number} already exists")
        else:
            number = next_number(db, account_id, kind, prefix_for(kind, owner.invoicePrefix))
        v = Voucher(userId=account_id, kind=kind, number=number, sourceId=source_id, createdBy=actor.name, **fields, **(extra or {}))
        v.lines.extend(voucher_lines)
        db.add(v)
    else:
        v, number = existing, existing.number
        assert_godown_access(actor, v.godownId)
        later = db.execute(
            select(func.coalesce(func.sum(PartyPayment.amount), 0.0)).where(
                PartyPayment.userId == account_id, PartyPayment.voucherId == v.id, PartyPayment.withBill.is_(False)
            )
        ).scalar_one()
        if r2(later + sum(r["amount"] for r in pay_rows)) > t.total + 0.005:
            raise StockError("Payments already recorded against this bill are more than the new total")
        serial_svc.void_voucher(db, account_id, v.id)
        _reverse_stock(db, actor, v, "VOUCHER_EDIT", f"Edited {number}", today_iso())
        db.execute(delete(PartyPayment).where(
            PartyPayment.userId == account_id, PartyPayment.voucherId == v.id, PartyPayment.withBill.is_(True)))
        v.lines.clear()
        db.flush()
        for k, val in fields.items():
            setattr(v, k, val)
        v.lines.extend(voucher_lines)
        v.modifiedBy, v.modifiedAt = actor.name, now_utc()
    db.flush()

    if kind in serial_svc.SERIAL_KINDS and not history:
        entries = [(by_id[l.itemId], tok, l.rate) for (l, _), toks in zip(lines, serial_tokens) for tok in toks]
        if entries:
            serial_svc.record_units(db, actor, v, kind, entries, party.name if party else "Cash customer")

    effect = None if (skip_stock or history) else stock_effect(kind)
    if effect:
        for l, q in lines:
            apply_stock_entry(
                db, actor,
                StockEntryInput(
                    itemId=l.itemId, godownId=inp.godownId, type=effect, qty=q, rate=l.rate,
                    party=party.name if party else "Cash", remarks=number, date=inp.date, refType="VOUCHER", refId=v.id,
                ),
            )

    if party and not history:  # an old bill's payments are only recorded on the bill, not in today's customer dues
        for r in pay_rows:
            note = f"With {KIND_LABEL[kind].lower()} {number}" + (f" · {r['finance']}" if r["finance"] else "")
            db.add(
                PartyPayment(
                    userId=account_id, partyId=party.id, direction="IN" if kind == "SALE" else "OUT", amount=r["amount"],
                    mode=r["mode"], date=inp.date, reference=number, notes=note, voucherId=v.id, withBill=True,
                    createdBy=actor.name,
                )
            )
        db.flush()

    edited = existing is not None
    log_activity(
        db, actor, "voucher.update" if edited else "voucher.create",
        f"{KIND_LABEL[kind]} {number}{' edited' if edited else ''} · {party.name if party else 'Cash'} · ₹{fmt_num(t.total)}",
    )
    return v.id


# ---------- Public API ----------


def update_voucher(db: Session, actor: Actor, voucher_id: str, inp: VoucherCreateInput) -> dict:
    """Edit an open bill in place. Only the account owner (super admin) may do this."""
    if not actor.is_owner:
        raise StockError("Only the account owner can edit a bill.", 403, "FORBIDDEN")
    v = db.execute(
        select(Voucher).where(Voucher.id == voucher_id, Voucher.userId == actor.account_id).options(selectinload(Voucher.lines))
    ).scalar_one_or_none()
    if v is None:
        raise StockError("Bill not found", 404)
    if v.status != "OPEN":
        raise StockError("Only open bills can be edited", 409)
    if inp.kind != v.kind:
        raise StockError("The type of a bill can't be changed")
    if inp.history and not v.history:
        raise StockError("An existing bill can't be turned into an old-year record. Cancel it and enter the old bill instead.")
    if v.history:
        inp = inp.model_copy(update={"history": True})
    if v.branchStatus in (branch_svc.APPROVING, branch_svc.APPROVED):
        raise StockError("The receiving godown already approved this invoice, so it can't be edited. Cancel the purchase there first.", 409)
    if v.linkedVoucherId:
        raise StockError("This purchase was created automatically from another godown's invoice and can't be edited.", 409)
    skip = False
    if v.sourceId:
        src_kind = db.execute(select(Voucher.kind).where(Voucher.id == v.sourceId)).scalar_one_or_none()
        skip = src_kind == "CHALLAN" and v.kind == "SALE"
    _create_in_tx(db, actor, inp, source_id=v.sourceId, skip_stock=skip, existing=v)
    db.expire_all()
    return get_voucher(db, actor, voucher_id)


def create_voucher(db: Session, actor: Actor, inp: VoucherCreateInput) -> dict:
    vid = _create_in_tx(db, actor, inp)
    return get_voucher(db, actor, vid)


def get_voucher(db: Session, actor: Actor, voucher_id: str) -> dict:
    v = db.execute(_loaded(select(Voucher).where(Voucher.id == voucher_id, Voucher.userId == actor.account_id))).scalar_one_or_none()
    if v is None or not can_use_godown(actor, v.godownId) or not can_see_kind(actor, v.kind):
        raise StockError("Bill not found", 404)
    source = None
    if v.sourceId:
        source = db.execute(
            select(Voucher.number).where(Voucher.id == v.sourceId, Voucher.userId == actor.account_id)
        ).scalar_one_or_none()
    children = db.execute(
        select(Voucher.id, Voucher.kind, Voucher.number).where(Voucher.userId == actor.account_id, Voucher.sourceId == v.id)
    ).all()
    dto = to_dto(v, actor, source, [{"id": c.id, "kind": c.kind, "number": c.number} for c in children], True)
    dto["branchGodownName"] = db.execute(select(Godown.name).where(Godown.id == v.branchGodownId)).scalar_one_or_none() if v.branchGodownId else None
    link_ids = [x for x in (v.branchVoucherId, v.linkedVoucherId) if x]
    nums = {r.id: (r.number, r.godownId) for r in db.execute(select(Voucher.id, Voucher.number, Voucher.godownId).where(Voucher.id.in_(link_ids))).all()} if link_ids else {}
    seen = lambda vid: bool(vid and vid in nums and can_use_godown(actor, nums[vid][1]))  # noqa: E731
    dto["branchVoucherNumber"] = nums[v.branchVoucherId][0] if seen(v.branchVoucherId) else None
    dto["linkedVoucherNumber"] = nums[v.linkedVoucherId][0] if seen(v.linkedVoucherId) else None
    return dto


def list_vouchers(db: Session, actor: Actor, f: dict) -> list[dict]:
    requested = [k for k in (f.get("kind") or "").split(",") if k]
    kinds = [k for k in (requested or list(KIND_LABEL)) if can_see_kind(actor, k)]
    if not kinds:
        return []
    q = (f.get("q") or "").strip()
    stmt = select(Voucher).where(Voucher.userId == actor.account_id, Voucher.kind.in_(kinds))
    if f.get("partyId"):
        stmt = stmt.where(Voucher.partyId == f["partyId"])
    if f.get("status"):
        stmt = stmt.where(Voucher.status == f["status"])
    if f.get("from"):
        stmt = stmt.where(Voucher.date >= f["from"])
    if f.get("to"):
        stmt = stmt.where(Voucher.date <= f["to"])
    if actor.godown_ids is not None:
        stmt = stmt.where(Voucher.godownId.in_(actor.godown_ids))
    if q:
        stmt = stmt.where(
            or_(
                Voucher.number.contains(q, autoescape=True),
                Voucher.party.has(Party.name.contains(q, autoescape=True)),
                Voucher.notes.contains(q, autoescape=True),
            )
        )
    rows = db.execute(_loaded(stmt.order_by(Voucher.date.desc(), Voucher.createdAt.desc()).limit(500))).scalars().all()
    ids = [r.id for r in rows]
    children = (
        db.execute(
            select(Voucher.id, Voucher.kind, Voucher.number, Voucher.sourceId).where(
                Voucher.userId == actor.account_id, Voucher.sourceId.in_(ids)
            )
        ).all()
        if ids
        else []
    )
    source_ids = [r.sourceId for r in rows if r.sourceId]
    sources = (
        db.execute(select(Voucher.id, Voucher.number).where(Voucher.userId == actor.account_id, Voucher.id.in_(source_ids))).all()
        if source_ids
        else []
    )
    src_map = {s.id: s.number for s in sources}
    return [
        to_dto(
            r, actor, src_map.get(r.sourceId) if r.sourceId else None,
            [{"id": c.id, "kind": c.kind, "number": c.number} for c in children if c.sourceId == r.id], False,
        )
        for r in rows
    ]


def _cancel_in_tx(db: Session, actor: Actor, v: Voucher, branch_status: str = "CANCELLED") -> None:
    """Undo a bill's stock, IMEIs and payments and mark it cancelled (no permission checks: callers do those)."""
    kind = v.kind
    serial_svc.void_voucher(db, actor.account_id, v.id)
    # Reverse exactly the stock this voucher still holds (a challan-converted sale moved none).
    _reverse_stock(db, actor, v, "VOUCHER_CANCEL", f"Cancelled {v.number}", today_iso())
    # Payments recorded together with this bill go away with it.
    linked = db.execute(delete(PartyPayment).where(PartyPayment.userId == actor.account_id, PartyPayment.voucherId == v.id)).rowcount
    number, source_id, was_branch = v.number, v.sourceId, bool(v.branchStatus)
    db.execute(update(Voucher).where(Voucher.id == v.id).values(status="CANCELLED"))
    if was_branch:  # a branch invoice that never got approved
        db.execute(update(Voucher).where(Voucher.id == v.id).values(branchStatus=branch_status))
    # A cancelled conversion re-opens its quotation / order / challan.
    if source_id:
        db.execute(
            update(Voucher).where(Voucher.id == source_id, Voucher.userId == actor.account_id, Voucher.status == "CONVERTED").values(status="OPEN")
        )
    # Cancelling the purchase that an approval created sends the branch invoice back to "waiting for approval".
    if kind == "PURCHASE" and v.linkedVoucherId:
        db.execute(
            update(Voucher).where(Voucher.id == v.linkedVoucherId, Voucher.userId == actor.account_id).values(
                branchStatus=branch_svc.PENDING, branchVoucherId=None, branchBy="", branchAt=None
            )
        )
    db.expire_all()
    log_activity(db, actor, "voucher.cancel", f"{KIND_LABEL[kind]} {number}" + (f" (removed {linked} linked payment)" if linked else ""))


def cancel_voucher(db: Session, actor: Actor, voucher_id: str) -> dict:
    v = db.execute(select(Voucher).where(Voucher.id == voucher_id, Voucher.userId == actor.account_id)).scalar_one_or_none()
    if v is None or not can_use_godown(actor, v.godownId):
        raise StockError("Bill not found", 404)
    assert_can(actor, permission_for(v.kind))
    if v.status == "CANCELLED":
        raise StockError("This is already cancelled")
    if v.status == "CONVERTED":
        raise StockError("This was converted into another bill. Cancel that bill first.", 409)
    if v.branchStatus in (branch_svc.APPROVING, branch_svc.APPROVED):
        raise StockError("The receiving godown already approved this invoice. Ask them to cancel the purchase created from it first.", 409)
    _cancel_in_tx(db, actor, v)
    return get_voucher(db, actor, voucher_id)


def convert_voucher(db: Session, actor: Actor, voucher_id: str, to: str, date: Optional[str] = None) -> dict:
    src = db.execute(
        select(Voucher).where(Voucher.id == voucher_id, Voucher.userId == actor.account_id).options(selectinload(Voucher.lines))
    ).scalar_one_or_none()
    if src is None or not can_use_godown(actor, src.godownId):
        raise StockError("Document not found", 404)
    frm = src.kind
    assert_can(actor, permission_for(frm))
    if to not in CONVERSIONS.get(frm, []):
        raise StockError(f"A {KIND_LABEL[frm].lower()} can't be converted to a {KIND_LABEL[to].lower()}")
    if src.status != "OPEN":
        raise StockError(f"This {KIND_LABEL[frm].lower()} is {src.status.lower()}", 409)
    from ..schemas import VoucherLineInput

    created = _create_in_tx(
        db, actor,
        VoucherCreateInput.model_construct(
            kind=to, date=date or today_iso(), partyId=src.partyId, godownId=src.godownId, gstEnabled=src.gstEnabled,
            placeOfSupply=src.placeOfSupply, notes=src.notes,
            lines=[
                VoucherLineInput.model_construct(
                    itemId=l.itemId, description=l.description, qty=l.qty, rate=l.rate, discountPct=l.discountPct, taxRate=l.taxRate
                )
                for l in src.lines
            ],
            paidNow=0, paymentMode="CASH",
        ),
        source_id=src.id, skip_stock=(frm == "CHALLAN" and to == "SALE"),
    )
    number = src.number
    db.execute(update(Voucher).where(Voucher.id == voucher_id).values(status="CONVERTED"))
    db.expire_all()
    log_activity(db, actor, "voucher.convert", f"{KIND_LABEL[frm]} {number} → {KIND_LABEL[to]}")
    return get_voucher(db, actor, created)


# ---------- Business profile ----------

PROFILE_FIELDS = ("businessName", "gstin", "address", "state", "phone", "invoicePrefix", "invoiceTerms", "bankDetails")


def profile_of(u: User) -> dict:
    return {k: getattr(u, k) for k in PROFILE_FIELDS}


def update_profile(db: Session, actor: Actor, p: SettingsInput) -> dict:
    u = db.get(User, actor.account_id)
    for k in PROFILE_FIELDS:
        setattr(u, k, getattr(p, k))
    u.invoicePrefix = p.invoicePrefix or "INV"
    db.flush()
    log_activity(db, actor, "settings.update", "Business profile")
    return profile_of(u)


# ---------- Reports ----------


def _round_obj(o: dict) -> dict:
    return {k: (round3(v) if k == "qty" else r2(v)) if isinstance(v, (int, float)) and not isinstance(v, bool) else v for k, v in o.items()}


def _report_charts(rows: list) -> dict:
    """Bar-chart series (label, value) from sales alone. Never touches cost or profit."""
    from datetime import date as _date

    dates = sorted(v.date for v in rows)
    monthly = False
    if dates:
        try:
            monthly = (_date.fromisoformat(dates[-1]) - _date.fromisoformat(dates[0])).days > 62
        except ValueError:
            pass
    by_time: dict[str, float] = {}
    by_item: dict[str, float] = {}
    by_party: dict[str, float] = {}
    by_mode: dict[str, float] = {}
    for v in rows:
        sg = -1 if v.kind.endswith("_RETURN") else 1
        key = v.date[:7] if monthly else v.date
        by_time[key] = by_time.get(key, 0.0) + sg * v.total
        name = v.party.name if v.party else "Cash"
        by_party[name] = by_party.get(name, 0.0) + sg * v.total
        for l in v.lines:
            by_item[l.item.name] = by_item.get(l.item.name, 0.0) + sg * l.taxable
        if sg == 1:
            try:
                split = json.loads(v.paymentSplit or "[]")
            except ValueError:
                split = []
            if not split:
                by_mode["Unspecified"] = by_mode.get("Unspecified", 0.0) + v.total
            for r in split:
                by_mode[r["mode"]] = by_mode.get(r["mode"], 0.0) + r["amount"]

    def series(d: dict, top: Optional[int] = None, keep_order: bool = False) -> list[dict]:
        items = list(d.items()) if keep_order else sorted(d.items(), key=lambda kv: -kv[1])
        if top:
            items = items[:top]
        return [{"label": k, "value": r2(v)} for k, v in items]

    return {
        "timeUnit": "month" if monthly else "day",
        "byTime": series(dict(sorted(by_time.items())), keep_order=True),
        "topItems": series(by_item, 8), "topParties": series(by_party, 8), "byMode": series(by_mode),
    }


def sales_report(db: Session, actor: Actor, side: str, from_: Optional[str] = None, to: Optional[str] = None) -> dict:
    assert_can(actor, "reports.view")
    if side == "purchases":
        assert_can(actor, "costs.view")
    kinds = ["SALE", "SALE_RETURN"] if side == "sales" else ["PURCHASE", "PURCHASE_RETURN"]
    stmt = select(Voucher).where(Voucher.userId == actor.account_id, Voucher.kind.in_(kinds), Voucher.status != "CANCELLED")
    if from_:
        stmt = stmt.where(Voucher.date >= from_)
    if to:
        stmt = stmt.where(Voucher.date <= to)
    if actor.godown_ids is not None:
        stmt = stmt.where(Voucher.godownId.in_(actor.godown_ids))
    rows = db.execute(
        stmt.options(selectinload(Voucher.party), selectinload(Voucher.lines).selectinload(VoucherLine.item))
        .order_by(Voucher.date, Voucher.createdAt)
    ).scalars().all()

    rate: dict[float, dict] = {}
    hsn: dict[str, dict] = {}
    b2b = {"count": 0, "taxable": 0.0, "tax": 0.0, "total": 0.0}
    b2c = {"count": 0, "taxable": 0.0, "tax": 0.0, "total": 0.0}
    totals = {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0, "total": 0.0}
    by_item: dict[str, dict] = {}
    by_party: dict[str, dict] = {}
    by_bill: list[dict] = []
    register: list[dict] = []

    for v in rows:
        s = -1 if v.kind.endswith("_RETURN") else 1
        party = v.party.name if v.party else "Cash"
        bucket = b2b if (v.party and v.party.gstin) else b2c
        bucket["count"] += 1
        bucket["taxable"] += s * v.subtotal
        bucket["tax"] += s * (v.cgst + v.sgst + v.igst)
        bucket["total"] += s * v.total
        totals["taxable"] += s * v.subtotal
        totals["cgst"] += s * v.cgst
        totals["sgst"] += s * v.sgst
        totals["igst"] += s * v.igst
        totals["total"] += s * v.total
        bill_cost = 0.0
        for l in v.lines:
            rr = rate.setdefault(l.taxRate, {"rate": l.taxRate, "taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0})
            rr["taxable"] += s * l.taxable
            if v.interState:
                rr["igst"] += s * l.tax
            else:
                rr["cgst"] += (s * l.tax) / 2
                rr["sgst"] += (s * l.tax) / 2
            key = l.item.hsn or "—"
            hh = hsn.setdefault(key, {"hsn": key, "description": l.item.name, "qty": 0.0, "taxable": 0.0, "tax": 0.0})
            hh["qty"] += s * l.qty
            hh["taxable"] += s * l.taxable
            hh["tax"] += s * l.tax
            cost = s * l.qty * l.costRate
            bill_cost += cost
            it = by_item.setdefault(l.itemId, {"itemId": l.itemId, "name": l.item.name, "qty": 0.0, "sales": 0.0, "cost": 0.0, "profit": 0.0})
            it["qty"] += s * l.qty
            it["sales"] += s * l.taxable
            it["cost"] += cost
        pp = by_party.setdefault(party, {"party": party, "sales": 0.0, "cost": 0.0, "profit": 0.0})
        pp["sales"] += s * v.subtotal
        pp["cost"] += bill_cost
        by_bill.append(
            {"id": v.id, "number": v.number, "date": v.date, "party": party, "sales": r2(s * v.subtotal), "cost": r2(bill_cost),
             "profit": r2(s * v.subtotal - bill_cost)}
        )
        register.append(
            {"id": v.id, "date": v.date, "number": v.number, "kind": v.kind, "party": party,
             "gstin": v.party.gstin if v.party else "", "taxable": r2(s * v.subtotal), "cgst": r2(s * v.cgst),
             "sgst": r2(s * v.sgst), "igst": r2(s * v.igst), "total": r2(s * v.total)}
        )

    def finish(x: dict) -> dict:
        return _round_obj({**x, "profit": x["sales"] - x["cost"]})

    show_profit = side == "sales" and actor.can("costs.view")
    charts = _report_charts(rows)
    return {
        "charts": charts,
        "side": side, "from": from_, "to": to, "register": register,
        "byRate": [_round_obj(x) for x in sorted(rate.values(), key=lambda x: x["rate"])],
        "byHsn": [_round_obj(x) for x in sorted(hsn.values(), key=lambda x: (x["hsn"] != "—", x["hsn"].casefold(), x["hsn"]))],
        "b2b": _round_obj(b2b), "b2c": _round_obj(b2c), "totals": _round_obj(totals),
        "profit": {
            "total": r2(sum(b["profit"] for b in by_bill)),
            "byBill": by_bill,
            "byItem": sorted((finish(x) for x in by_item.values()), key=lambda x: -x["profit"]),
            "byParty": sorted((finish(x) for x in by_party.values()), key=lambda x: -x["profit"]),
        }
        if show_profit
        else None,
    }

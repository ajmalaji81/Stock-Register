"""Branch-to-branch invoices.

Chennai bills Puducherry as an ordinary sales invoice (GST differs, so it is not an internal transfer). The sale is PENDING until
Puducherry approves it; approval creates the matching purchase in Puducherry (same lines, rates, tax and IMEIs) and links the two.
Rejecting cancels the sale, which puts the stock and IMEIs back in the billing godown.

Each godown can carry its own state / GSTIN / address (blank = the business profile). A godown is also available as a "branch
party" (Party.linkedGodownId) so it can be picked as the customer / supplier.
"""
from __future__ import annotations

import json
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.orm import Session, selectinload

from ..core.engine import today_iso
from ..core.errors import StockError
from ..core.gst import godown_identity
from ..models import Godown, Party, User, Voucher, VoucherLine, now_utc
from ..schemas import VoucherCreateInput, VoucherLineInput
from .activity import iso, log_activity
from .actor import Actor, assert_can, assert_godown_access
from .stock import get_godown

PENDING, APPROVING, APPROVED, REJECTED, CANCELLED = "PENDING", "APPROVING", "APPROVED", "REJECTED", "CANCELLED"


# ---------- branch parties ----------


def _party_name(db: Session, account_id: str, godown: Godown, party_id: Optional[str]) -> str:
    base, name, n = f"{godown.name} (branch)", f"{godown.name} (branch)", 2
    while True:
        clash = db.execute(select(Party.id).where(Party.userId == account_id, Party.name == name)).scalars().first()
        if clash is None or clash == party_id:
            return name
        name, n = f"{godown.name} (branch {n})", n + 1


def ensure_branch_party(db: Session, account_id: str, godown: Godown) -> Party:
    """The party that stands for this godown. Found by linkedGodownId (never by name); kept in step with the godown."""
    owner = db.get(User, account_id)
    ident = godown_identity(godown, owner)
    p = db.execute(select(Party).where(Party.userId == account_id, Party.linkedGodownId == godown.id)).scalar_one_or_none()
    if p is None:
        p = Party(userId=account_id, name=_party_name(db, account_id, godown, None), type="BOTH", linkedGodownId=godown.id)
        db.add(p)
    else:
        p.name = _party_name(db, account_id, godown, p.id)
    p.state, p.gstin, p.address = ident["state"], ident["gstin"], ident["address"]
    db.flush()
    return p


def ensure_all(db: Session, account_id: str) -> None:
    """A branch party for every godown, but only for businesses that actually have more than one."""
    godowns = db.execute(select(Godown).where(Godown.userId == account_id)).scalars().all()
    if len(godowns) < 2:
        return
    for g in godowns:
        ensure_branch_party(db, account_id, g)


def check_supply(db: Session, account_id: str, src: Godown, dest_id: str, owner: User) -> Godown:
    """May `src` bill the godown `dest_id`? Only between different GST registrations; otherwise it's an internal transfer."""
    if dest_id == src.id:
        raise StockError("A godown can't be billed to itself")
    dest = get_godown(db, account_id, dest_id)
    a, b = godown_identity(src, owner), godown_identity(dest, owner)
    if not a["state"] or not b["state"]:
        raise StockError("Set the state of both godowns under Godowns first, so the right GST can be applied.")
    if (a["gstin"] and a["gstin"] == b["gstin"]) or (not a["gstin"] and not b["gstin"] and a["state"] == b["state"]):
        raise StockError(
            f"{src.name} and {dest.name} share the same GST registration. Moving stock between them is an internal transfer, not an invoice."
        )
    return dest


# ---------- approval ----------


def _elevated(actor: Actor) -> Actor:
    """Same person (for the audit log), but allowed to touch both godowns: the approver may belong to only the receiving one."""
    return Actor(
        account_id=actor.account_id, owner=actor.owner, actor_id=actor.actor_id, name=actor.name, email=actor.email,
        avatar=None, role=actor.role, is_owner=False, godown_ids=None, _can=lambda p: True,
    )


def _load_pending(db: Session, actor: Actor, sale_id: str) -> Voucher:
    assert_can(actor, "branch.approve")
    v = db.execute(
        select(Voucher).where(Voucher.id == sale_id, Voucher.userId == actor.account_id).options(selectinload(Voucher.lines))
    ).scalar_one_or_none()
    if v is None or v.kind != "SALE" or not v.branchGodownId:
        raise StockError("Invoice not found", 404)
    assert_godown_access(actor, v.branchGodownId)  # only people of the RECEIVING godown decide
    if v.status != "OPEN" or v.branchStatus != PENDING:
        raise StockError("This invoice was already handled or is no longer waiting for approval.", 409)
    return v


def _claim(db: Session, v: Voucher) -> None:
    """PENDING -> APPROVING in one guarded statement, so two quick clicks can't both go through."""
    res = db.execute(update(Voucher).where(Voucher.id == v.id, Voucher.branchStatus == PENDING).values(branchStatus=APPROVING))
    if res.rowcount != 1:
        raise StockError("This invoice was already handled.", 409)
    db.refresh(v)


def approve(db: Session, actor: Actor, sale_id: str) -> dict:
    from .vouchers import _create_in_tx  # late import: vouchers imports this module

    v = _load_pending(db, actor, sale_id)
    _claim(db, v)
    src, dest = v.godown, get_godown(db, actor.account_id, v.branchGodownId)
    supplier = ensure_branch_party(db, actor.account_id, src)
    inp = VoucherCreateInput(
        kind="PURCHASE", date=v.date, partyId=supplier.id, godownId=dest.id, gstEnabled=v.gstEnabled,
        notes=f"Auto-created from sales invoice {v.number} dated {v.date} of {src.name}; approved {today_iso()} by {actor.name}",
        lines=[
            VoucherLineInput(
                itemId=l.itemId, description=l.description, qty=l.qty, rate=l.rate, discountPct=l.discountPct,
                taxRate=l.taxRate, serials=json.loads(l.serials or "[]"),
            )
            for l in v.lines
        ],
    )
    sale_number, total = v.number, v.total
    pid = _create_in_tx(db, _elevated(actor), inp, system=True, extra={"linkedVoucherId": v.id})
    db.execute(
        update(Voucher).where(Voucher.id == v.id).values(
            branchStatus=APPROVED, branchVoucherId=pid, branchBy=actor.name, branchAt=now_utc()
        )
    )
    db.expire_all()
    pnum = db.get(Voucher, pid).number
    log_activity(db, actor, "branch.approve", f"{src.name} → {dest.name}: invoice {sale_number} approved, purchase {pnum} created")
    return {"saleId": sale_id, "saleNumber": sale_number, "purchaseId": pid, "purchaseNumber": pnum, "total": total}


def reject(db: Session, actor: Actor, sale_id: str) -> dict:
    from .vouchers import _cancel_in_tx

    v = _load_pending(db, actor, sale_id)
    _claim(db, v)
    number, src_name = v.number, v.godown.name
    dest_name = get_godown(db, actor.account_id, v.branchGodownId).name
    _cancel_in_tx(db, _elevated(actor), v, branch_status=REJECTED)
    db.execute(update(Voucher).where(Voucher.id == v.id).values(branchBy=actor.name, branchAt=now_utc()))
    db.expire_all()
    log_activity(db, actor, "branch.reject", f"{src_name} → {dest_name}: invoice {number} rejected, stock returned to {src_name}")
    return {"saleId": sale_id, "saleNumber": number}


def pending_for(db: Session, actor: Actor) -> list[dict]:
    """Invoices other godowns billed to the godowns this person belongs to, with what they need to check. Never shows costs."""
    assert_can(actor, "branch.approve")
    stmt = select(Voucher).where(
        Voucher.userId == actor.account_id, Voucher.kind == "SALE", Voucher.status == "OPEN", Voucher.branchStatus == PENDING
    )
    if actor.godown_ids is not None:
        stmt = stmt.where(Voucher.branchGodownId.in_(actor.godown_ids))
    rows = db.execute(
        stmt.options(selectinload(Voucher.godown), selectinload(Voucher.lines).selectinload(VoucherLine.item))
        .order_by(Voucher.date, Voucher.createdAt)
    ).scalars().all()
    names = {g.id: g.name for g in db.execute(select(Godown).where(Godown.userId == actor.account_id)).scalars()}
    out = []
    for v in rows:
        out.append({
            "id": v.id, "number": v.number, "date": v.date, "from": v.godown.name, "to": names.get(v.branchGodownId, "?"),
            "subtotal": v.subtotal, "cgst": v.cgst, "sgst": v.sgst, "igst": v.igst, "total": v.total, "interState": v.interState,
            "createdBy": v.createdBy, "createdAt": iso(v.createdAt),
            "lines": [
                {"item": l.item.name, "unit": l.item.unit, "qty": l.qty, "rate": l.rate, "discountPct": l.discountPct,
                 "taxRate": l.taxRate, "amount": l.amount, "serials": json.loads(l.serials or "[]")}
                for l in v.lines
            ],
        })
    return out


def pending_count(db: Session, actor: Actor) -> int:
    if not actor.can("branch.approve"):
        return 0
    return len(pending_for(db, actor))

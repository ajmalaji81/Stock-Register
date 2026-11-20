"""Server-side register. Every stock change goes through here, inside the caller's transaction.

Stock is changed with conditional atomic updates (`quantity >= qty` for removals), so two
requests at the same moment can never push a godown below zero.
Everything is scoped by `actor.account_id` (the owner's User.id); staff act on the owner's data.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.orm import Session

from ..core.engine import assert_can_remove, assert_within_limit, today_iso
from ..core.errors import StockError
from ..core.gst import godown_identity
from ..core.jsmath import round3
from ..core.plans import effective_plan, limits_for
from ..models import Godown, Item, LedgerEntry, Party, Stock, User, Voucher, VoucherLine
from ..schemas import ItemInput, MovementInput, TransferInput
from .activity import iso, log_activity
from .actor import Actor, actor_info, assert_godown_access, can_use_godown


def fmt_num(n: float) -> str:
    """Render numbers the way JavaScript template strings do (25 not 25.0)."""
    return str(int(n)) if float(n).is_integer() else repr(float(n))


def load_workspace(db: Session, actor: Actor) -> dict:
    uid = actor.account_id
    godowns = db.execute(select(Godown).where(Godown.userId == uid).order_by(Godown.createdAt, Godown.id)).scalars().all()
    items = db.execute(select(Item).where(Item.userId == uid).order_by(Item.name)).scalars().all()
    stocks: dict[str, list[Stock]] = {}
    if items:
        for s in db.execute(select(Stock).where(Stock.itemId.in_([i.id for i in items]))).scalars():
            stocks.setdefault(s.itemId, []).append(s)
    show_costs = actor.can("costs.view")
    owner = actor.owner
    return {
        "mode": "live",
        "actor": actor_info(actor),
        "user": {
            "name": owner.name, "email": owner.email, "plan": effective_plan(owner.plan, owner.trialEndsAt),
            "trialEndsAt": iso(owner.trialEndsAt) if owner.trialEndsAt else None,
        },
        "limits": limits_for(owner.plan, owner.trialEndsAt),
        "godowns": [
            {"id": g.id, "name": g.name, "state": godown_identity(g, owner)["state"], "gstin": g.gstin, "ownState": g.state, "address": g.address}
            for g in godowns if can_use_godown(actor, g.id)
        ],
        "items": [
            {
                "id": i.id, "name": i.name, "sku": i.sku, "category": i.category, "unit": i.unit,
                "purchasePrice": i.purchasePrice if show_costs else 0,
                "salePrice": i.salePrice, "minStockAlert": i.minStockAlert, "hsn": i.hsn, "gstRate": i.gstRate,
                "trackSerial": i.trackSerial,
                "stock": {s.godownId: round3(s.quantity) for s in stocks.get(i.id, []) if can_use_godown(actor, s.godownId)},
            }
            for i in items
        ],
    }


def get_item(db: Session, account_id: str, item_id: str) -> Item:
    item = db.execute(select(Item).where(Item.id == item_id, Item.userId == account_id)).scalar_one_or_none()
    if item is None:
        raise StockError("Item not found", 404)
    return item


def get_godown(db: Session, account_id: str, godown_id: str) -> Godown:
    g = db.execute(select(Godown).where(Godown.id == godown_id, Godown.userId == account_id)).scalar_one_or_none()
    if g is None:
        raise StockError("Godown not found", 404)
    return g


def _quantity(db: Session, item_id: str, godown_id: str) -> Optional[float]:
    return db.execute(select(Stock.quantity).where(Stock.itemId == item_id, Stock.godownId == godown_id)).scalar_one_or_none()


def stock_quantity(db: Session, item_id: str, godown_id: str) -> float:
    return _quantity(db, item_id, godown_id) or 0.0


def change_stock(db: Session, item: Item, godown: Godown, delta: float) -> tuple[float, float]:
    """Atomically add (delta > 0) or remove (delta < 0) stock; returns (godown balance, item total balance)."""
    where = (Stock.itemId == item.id, Stock.godownId == godown.id)
    if delta < 0:
        res = db.execute(update(Stock).where(*where, Stock.quantity >= -delta - 0.0005).values(quantity=Stock.quantity + delta))
        if res.rowcount == 0:
            assert_can_remove(_quantity(db, item.id, godown.id) or 0, -delta, item.name, godown.name)
            raise StockError("Stock changed, please try again", 409)
    else:
        res = db.execute(update(Stock).where(*where).values(quantity=Stock.quantity + delta))
        if res.rowcount == 0:
            db.execute(insert(Stock).values(itemId=item.id, godownId=godown.id, quantity=delta))
    # Keep stored quantities to 3 decimals so float noise never builds up.
    raw = _quantity(db, item.id, godown.id) or 0.0
    balance = max(0.0, round3(raw))
    if balance != raw:
        db.execute(update(Stock).where(*where).values(quantity=balance))
    total = db.execute(select(func.coalesce(func.sum(Stock.quantity), 0.0)).where(Stock.itemId == item.id)).scalar_one()
    return balance, round3(total)


@dataclass
class StockEntryInput:
    itemId: str
    godownId: str
    type: str  # IN / OUT for bills and manual entries, ADJUSTMENT for corrections, OPENING for opening stock
    qty: float  # positive for IN / OUT / OPENING; signed (non-zero) for ADJUSTMENT
    rate: float
    party: str
    remarks: str
    date: str
    refType: Optional[str] = None  # e.g. "VOUCHER" + voucher id when a bill moves stock
    refId: Optional[str] = None


def apply_stock_entry(db: Session, actor: Actor, e: StockEntryInput) -> tuple[float, float]:
    """THE way to change stock from other modules (bills, returns, adjustments).

    Checks the item/godown belong to the account and that the actor may use the godown;
    refuses to go below zero; writes the ledger entry. Call inside the request's transaction.
    """
    assert_godown_access(actor, e.godownId)
    item = get_item(db, actor.account_id, e.itemId)
    godown = get_godown(db, actor.account_id, e.godownId)
    qty = round3(e.qty)
    if qty == 0 or (e.type != "ADJUSTMENT" and qty < 0):
        raise StockError("Quantity must be more than 0")
    delta = -qty if e.type == "OUT" else qty
    balance, item_balance = change_stock(db, item, godown, delta)
    db.add(
        LedgerEntry(
            userId=actor.account_id, itemId=item.id, godownId=godown.id, type=e.type,
            qtyIn=abs(qty) if delta > 0 else 0, qtyOut=abs(qty) if delta < 0 else 0,
            balance=balance, itemBalance=item_balance, rate=e.rate, party=e.party, remarks=e.remarks, date=e.date,
            refType=e.refType, refId=e.refId, actorName=actor.name,
        )
    )
    db.flush()
    return balance, item_balance


def _count(db: Session, model, *where) -> int:
    return db.execute(select(func.count()).select_from(model).where(*where)).scalar_one()


def create_item(db: Session, actor: Actor, inp: ItemInput) -> None:
    uid = actor.account_id
    owner = actor.owner
    assert_within_limit(_count(db, Item, Item.userId == uid), limits_for(owner.plan, owner.trialEndsAt)["maxItems"], "items")
    item = Item(
        userId=uid, name=inp.name, sku=inp.sku, category=inp.category, unit=inp.unit,
        purchasePrice=inp.purchasePrice, salePrice=inp.salePrice, minStockAlert=inp.minStockAlert,
        hsn=inp.hsn, gstRate=inp.gstRate, trackSerial=inp.trackSerial,
    )
    db.add(item)
    db.flush()
    godowns = db.execute(select(Godown).where(Godown.userId == uid).order_by(Godown.createdAt, Godown.id)).scalars().all()
    if godowns:
        db.execute(insert(Stock), [{"itemId": item.id, "godownId": g.id, "quantity": 0} for g in godowns])
    qty = round3(inp.openingQty or 0)
    if qty > 0 and inp.trackSerial:
        raise StockError("Items tracked by IMEI can't have an opening quantity. Stock them with a purchase bill so each IMEI is recorded.")
    if qty > 0:
        apply_stock_entry(
            db, actor,
            StockEntryInput(
                itemId=item.id, godownId=inp.openingGodownId or (godowns[0].id if godowns else ""), type="OPENING",
                qty=qty, rate=inp.purchasePrice, party="Opening stock", remarks="", date=today_iso(),
            ),
        )
    log_activity(db, actor, "item.create", f"{item.name} ({item.sku})" + (f", opening {fmt_num(qty)} {item.unit}" if qty > 0 else ""))


def update_item(db: Session, actor: Actor, item_id: str, inp: ItemInput) -> None:
    item = db.execute(select(Item).where(Item.id == item_id, Item.userId == actor.account_id)).scalar_one_or_none()
    if item is None:
        raise StockError("Item not found", 404)
    keep_cost = not actor.can("costs.view")  # staff who can't see costs can't change them either
    item.name, item.sku, item.category, item.unit = inp.name, inp.sku, inp.category, inp.unit
    if not keep_cost:
        item.purchasePrice = inp.purchasePrice
    item.salePrice, item.minStockAlert, item.hsn, item.gstRate = inp.salePrice, inp.minStockAlert, inp.hsn, inp.gstRate
    item.trackSerial = inp.trackSerial
    db.flush()
    log_activity(db, actor, "item.update", f"{inp.name} ({inp.sku})")


def delete_item(db: Session, actor: Actor, item_id: str) -> None:
    item = db.execute(select(Item).where(Item.id == item_id, Item.userId == actor.account_id)).scalar_one_or_none()
    if item is None:
        raise StockError("Item not found", 404)
    if _count(db, VoucherLine, VoucherLine.itemId == item_id):
        raise StockError("This item is used on bills or documents, so it can't be deleted.", 409)
    name, sku = item.name, item.sku
    db.execute(delete(LedgerEntry).where(LedgerEntry.itemId == item_id))
    db.execute(delete(Stock).where(Stock.itemId == item_id))
    db.execute(delete(Item).where(Item.id == item_id))
    db.expire_all()
    log_activity(db, actor, "item.delete", f"{name} ({sku})")


def record_movement(db: Session, actor: Actor, inp: MovementInput) -> None:
    if get_item(db, actor.account_id, inp.itemId).trackSerial:
        raise StockError("This item is tracked by IMEI. Use a purchase or sales bill (or a transfer) so each IMEI is recorded.")
    apply_stock_entry(
        db, actor,
        StockEntryInput(
            itemId=inp.itemId, godownId=inp.godownId, type=inp.type, qty=inp.qty, rate=inp.rate,
            party=inp.party, remarks=inp.remarks, date=inp.date,
        ),
    )
    item = get_item(db, actor.account_id, inp.itemId)
    log_activity(db, actor, f"stock.{inp.type.lower()}", f"{item.name}: {fmt_num(inp.qty)} {item.unit}" + (f", {inp.party}" if inp.party else ""))


def transfer_stock(db: Session, actor: Actor, inp: TransferInput) -> None:
    if inp.fromGodownId == inp.toGodownId:
        raise StockError("Choose two different godowns")
    assert_godown_access(actor, inp.fromGodownId)
    assert_godown_access(actor, inp.toGodownId)
    uid = actor.account_id
    item = get_item(db, uid, inp.itemId)
    src = get_godown(db, uid, inp.fromGodownId)
    dst = get_godown(db, uid, inp.toGodownId)
    qty = round3(inp.qty)
    if item.trackSerial:
        if qty != int(qty) or len(inp.serials) != int(qty):
            raise StockError(f"{item.name}: enter exactly {int(qty)} IMEI number(s) to transfer; you entered {len(inp.serials)}")
        from . import serials as serial_svc

        serial_svc.transfer_units(db, actor, item, inp.serials, src, dst, inp.date, inp.remarks)
    transfer_id = str(uuid.uuid4())
    # Move both sides first so each entry records the item total after the whole transfer.
    out_balance, _ = change_stock(db, item, src, -qty)
    in_balance, item_balance = change_stock(db, item, dst, qty)
    db.add(
        LedgerEntry(
            userId=uid, itemId=item.id, godownId=src.id, type="TRANSFER_OUT", qtyOut=qty, balance=out_balance,
            itemBalance=item_balance, rate=item.purchasePrice, party=f"To {dst.name}", remarks=inp.remarks,
            date=inp.date, transferId=transfer_id, actorName=actor.name,
        )
    )
    db.add(
        LedgerEntry(
            userId=uid, itemId=item.id, godownId=dst.id, type="TRANSFER_IN", qtyIn=qty, balance=in_balance,
            itemBalance=item_balance, rate=item.purchasePrice, party=f"From {src.name}", remarks=inp.remarks,
            date=inp.date, transferId=transfer_id, actorName=actor.name,
        )
    )
    db.flush()
    log_activity(db, actor, "stock.transfer", f"{item.name}: {fmt_num(qty)} {item.unit} {src.name} → {dst.name}")


def create_godown(db: Session, actor: Actor, name: str) -> None:
    uid = actor.account_id
    owner = actor.owner
    assert_within_limit(_count(db, Godown, Godown.userId == uid), limits_for(owner.plan, owner.trialEndsAt)["maxGodowns"], "godowns")
    g = Godown(userId=uid, name=name)
    db.add(g)
    db.flush()
    item_ids = db.execute(select(Item.id).where(Item.userId == uid)).scalars().all()
    if item_ids:
        db.execute(insert(Stock), [{"itemId": i, "godownId": g.id, "quantity": 0} for i in item_ids])
    from . import branch as branch_svc

    branch_svc.ensure_all(db, uid)
    log_activity(db, actor, "godown.create", name)


def rename_godown(db: Session, actor: Actor, godown_id: str, name: str) -> None:
    res = db.execute(update(Godown).where(Godown.id == godown_id, Godown.userId == actor.account_id).values(name=name))
    if res.rowcount == 0:
        raise StockError("Godown not found", 404)
    log_activity(db, actor, "godown.rename", name)


def update_godown(db: Session, actor: Actor, godown_id: str, inp) -> None:
    """Name plus the GST identity (state, GSTIN, address) this godown bills under."""
    from . import branch as branch_svc

    g = get_godown(db, actor.account_id, godown_id)
    g.name = inp.name
    for k in ("state", "gstin", "address"):  # only what was sent: a plain rename must not wipe the GST details
        if k in inp.model_fields_set:
            setattr(g, k, getattr(inp, k))
    db.flush()
    branch_svc.ensure_all(db, actor.account_id)  # branch parties follow the godowns' names, states and GSTINs
    log_activity(db, actor, "godown.update", f"{g.name} · {g.state or 'business state'} · {g.gstin or 'no GSTIN'}")


def delete_godown(db: Session, actor: Actor, godown_id: str) -> None:
    uid = actor.account_id
    g = get_godown(db, uid, godown_id)
    if _count(db, Godown, Godown.userId == uid) <= 1:
        raise StockError("You need at least one godown")
    if _count(db, LedgerEntry, LedgerEntry.userId == uid, LedgerEntry.godownId == godown_id) or _count(
        db, Voucher, Voucher.userId == uid, Voucher.godownId == godown_id
    ):
        raise StockError("This godown has ledger entries or bills. Godowns with history can't be deleted.", 409)
    name = g.name
    db.execute(delete(Stock).where(Stock.godownId == godown_id))
    db.execute(delete(Godown).where(Godown.id == godown_id))
    db.expire_all()
    log_activity(db, actor, "godown.delete", name)


LEDGER_MAX = 2000


def list_ledger(db: Session, actor: Actor, f: dict) -> list[dict]:
    godown_id = f.get("godownId")
    if godown_id and godown_id != "ALL":
        assert_godown_access(actor, godown_id)
    q = select(LedgerEntry).where(LedgerEntry.userId == actor.account_id)
    if f.get("itemId"):
        q = q.where(LedgerEntry.itemId == f["itemId"])
    if godown_id and godown_id != "ALL":
        q = q.where(LedgerEntry.godownId == godown_id)
    elif actor.godown_ids is not None:
        q = q.where(LedgerEntry.godownId.in_(actor.godown_ids))
    if f.get("type"):
        q = q.where(LedgerEntry.type == f["type"])
    if f.get("from"):
        q = q.where(LedgerEntry.date >= f["from"])
    if f.get("to"):
        q = q.where(LedgerEntry.date <= f["to"])
    rows = db.execute(q.order_by(LedgerEntry.createdAt.desc(), LedgerEntry.id.desc()).limit(LEDGER_MAX)).scalars().all()
    show_costs = actor.can("costs.view")
    out = []
    for r in reversed(rows):
        out.append(
            {
                "id": r.id, "itemId": r.itemId, "itemName": r.item.name, "unit": r.item.unit,
                "godownId": r.godownId, "godownName": r.godown.name, "type": r.type,
                "qtyIn": r.qtyIn, "qtyOut": r.qtyOut, "balance": r.balance, "itemBalance": r.itemBalance,
                # Purchase-side rates are costs; hide them from roles that can't see costs.
                "rate": r.rate if show_costs or r.type == "OUT" else 0,
                "party": r.party, "remarks": r.remarks, "date": r.date, "createdAt": iso(r.createdAt),
                "transferId": r.transferId, "refType": r.refType, "refId": r.refId, "actorName": r.actorName,
            }
        )
    return out


def get_owner(db: Session, account_id: str) -> User:
    owner = db.get(User, account_id)
    if owner is None:
        raise StockError("Account not found", 404)
    return owner

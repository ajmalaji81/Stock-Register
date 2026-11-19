"""IMEI / serial-number tracking: one SerialUnit per phone, one SerialEvent per thing that happened to it.

Invariant: for an item with trackSerial, the number of IN_STOCK units in a godown equals its Stock.quantity there.
Every stock movement of a tracked item therefore has to name its units (bills and transfers do; manual IN/OUT is refused).
A unit's status and godown are just the result of its latest non-voided event, so undoing a bill (edit / cancel)
voids its events and recomputes the unit.
"""
from __future__ import annotations

import re
from datetime import timedelta
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..core.errors import StockError
from ..models import Godown, Item, SerialEvent, SerialUnit, Stock, now_utc
from .actor import Actor, can_use_godown

SERIAL_KINDS = ("SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN")
TOKEN_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-]{6,19}$")
STATUS_LABEL = {"IN_STOCK": "In stock", "SOLD": "Sold", "RETURNED": "Returned to supplier", "VOID": "Cancelled"}
EVENT_LABEL = {
    "PURCHASE": "Purchased", "TRANSFER": "Transferred", "SALE": "Sold", "SALE_RETURN": "Sale returned",
    "PURCHASE_RETURN": "Returned to supplier",
}


def luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def parse_token(tok: str) -> tuple[str, str]:
    """'IMEI' or 'IMEI1/IMEI2' (dual SIM) -> (imei, imei2). A 15-digit number must pass the IMEI check digit."""
    parts = tok.strip().upper().split("/")
    if len(parts) > 2 or not all(parts):
        raise StockError(f"'{tok}' isn't a valid IMEI. For a dual-SIM phone write IMEI1/IMEI2.")
    for p in parts:
        if not TOKEN_RE.match(p):
            raise StockError(f"'{p}' isn't a valid IMEI / serial number (7-20 letters or digits).")
        if p.isdigit() and len(p) == 15 and not luhn_ok(p):
            raise StockError(f"IMEI {p} has a wrong check digit. Please re-check the number.")
    return parts[0], parts[1] if len(parts) == 2 else ""


def prepare_lines(lines: list, items: dict, kind: str, source_id: Optional[str]) -> list[list[str]]:
    """Validate the IMEIs typed on each bill line. Returns the tokens to store per line ([] for untracked lines)."""
    tracked_any = any(items[l.itemId].trackSerial for l, _ in lines)
    if tracked_any and kind == "CHALLAN":
        raise StockError("Phones with IMEI tracking can't go on a delivery challan. Bill them as a sale so the IMEIs are recorded.")
    if tracked_any and source_id and kind in ("SALE", "PURCHASE"):
        raise StockError("Phones with IMEI tracking can't be converted from another document. Create the bill directly and enter the IMEIs.")
    out: list[list[str]] = []
    seen: set[str] = set()
    for l, qty in lines:
        item = items[l.itemId]
        if kind not in SERIAL_KINDS or not item.trackSerial:
            out.append([])
            continue
        if qty != int(qty):
            raise StockError(f"{item.name}: quantity must be a whole number because it is tracked by IMEI")
        tokens = list(l.serials)
        if len(tokens) != int(qty):
            raise StockError(f"{item.name}: enter exactly {int(qty)} IMEI number(s); you entered {len(tokens)}")
        for t in tokens:
            imei, imei2 = parse_token(t)
            for x in filter(None, (imei, imei2)):
                if x in seen:
                    raise StockError(f"IMEI {x} is entered twice on this bill")
                seen.add(x)
        out.append([t.strip().upper() for t in tokens])
    return out


# ---------- unit state ----------


def _godown_names(db: Session, account_id: str) -> dict[str, str]:
    return {g.id: g.name for g in db.execute(select(Godown).where(Godown.userId == account_id)).scalars()}


def find_unit(db: Session, account_id: str, imei: str) -> Optional[SerialUnit]:
    return db.execute(
        select(SerialUnit).where(SerialUnit.userId == account_id, or_(SerialUnit.imei == imei, SerialUnit.imei2 == imei))
        .options(selectinload(SerialUnit.events))
    ).scalars().first()


def active(unit: SerialUnit) -> list[SerialEvent]:
    return [e for e in unit.events if not e.voided]


def refresh(unit: SerialUnit) -> None:
    ev = active(unit)
    if not ev:
        unit.status, unit.godownId = "VOID", ""
        return
    last = ev[-1]
    if last.type in ("PURCHASE", "SALE_RETURN", "TRANSFER"):
        unit.status, unit.godownId = "IN_STOCK", last.toGodownId
    elif last.type == "SALE":
        unit.status, unit.godownId = "SOLD", last.fromGodownId
    else:  # PURCHASE_RETURN
        unit.status, unit.godownId = "RETURNED", ""


def _add_event(db: Session, actor: Actor, unit: SerialUnit, type_: str, date: str, **kw) -> SerialEvent:
    created = now_utc()
    if unit.events and unit.events[-1].createdAt >= created:  # keep events strictly ordered, even within a millisecond
        created = unit.events[-1].createdAt + timedelta(milliseconds=1)
    e = SerialEvent(serialId=unit.id, type=type_, date=date, actorName=actor.name, createdAt=created, **kw)
    unit.events.append(e)
    db.flush()
    refresh(unit)
    return e


def _where(unit: SerialUnit, names: dict[str, str]) -> str:
    if unit.status == "IN_STOCK":
        return f"in stock at {names.get(unit.godownId, '?')}"
    if unit.status == "SOLD":
        return "already sold"
    return "not in stock"


# ---------- recording ----------


def record_units(db: Session, actor: Actor, v, kind: str, entries: list[tuple], party_name: str) -> None:
    """Apply a bill to its units. entries = [(item, token, rate)]. Raises StockError when a unit isn't where the bill says."""
    uid = actor.account_id
    names = _godown_names(db, uid)
    here = names.get(v.godownId, "this godown")
    for item, tok, rate in entries:
        imei, imei2 = parse_token(tok)
        unit = find_unit(db, uid, imei)
        common = dict(voucherId=v.id, voucherNumber=v.number, partyName=party_name, rate=rate)
        if kind == "PURCHASE":
            if unit is None:
                unit = SerialUnit(userId=uid, itemId=item.id, imei=imei, imei2=imei2, status="VOID", godownId="")
                db.add(unit)
                db.flush()
            elif unit.itemId != item.id:
                raise StockError(f"IMEI {imei} is already registered for a different item")
            elif unit.status == "IN_STOCK":
                raise StockError(f"IMEI {imei} is already in stock at {names.get(unit.godownId, '?')}")
            if imei2 and not unit.imei2:
                unit.imei2 = imei2
            _add_event(db, actor, unit, "PURCHASE", v.date, toGodownId=v.godownId, **common)
            continue
        if unit is None:
            raise StockError(f"IMEI {imei} isn't in your IMEI register. Record its purchase first.")
        if unit.itemId != item.id:
            raise StockError(f"IMEI {imei} belongs to a different item than {item.name}")
        if kind == "SALE":
            if unit.status != "IN_STOCK":
                raise StockError(f"IMEI {imei} can't be sold: it is {_where(unit, names)}")
            if unit.godownId != v.godownId:
                raise StockError(f"IMEI {imei} is at {names.get(unit.godownId, '?')}, not at {here}. Transfer it to {here} first.")
            _add_event(db, actor, unit, "SALE", v.date, fromGodownId=v.godownId, **common)
        elif kind == "SALE_RETURN":
            if unit.status != "SOLD":
                raise StockError(f"IMEI {imei} can't be returned: it is {_where(unit, names)}")
            _add_event(db, actor, unit, "SALE_RETURN", v.date, toGodownId=v.godownId, **common)
        elif kind == "PURCHASE_RETURN":
            if unit.status != "IN_STOCK" or unit.godownId != v.godownId:
                raise StockError(f"IMEI {imei} can't be returned to the supplier from {here}: it is {_where(unit, names)}")
            _add_event(db, actor, unit, "PURCHASE_RETURN", v.date, fromGodownId=v.godownId, **common)


def void_voucher(db: Session, account_id: str, voucher_id: str) -> None:
    """Undo a bill's unit events (edit or cancel). Refuses if a unit has moved on since, naming the unit."""
    events = db.execute(
        select(SerialEvent).join(SerialUnit, SerialUnit.id == SerialEvent.serialId)
        .where(SerialUnit.userId == account_id, SerialEvent.voucherId == voucher_id, SerialEvent.voided.is_(False))
    ).scalars().all()
    names = _godown_names(db, account_id)
    for e in events:
        unit = db.execute(select(SerialUnit).where(SerialUnit.id == e.serialId).options(selectinload(SerialUnit.events))).scalar_one()
        act = active(unit)
        if act and act[-1].id != e.id:
            raise StockError(
                f"IMEI {unit.imei} has moved since this bill ({EVENT_LABEL[act[-1].type].lower()} on {act[-1].date}, "
                f"{_where(unit, names)}). Undo that first."
            )
        e.voided = True
        refresh(unit)
    db.flush()


def transfer_units(db: Session, actor: Actor, item: Item, tokens: list[str], src: Godown, dst: Godown, date: str, note: str) -> None:
    """Move named units between godowns (called with the stock transfer, so counts stay equal)."""
    uid = actor.account_id
    names = _godown_names(db, uid)
    seen: set[str] = set()
    for tok in tokens:
        imei, _ = parse_token(tok)
        if imei in seen:
            raise StockError(f"IMEI {imei} is entered twice")
        seen.add(imei)
        unit = find_unit(db, uid, imei)
        if unit is None or unit.itemId != item.id:
            raise StockError(f"IMEI {imei} isn't registered for {item.name}")
        if unit.status != "IN_STOCK" or unit.godownId != src.id:
            raise StockError(f"IMEI {imei} is not at {src.name}: it is {_where(unit, names)}")
        _add_event(db, actor, unit, "TRANSFER", date, fromGodownId=src.id, toGodownId=dst.id, note=note)


# ---------- queries ----------


def _origin_and_last_sale(unit: SerialUnit, names: dict[str, str], show_cost: bool) -> tuple[Optional[dict], Optional[dict]]:
    act = active(unit)
    purchase = next((e for e in act if e.type == "PURCHASE"), None)
    sale = next((e for e in reversed(act) if e.type == "SALE"), None)

    def dto(e: Optional[SerialEvent], hide_rate: bool) -> Optional[dict]:
        if e is None:
            return None
        return {"date": e.date, "party": e.partyName, "number": e.voucherNumber, "voucherId": e.voucherId,
                "godown": names.get(e.toGodownId or e.fromGodownId, ""), "rate": None if hide_rate else e.rate}

    return dto(purchase, not show_cost), dto(sale, False)


def search(db: Session, actor: Actor, q: str = "", item_id: str = "", godown_id: str = "", status: str = "", limit: int = 300) -> list[dict]:
    uid = actor.account_id
    stmt = select(SerialUnit).where(SerialUnit.userId == uid, SerialUnit.status != "VOID")
    q = q.strip().upper()
    if q:
        stmt = stmt.where(or_(SerialUnit.imei.contains(q, autoescape=True), SerialUnit.imei2.contains(q, autoescape=True)))
    if item_id:
        stmt = stmt.where(SerialUnit.itemId == item_id)
    if godown_id:
        stmt = stmt.where(SerialUnit.godownId == godown_id)
    if status:
        stmt = stmt.where(SerialUnit.status == status)
    units = db.execute(stmt.options(selectinload(SerialUnit.events)).order_by(SerialUnit.createdAt.desc(), SerialUnit.id).limit(limit * 2)).scalars().all()
    names = _godown_names(db, uid)
    item_names = {i.id: i.name for i in db.execute(select(Item).where(Item.userId == uid)).scalars()}
    show_cost = actor.can("costs.view")
    rows = []
    for u in units:
        if u.godownId and not can_use_godown(actor, u.godownId):
            continue
        origin, last_sale = _origin_and_last_sale(u, names, show_cost)
        rows.append({
            "imei": u.imei, "imei2": u.imei2, "itemId": u.itemId, "item": item_names.get(u.itemId, "?"), "status": u.status,
            "statusLabel": STATUS_LABEL[u.status], "godown": names.get(u.godownId, "—"), "origin": origin, "lastSale": last_sale,
            "moves": sum(1 for e in active(u) if e.type == "TRANSFER"),
        })
    return rows[:limit]


def history(db: Session, actor: Actor, imei: str) -> dict:
    unit = find_unit(db, actor.account_id, imei.strip().upper())
    if unit is None or (unit.godownId and not can_use_godown(actor, unit.godownId)):
        raise StockError("IMEI not found", 404)
    names = _godown_names(db, actor.account_id)
    item = db.get(Item, unit.itemId)
    show_cost = actor.can("costs.view")
    origin, last_sale = _origin_and_last_sale(unit, names, show_cost)
    events = [
        {"type": e.type, "label": EVENT_LABEL[e.type], "date": e.date, "from": names.get(e.fromGodownId, ""),
         "to": names.get(e.toGodownId, ""), "party": e.partyName, "number": e.voucherNumber, "voucherId": e.voucherId,
         "rate": None if (e.type.startswith("PURCHASE") and not show_cost) else e.rate, "note": e.note, "by": e.actorName,
         "voided": e.voided}
        for e in unit.events
    ]
    return {"imei": unit.imei, "imei2": unit.imei2, "item": item.name if item else "?", "itemId": unit.itemId,
            "status": unit.status, "statusLabel": STATUS_LABEL[unit.status], "godown": names.get(unit.godownId, "—"),
            "origin": origin, "lastSale": last_sale, "events": events}


def reconcile(db: Session, actor: Actor) -> list[dict]:
    """Tracked items whose stock quantity differs from the number of IN_STOCK units, per godown."""
    uid = actor.account_id
    names = _godown_names(db, uid)
    tracked = {i.id: i.name for i in db.execute(select(Item).where(Item.userId == uid, Item.trackSerial.is_(True))).scalars()}
    if not tracked:
        return []
    counts = {
        (r.itemId, r.godownId): r.n
        for r in db.execute(
            select(SerialUnit.itemId, SerialUnit.godownId, func.count().label("n"))
            .where(SerialUnit.userId == uid, SerialUnit.status == "IN_STOCK").group_by(SerialUnit.itemId, SerialUnit.godownId)
        )
    }
    out = []
    for s in db.execute(select(Stock).where(Stock.itemId.in_(list(tracked)))).scalars():
        if not can_use_godown(actor, s.godownId):
            continue
        n = counts.get((s.itemId, s.godownId), 0)
        if round(s.quantity) != n or s.quantity != int(s.quantity):
            out.append({"item": tracked[s.itemId], "godown": names.get(s.godownId, "?"), "stock": s.quantity, "units": n})
    return out


def with_check_digit(base14: str) -> str:
    """Complete a 14-digit body into a valid 15-digit IMEI (used by the demo seeder and tests)."""
    for d in range(10):
        if luhn_ok(base14 + str(d)):
            return base14 + str(d)
    raise ValueError("unreachable")


# ---------- picking units on a sales bill ----------


def _sellable(unit: SerialUnit, godown_id: str, voucher_id: str) -> bool:
    """In stock at this godown, or already on the bill being edited (editing undoes its sale first)."""
    if unit.status == "IN_STOCK" and unit.godownId == godown_id:
        return True
    ev = active(unit)
    return bool(voucher_id and unit.status == "SOLD" and ev and ev[-1].type == "SALE" and ev[-1].voucherId == voucher_id
                and unit.godownId == godown_id)


def available(db: Session, actor: Actor, item_id: str, godown_id: str, voucher_id: str = "", q: str = "", limit: int = 500) -> list[dict]:
    """IMEIs of one model that can go on a sale from this godown (for the 'pick from stock' list)."""
    if not can_use_godown(actor, godown_id):
        return []
    stmt = select(SerialUnit).where(
        SerialUnit.userId == actor.account_id, SerialUnit.itemId == item_id, SerialUnit.godownId == godown_id,
        SerialUnit.status.in_(("IN_STOCK", "SOLD")),
    )
    q = q.strip().upper()
    if q:
        stmt = stmt.where(or_(SerialUnit.imei.contains(q, autoescape=True), SerialUnit.imei2.contains(q, autoescape=True)))
    units = db.execute(stmt.options(selectinload(SerialUnit.events)).order_by(SerialUnit.createdAt, SerialUnit.id)).scalars().all()
    return [{"imei": u.imei, "imei2": u.imei2} for u in units if _sellable(u, godown_id, voucher_id)][:limit]


def find_for_sale(db: Session, actor: Actor, code: str, godown_id: str, voucher_id: str = "") -> dict:
    """POS scan: IMEI (either SIM) -> the model it belongs to, if it can be sold from this godown."""
    code = code.strip().upper()
    if not code:
        raise StockError("Scan or type an IMEI")
    unit = find_unit(db, actor.account_id, code)
    if unit is None or unit.status == "VOID":
        raise StockError(f"IMEI {code} isn't in your IMEI register")
    item = db.get(Item, unit.itemId)
    if item is None or item.userId != actor.account_id:
        raise StockError(f"IMEI {code} isn't in your IMEI register")
    names = _godown_names(db, actor.account_id)
    if not _sellable(unit, godown_id, voucher_id):
        if unit.status == "IN_STOCK":
            raise StockError(f"{item.name} {unit.imei} is at {names.get(unit.godownId, '?')}, not at {names.get(godown_id, 'this godown')}. Transfer it first.")
        raise StockError(f"{item.name} {unit.imei} can't be sold: {_where(unit, names)}")
    return {"itemId": item.id, "name": item.name, "imei": unit.imei, "imei2": unit.imei2}

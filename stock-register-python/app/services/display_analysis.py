"""Read-only stock, sales / purchase and IMEI reports for the Display menu.

Every query is scoped by actor.account_id and by the godowns the actor may use. Nothing here writes.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..core.engine import is_low_stock, qty_in_scope
from ..core.errors import StockError
from ..core.jsmath import r2, round3
from ..models import Item, LedgerEntry, SerialUnit, Stock, Voucher, VoucherLine
from . import serials as serial_svc
from . import stock as stock_svc
from .actor import Actor, assert_can, assert_godown_access, can_use_godown

UNGROUPED = "Ungrouped"
BY_CHOICES = ("item", "party", "month", "group")
BY_LABEL = {"item": "Item", "party": "Party", "month": "Month", "group": "Item group"}


def _scope_godown(actor: Actor, godown: str) -> str:
    """The godown filter after checking access ('' = all the actor's godowns)."""
    if godown:
        assert_godown_access(actor, godown)
    return godown or ""


def _need_any(actor: Actor, *perms: str) -> None:
    if not any(actor.can(p) for p in perms):
        assert_can(actor, perms[0])


# ---------------- 1. stock status ----------------


def stock_status(db: Session, actor: Actor, godown: str = "", q: str = "", low_only: bool = False) -> dict:
    """Current stock per item (all the actor's godowns, or one), grouped by item group."""
    _need_any(actor, "reports.view", "stock.move")
    godown = _scope_godown(actor, godown)
    ws = stock_svc.load_workspace(db, actor)  # purchase prices are already zeroed without costs.view
    costs = actor.can("costs.view")
    scope = godown or "ALL"
    ql = q.strip().lower()
    groups: dict[str, dict] = {}
    n_out = n_low = 0
    total_value = 0.0
    for it in ws["items"]:
        if ql and ql not in it["name"].lower() and ql not in it["sku"].lower() and ql not in (it["category"] or "").lower():
            continue
        qty = qty_in_scope(it["stock"], scope)
        low = is_low_stock(it["stock"], it["minStockAlert"], scope)
        status = "OUT" if qty <= 0 else ("LOW" if low else "OK")
        if low_only and status == "OK":
            continue
        value = r2(qty * it["purchasePrice"]) if costs else None
        row = {"id": it["id"], "name": it["name"], "sku": it["sku"], "unit": it["unit"], "qty": qty, "min": it["minStockAlert"],
               "status": status, "value": value, "trackSerial": it["trackSerial"]}
        g = groups.setdefault(it["category"] or UNGROUPED, {"name": it["category"] or UNGROUPED, "rows": [], "value": 0.0})
        g["rows"].append(row)
        if value is not None:
            g["value"] = r2(g["value"] + value)
            total_value += value
        n_out += status == "OUT"
        n_low += status == "LOW"
    out = sorted(groups.values(), key=lambda g: (g["name"] == UNGROUPED, g["name"].lower()))
    return {"groups": out, "godowns": ws["godowns"], "godown": godown, "costs": costs, "q": q, "lowOnly": low_only,
            "items": sum(len(g["rows"]) for g in out), "out": n_out, "low": n_low, "value": r2(total_value) if costs else None}


# ---------------- 2. inventory summary ----------------


def inventory_summary(db: Session, actor: Actor, frm: str, to: str, godown: str = "", q: str = "") -> dict:
    """Opening, inward, outward, transfers, adjustments and closing quantity per item for the period (from the stock ledger)."""
    _need_any(actor, "reports.view", "stock.move")
    godown = _scope_godown(actor, godown)
    costs = actor.can("costs.view")
    uid = actor.account_id
    stmt = (
        select(LedgerEntry.itemId, LedgerEntry.type, LedgerEntry.date < frm if frm else LedgerEntry.date < "", func.sum(LedgerEntry.qtyIn),
               func.sum(LedgerEntry.qtyOut))
        .where(LedgerEntry.userId == uid)
        .group_by(LedgerEntry.itemId, LedgerEntry.type, LedgerEntry.date < frm if frm else LedgerEntry.date < "")
    )
    if to:
        stmt = stmt.where(LedgerEntry.date <= to)
    if godown:
        stmt = stmt.where(LedgerEntry.godownId == godown)
    elif actor.godown_ids is not None:
        stmt = stmt.where(LedgerEntry.godownId.in_(actor.godown_ids))
    parts: dict[str, dict[str, float]] = {}
    for item_id, typ, before, q_in, q_out in db.execute(stmt).all():
        p = parts.setdefault(item_id, {"opening": 0.0, "inward": 0.0, "outward": 0.0, "tin": 0.0, "tout": 0.0, "adj": 0.0})
        q_in, q_out = q_in or 0.0, q_out or 0.0
        if before:  # everything before the period folds into the opening balance
            p["opening"] += q_in - q_out
        elif typ in ("IN", "OPENING"):
            p["inward"] += q_in
            p["outward"] += q_out
        elif typ == "OUT":
            p["outward"] += q_out
            p["inward"] += q_in
        elif typ == "TRANSFER_IN":
            p["tin"] += q_in
        elif typ == "TRANSFER_OUT":
            p["tout"] += q_out
        else:  # ADJUSTMENT
            p["adj"] += q_in - q_out
    items = {i.id: i for i in db.execute(select(Item).where(Item.userId == uid)).scalars()}
    ql = q.strip().lower()
    rows = []
    for item_id, p in parts.items():
        it = items.get(item_id)
        if it is None or (ql and ql not in it.name.lower() and ql not in it.sku.lower() and ql not in (it.category or "").lower()):
            continue
        closing = round3(p["opening"] + p["inward"] - p["outward"] + p["tin"] - p["tout"] + p["adj"])
        r = {"id": it.id, "name": it.name, "sku": it.sku, "unit": it.unit, "group": it.category or UNGROUPED,
             "opening": round3(p["opening"]), "inward": round3(p["inward"]), "outward": round3(p["outward"]),
             "tin": round3(p["tin"]), "tout": round3(p["tout"]), "adj": round3(p["adj"]), "closing": closing,
             "value": r2(closing * it.purchasePrice) if costs else None}
        if any(r[k] for k in ("opening", "inward", "outward", "tin", "tout", "adj", "closing")):
            rows.append(r)
    rows.sort(key=lambda r: r["name"].lower())
    tot = {k: round3(sum(r[k] for r in rows)) for k in ("opening", "inward", "outward", "tin", "tout", "adj", "closing")}
    tot["value"] = r2(sum(r["value"] for r in rows)) if costs else None
    godowns = [{"id": g["id"], "name": g["name"]} for g in stock_svc.load_workspace(db, actor)["godowns"]]
    return {"rows": rows, "totals": tot, "godowns": godowns, "godown": godown, "from": frm, "to": to, "costs": costs, "q": q}


# ---------------- 3. sales / purchase analysis ----------------


def trade_analysis(db: Session, actor: Actor, side: str, by: str, frm: str, to: str, godown: str = "") -> dict:
    """Sales (or purchases) net of returns, grouped by item / party / month / item group.

    Old-year records are included, like the Sales & GST report. Quotations, orders and challans are not.
    Purchases are only for people who may see costs (purchase prices).
    """
    assert_can(actor, "reports.view")
    if side == "purchase":
        assert_can(actor, "costs.view")
    godown = _scope_godown(actor, godown)
    by = by if by in BY_CHOICES else "item"
    costs = actor.can("costs.view")
    kinds = ["SALE", "SALE_RETURN"] if side == "sale" else ["PURCHASE", "PURCHASE_RETURN"]
    stmt = select(Voucher).where(Voucher.userId == actor.account_id, Voucher.kind.in_(kinds), Voucher.status != "CANCELLED")
    if frm:
        stmt = stmt.where(Voucher.date >= frm)
    if to:
        stmt = stmt.where(Voucher.date <= to)
    if godown:
        stmt = stmt.where(Voucher.godownId == godown)
    elif actor.godown_ids is not None:
        stmt = stmt.where(Voucher.godownId.in_(actor.godown_ids))
    vouchers = db.execute(
        stmt.options(selectinload(Voucher.party), selectinload(Voucher.lines).selectinload(VoucherLine.item)).order_by(Voucher.date)
    ).scalars().all()

    cash = "Cash sale" if side == "sale" else "Cash purchase"
    acc: dict[str, dict] = {}
    bill_total = 0.0
    line_total = 0.0
    for v in vouchers:
        s = -1 if v.kind.endswith("_RETURN") else 1
        bill_total += s * v.total
        for l in v.lines:
            if by == "item":
                key, label = l.itemId, l.item.name
            elif by == "group":
                key = label = l.item.category or UNGROUPED
            elif by == "party":
                key = v.partyId or "_cash"
                label = v.party.name if v.party else cash
            else:
                key = label = v.date[:7]
            r = acc.setdefault(key, {"label": label, "qty": 0.0, "taxable": 0.0, "tax": 0.0, "gross": 0.0, "returns": 0.0, "cost": 0.0,
                                     "bills": set()})
            amount = l.taxable + l.tax
            r["qty"] += s * l.qty
            r["taxable"] += s * l.taxable
            r["tax"] += s * l.tax
            r["gross" if s > 0 else "returns"] += amount
            r["cost"] += s * l.qty * l.costRate
            r["bills"].add(v.id)
            line_total += s * amount
    rows = []
    for r in acc.values():
        net = r2(r["gross"] - r["returns"])
        row = {"label": r["label"], "qty": round3(r["qty"]), "taxable": r2(r["taxable"]), "tax": r2(r["tax"]), "gross": r2(r["gross"]),
               "returns": r2(r["returns"]), "net": net, "bills": len(r["bills"])}
        if side == "sale" and costs:
            row["cost"] = r2(r["cost"])
            row["profit"] = r2(r["taxable"] - r["cost"])
            row["margin"] = round(row["profit"] / r["taxable"] * 100, 1) if r["taxable"] else 0.0
        rows.append(row)
    if by == "month":
        rows.sort(key=lambda r: r["label"])
    else:
        rows.sort(key=lambda r: (-r["net"], r["label"].lower()))
    grand = sum(r["net"] for r in rows)
    for r in rows:
        r["share"] = round(r["net"] / grand * 100, 1) if grand > 0 else 0.0
    top = sorted(rows, key=lambda r: -abs(r["net"]))[:10]
    peak = max((abs(r["net"]) for r in top), default=0) or 1
    bars = [{"label": r["label"], "net": r["net"], "pct": round(abs(r["net"]) / peak * 100, 1)} for r in top]
    totals = {k: r2(sum(r[k] for r in rows)) for k in ("taxable", "tax", "gross", "returns", "net")}
    totals["qty"] = round3(sum(r["qty"] for r in rows))
    if side == "sale" and costs:
        totals["cost"] = r2(sum(r["cost"] for r in rows))
        totals["profit"] = r2(sum(r["profit"] for r in rows))
        totals["margin"] = round(totals["profit"] / totals["taxable"] * 100, 1) if totals["taxable"] else 0.0
    godowns = [{"id": g["id"], "name": g["name"]} for g in stock_svc.load_workspace(db, actor)["godowns"]]
    return {"rows": rows, "totals": totals, "bars": bars, "by": by, "side": side, "from": frm, "to": to, "costs": costs, "godown": godown,
            "godowns": godowns, "billTotal": r2(bill_total), "roundOff": r2(bill_total - line_total), "bills": len(vouchers)}


# ---------------- 4. IMEI wise stock ----------------


def serial_stock(db: Session, actor: Actor, item: str = "", godown: str = "", q: str = "", limit: int = 500) -> dict:
    """IMEI counts (in stock / sold / returned) per tracked item and godown, plus the IMEIs in stock for one chosen item."""
    _need_any(actor, "reports.view", "sales.create", "purchases.create", "stock.move")
    godown = _scope_godown(actor, godown)
    uid = actor.account_id
    tracked = {i.id: i for i in db.execute(select(Item).where(Item.userId == uid, Item.trackSerial.is_(True)).order_by(Item.name)).scalars()}
    names = serial_svc._godown_names(db, uid)
    counts: dict[tuple[str, str], dict[str, int]] = {}
    for item_id, g_id, status, n in db.execute(
        select(SerialUnit.itemId, SerialUnit.godownId, SerialUnit.status, func.count())
        .where(SerialUnit.userId == uid, SerialUnit.status != "VOID").group_by(SerialUnit.itemId, SerialUnit.godownId, SerialUnit.status)
    ).all():
        if item_id not in tracked or (item and item != item_id):
            continue
        if g_id and not can_use_godown(actor, g_id):
            continue
        if godown and g_id != godown:
            continue
        c = counts.setdefault((item_id, g_id), {"IN_STOCK": 0, "SOLD": 0, "RETURNED": 0})
        c[status] = c.get(status, 0) + n
    stock_qty = {(s.itemId, s.godownId): s.quantity for s in db.execute(select(Stock).where(Stock.itemId.in_(list(tracked) or [""]))).scalars()}
    rows = []
    for (item_id, g_id), c in counts.items():
        sq = stock_qty.get((item_id, g_id))
        rows.append({"itemId": item_id, "item": tracked[item_id].name, "godownId": g_id, "godown": names.get(g_id, "— (returned)"),
                     "inStock": c["IN_STOCK"], "sold": c["SOLD"], "returned": c["RETURNED"], "total": c["IN_STOCK"] + c["SOLD"] + c["RETURNED"],
                     "stock": round3(sq) if sq is not None else None,
                     "mismatch": bool(g_id) and sq is not None and (round3(sq) != c["IN_STOCK"])})
    rows.sort(key=lambda r: (r["item"].lower(), r["godown"].lower()))
    totals = {k: sum(r[k] for r in rows) for k in ("inStock", "sold", "returned", "total")}
    imeis: list[dict] = []
    more = 0
    if item and item in tracked:
        stmt = select(SerialUnit).where(SerialUnit.userId == uid, SerialUnit.itemId == item, SerialUnit.status == "IN_STOCK")
        if godown:
            stmt = stmt.where(SerialUnit.godownId == godown)
        elif actor.godown_ids is not None:
            stmt = stmt.where(SerialUnit.godownId.in_(actor.godown_ids))
        needle = q.strip().upper()
        if needle:
            stmt = stmt.where(SerialUnit.imei.contains(needle, autoescape=True) | SerialUnit.imei2.contains(needle, autoescape=True))
        units = db.execute(stmt.order_by(SerialUnit.createdAt.desc(), SerialUnit.id)).scalars().all()
        more = max(0, len(units) - limit)
        imeis = [{"imei": u.imei, "imei2": u.imei2, "godown": names.get(u.godownId, "—")} for u in units[:limit]]
    mismatches = [m for m in serial_svc.reconcile(db, actor)
                  if (not item or m["item"] == (tracked[item].name if item in tracked else "")) and (not godown or m["godown"] == names.get(godown))]
    return {"rows": rows, "totals": totals, "imeis": imeis, "more": more, "mismatches": mismatches, "tracked": list(tracked.values()),
            "item": item, "godown": godown, "q": q, "godowns": [{"id": i, "name": n} for i, n in names.items() if can_use_godown(actor, i)],
            "itemName": tracked[item].name if item in tracked else ""}

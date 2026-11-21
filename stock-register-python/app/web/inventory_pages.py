"""Masters > Inventory > Item groups, and the Material in / Material out / Stock transfer voucher pages."""
from __future__ import annotations


from fastapi import APIRouter, Form, Request
from pydantic import ValidationError

from .. import schemas as S
from ..core.engine import today_iso
from ..core.errors import StockError
from ..db import session_scope
from ..services import inventory, stock
from .common import need, page_actor, render
from .stock_pages import _ledger_filters, act

router = APIRouter()
PAGE_SIZE = 20


# ---------------- item groups ----------------


@router.get("/app/masters/item-groups")
def item_groups_page(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "items.manage", "reports.view")
        groups = inventory.list_groups(db, actor)
        return render(request, "stock/item_groups.html", actor, "item_groups", groups=groups, can_edit=actor.can("items.manage"))


@router.post("/app/masters/item-groups")
def item_group_add(request: Request, name: str = Form("")):
    return act(request, ("items.manage",), "/app/masters/item-groups", f"Item group “{name.strip()}” added",
               lambda db, a: inventory.create_group(db, a, name))


@router.post("/app/masters/item-groups/{group_id}/rename")
def item_group_rename(group_id: str, request: Request, name: str = Form("")):
    return act(request, ("items.manage",), "/app/masters/item-groups", "Item group renamed",
               lambda db, a: inventory.rename_group(db, a, group_id, name))


@router.post("/app/masters/item-groups/{group_id}/delete")
def item_group_delete(group_id: str, request: Request):
    return act(request, ("items.manage",), "/app/masters/item-groups", "Item group deleted",
               lambda db, a: inventory.delete_group(db, a, group_id))


# ---------------- material in / out, stock transfer ----------------


def _pager(rows: list[dict], page: str) -> tuple[list[dict], dict]:
    total = len(rows)
    pages = max(1, -(-total // PAGE_SIZE))
    p = min(max(int(page) if page.strip().isdigit() else 1, 1), pages)
    start = (p - 1) * PAGE_SIZE
    chunk = rows[start:start + PAGE_SIZE]
    return chunk, {"page": p, "pages": pages, "total": total, "first": start + 1 if total else 0, "last": start + len(chunk)}


def _material(request: Request, kind: str, page: str, itemId: str, godownId: str, frm: str, to: str):
    """IN / OUT entries of the stock ledger, newest first, with a form to record one."""
    label, active = ("Material in", "material_in") if kind == "IN" else ("Material out", "material_out")
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "stock.move")
        ws = stock.load_workspace(db, actor)
        try:
            entries = stock.list_ledger(db, actor, _ledger_filters(itemId, godownId, kind, frm, to))
            err = ""
        except (StockError, ValidationError) as e:
            entries, err = [], e.message if isinstance(e, StockError) else S.first_message(e)
        rows, pg = _pager(list(reversed(entries)), page)
        return render(
            request, "stock/material.html", actor, active, ws=ws, rows=rows, err=err, kind=kind, label=label, pg=pg,
            f={"itemId": itemId, "godownId": godownId, "from": frm, "to": to}, today=today_iso(), costs=actor.can("costs.view"),
            base="/app/stock/material-in" if kind == "IN" else "/app/stock/material-out",
        )


@router.get("/app/stock/material-in")
def material_in(request: Request, itemId: str = "", godownId: str = "", to: str = "", page: str = "1"):
    return _material(request, "IN", page, itemId, godownId, request.query_params.get("from", ""), to)


@router.get("/app/stock/material-out")
def material_out(request: Request, itemId: str = "", godownId: str = "", to: str = "", page: str = "1"):
    return _material(request, "OUT", page, itemId, godownId, request.query_params.get("from", ""), to)


def _transfers(entries: list[dict]) -> list[dict]:
    """One row per transfer: the OUT leg and the IN leg that share a transferId."""
    legs: dict[str, dict] = {}
    for e in entries:
        if e["type"] not in ("TRANSFER_OUT", "TRANSFER_IN"):
            continue
        t = legs.setdefault(e["transferId"] or e["id"], {})
        t["out" if e["type"] == "TRANSFER_OUT" else "in"] = e
    rows = []
    for t in legs.values():
        base = t.get("out") or t.get("in")
        rows.append({
            "date": base["date"], "createdAt": base["createdAt"], "itemName": base["itemName"], "unit": base["unit"],
            "qty": (t.get("out") or t.get("in"))["qtyOut"] or (t.get("in") or t.get("out"))["qtyIn"],
            "from": t["out"]["godownName"] if "out" in t else "—", "to": t["in"]["godownName"] if "in" in t else "—",
            "remarks": base["remarks"], "by": base["actorName"],
        })
    rows.sort(key=lambda r: (r["date"], r["createdAt"]), reverse=True)
    return rows


@router.get("/app/stock/transfers")
def transfers_page(request: Request, page: str = "1"):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "stock.transfer")
        ws = stock.load_workspace(db, actor)
        entries = stock.list_ledger(db, actor, {})
        rows, pg = _pager(_transfers(entries), page)
        return render(request, "stock/transfers.html", actor, "stock_transfer", ws=ws, rows=rows, pg=pg, today=today_iso())

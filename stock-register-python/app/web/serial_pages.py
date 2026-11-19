"""IMEI register: search every phone, see where it came from, where it is and when it was last sold."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..core.errors import StockError
from ..db import session_scope
from ..services import serials, stock as stock_svc
from .common import need, page_actor, redirect, render

router = APIRouter()
PERMS = ("reports.view", "sales.create", "purchases.create", "stock.move")


@router.get("/app/serials")
def serial_list(request: Request, q: str = "", item: str = "", godown: str = "", status: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *PERMS)
        ws = stock_svc.load_workspace(db, actor)
        rows = serials.search(db, actor, q, item, godown, status if status in serials.STATUS_LABEL else "")
        mismatches = serials.reconcile(db, actor)
        return render(
            request, "serials/list.html", actor, "serials", rows=rows, q=q, item=item, godown=godown, status_f=status,
            ws=ws, tracked=[i for i in ws["items"] if i.get("trackSerial")], statuses=serials.STATUS_LABEL,
            mismatches=mismatches, costs=actor.can("costs.view"),
        )


@router.get("/app/serials/{imei}")
def serial_detail(imei: str, request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *PERMS)
        try:
            u = serials.history(db, actor, imei)
        except StockError as e:
            return redirect("/app/serials", flash=e.message, error=True)
        return render(request, "serials/detail.html", actor, "serials", u=u, costs=actor.can("costs.view"))


@router.get("/app/serial-lookup/available")
def lookup_available(request: Request, item: str = "", godown: str = "", voucher: str = "", q: str = ""):
    """IMEIs that can be picked for a sales line (JSON, used by the bill form)."""
    from fastapi.responses import JSONResponse

    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "sales.create")
        return JSONResponse(serials.available(db, actor, item, godown, voucher, q))


@router.get("/app/serial-lookup/find")
def lookup_find(request: Request, code: str = "", godown: str = "", voucher: str = ""):
    """POS scan: which model does this IMEI belong to (JSON)."""
    from fastapi.responses import JSONResponse

    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "sales.create")
        try:
            return JSONResponse({"ok": True, **serials.find_for_sale(db, actor, code, godown, voucher)})
        except StockError as e:
            return JSONResponse({"ok": False, "error": e.message})

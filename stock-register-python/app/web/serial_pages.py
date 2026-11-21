"""IMEI register: search every phone, see where it came from, where it is and when it was last sold."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..core.errors import StockError
from ..db import session_scope
from ..services import serials, stock as stock_svc
from .common import need, page_actor, redirect, render

router = APIRouter()
RECENT_COOKIE = "sr_recent_imei"
RECENT_MAX = 5  # the list shows only this many IMEIs: the last checked, or the newest when nothing is searched
PERMS = ("reports.view", "sales.create", "purchases.create", "stock.move")


@router.get("/app/serials")
def serial_list(request: Request, q: str = "", item: str = "", godown: str = "", status: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *PERMS)
        ws = stock_svc.load_workspace(db, actor)
        searching = bool(q.strip() or item or godown or status)
        rows = serials.search(db, actor, q, item, godown, status if status in serials.STATUS_LABEL else "")
        matched = len(rows)
        rows = rows[:RECENT_MAX]  # only the latest 5, even for a search; narrow it down to find a specific one
        recent = []
        for code in [c for c in request.cookies.get(RECENT_COOKIE, "").split(",") if c][:RECENT_MAX]:
            try:
                u = serials.history(db, actor, code)
            except StockError:
                continue  # not this account's IMEI, or no longer visible
            recent.append({"imei": u["imei"], "item": u["item"], "statusLabel": u["statusLabel"], "status": u["status"], "godown": u["godown"]})
        mismatches = serials.reconcile(db, actor)
        return render(
            request, "serials/list.html", actor, "serials", rows=rows, q=q, item=item, godown=godown, status_f=status,
            ws=ws, tracked=[i for i in ws["items"] if i.get("trackSerial")], statuses=serials.STATUS_LABEL,
            mismatches=mismatches, costs=actor.can("costs.view"), recent=recent, searching=searching, matched=matched,
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
        res = render(request, "serials/detail.html", actor, "serials", u=u, costs=actor.can("costs.view"))
        seen = [u["imei"]] + [c for c in request.cookies.get(RECENT_COOKIE, "").split(",") if c and c != u["imei"]]
        res.set_cookie(RECENT_COOKIE, ",".join(seen[:RECENT_MAX]), max_age=60 * 60 * 24 * 90, httponly=True, samesite="lax", path="/")
        return res


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

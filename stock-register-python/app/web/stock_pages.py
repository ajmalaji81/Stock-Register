"""Stock screens: dashboard, items, ledger, godowns, adjustments, stock reports, bulk import."""
from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import PlainTextResponse, Response
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from .. import schemas as S
from ..core import bulk_import as BI
from ..core import periods
from ..core.engine import is_low_stock, qty_in_scope, summarize_today, to_csv, today_iso
from ..core.errors import StockError
from ..core.jsmath import round2
from ..core.plans import limits_for
from ..db import session_scope
from ..services import inventory, parties, staff, stock
from .common import need, page_actor, redirect, render, selected_fy

router = APIRouter()

ENTRY_TYPES = ["OPENING", "IN", "OUT", "TRANSFER_IN", "TRANSFER_OUT", "ADJUSTMENT"]


def _safe_next(next_url: str, default: str) -> str:
    """Where to go after a form: only a page inside the app (/app/...), never an outside address."""
    n = (next_url or "").strip()
    return n if n.startswith("/app/") and "//" not in n and "\\" not in n else default


def _msg(e: Exception) -> str:
    if isinstance(e, StockError):
        return e.message + (" Upgrade from the sidebar to continue." if e.code == "LIMIT" else "")
    if isinstance(e, ValidationError):
        return S.first_message(e)
    if isinstance(e, IntegrityError):
        return "That name / SKU already exists"
    raise e


def act(request: Request, perms: tuple[str, ...], url: str, ok_msg: str, fn: Callable[[Any, Any], Any]):
    """Run a POST action in one transaction; flash success or the user-facing error."""
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            need(actor, *perms)
            fn(db, actor)
    except (StockError, ValidationError, IntegrityError) as e:
        return redirect(url, flash=_msg(e), error=True)
    return redirect(url, flash=ok_msg)


def _num(v: str, default: str = "0") -> str:
    return v.strip() if v and v.strip() else default


def _scope(ws: dict, scope: str) -> str:
    return scope if scope == "ALL" or any(g["id"] == scope for g in ws["godowns"]) else "ALL"


def _rows(ws: dict, scope: str, q: str = "") -> list[dict]:
    out = []
    ql = q.strip().lower()
    for it in ws["items"]:
        if ql and ql not in it["name"].lower() and ql not in it["sku"].lower() and ql not in it["category"].lower():
            continue
        out.append({**it, "qty": qty_in_scope(it["stock"], scope), "low": is_low_stock(it["stock"], it["minStockAlert"], scope)})
    return out


# ---------------- dashboard ----------------


def _sales_panel(db, actor, scope: str, per) -> Optional[dict]:
    """Dashboard sales widgets for one period (week / month / quarter / year), split into the period's buckets.
    Old-year records are included. None when the role can't see sales."""
    import json
    from datetime import date

    from sqlalchemy import select

    from ..models import Voucher
    from . import dash_charts as dc

    if not (actor.can("sales.create") or actor.can("reports.view")):
        return None
    costs = actor.can("costs.view")
    kinds = ["SALE", "SALE_RETURN"] + (["PURCHASE", "PURCHASE_RETURN"] if costs else [])
    stmt = select(Voucher).where(
        Voucher.userId == actor.account_id, Voucher.kind.in_(kinds), Voucher.status != "CANCELLED",
        Voucher.date >= per.start.isoformat(), Voucher.date <= per.end.isoformat(),
    )
    if actor.godown_ids is not None:
        stmt = stmt.where(Voucher.godownId.in_(actor.godown_ids))
    if scope != "ALL":
        stmt = stmt.where(Voucher.godownId == scope)
    rows = db.execute(stmt).scalars().all()

    where = per.index_by_day()
    n = len(per.buckets)
    sv, pv, prv, ov = [0.0] * n, [0.0] * n, [0.0] * n, [0.0] * n
    modes: dict[str, float] = {}
    for v in rows:
        i = where.get(v.date)
        if i is None:
            continue
        sg = -1 if v.kind.endswith("_RETURN") else 1
        if v.kind.startswith("SALE"):
            sv[i] += sg * v.total
            prv[i] += sg * (v.subtotal - v.costTotal)
            if sg == 1:
                ov[i] += 1
                try:
                    for r in json.loads(v.paymentSplit or "[]"):
                        modes[r["mode"]] = modes.get(r["mode"], 0.0) + r["amount"]
                except (ValueError, KeyError, TypeError):
                    pass
        else:
            pv[i] += sg * v.total
    elapsed = per.elapsed(date.today())
    labels, tips_l = [b[2] for b in per.buckets], [b[3] for b in per.buckets]

    def tip(vals, pre="", post=""):
        return [f"{lab}: {pre}{v:,.0f}{post}" for lab, v in zip(tips_l, vals)]

    mode_items = sorted(modes.items(), key=lambda kv: -kv[1])
    return {
        "costs": costs, "unit": per.unit, "elapsed": elapsed,
        "sales": {"total": sum(sv), "avg": sum(sv) / elapsed, "spark": dc.spark(sv, "#16a34a", tips=tip(sv, "₹"))},
        "profit": {"total": sum(prv), "avg": sum(prv) / elapsed, "spark": dc.spark(prv, "var(--brand)", tips=tip(prv, "₹"))} if costs else None,
        "orders": {"total": int(sum(ov)), "avg": sum(ov) / elapsed, "spark": dc.spark(ov, "#dc2626", tips=tip(ov, "", " orders"))},
        "bars": dc.bars(labels, sv, pv if costs else None, tip_labels=tips_l),
        "hasBars": any(sv) or any(pv),
        "donut": dc.donut([v for _, v in mode_items], labels=[m for m, _ in mode_items]),
        "modes": [{"mode": m, "value": v, "color": dc.DONUT[i % len(dc.DONUT)]} for i, (m, v) in enumerate(mode_items)],
        "modeTotal": sum(v for _, v in mode_items),
    }


@router.get("/app")
def dashboard(request: Request, scope: str = "ALL", view: str = "month", p: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        ws = stock.load_workspace(db, actor)
        scope = _scope(ws, scope)
        today = today_iso()
        ledger = stock.list_ledger(db, actor, {})
        per = periods.resolve(view, p, selected_fy(request))
        panel = _sales_panel(db, actor, scope, per)
    rows = _rows(ws, scope)
    costs = actor.can("costs.view")
    value = round2(sum(r["qty"] * r["purchasePrice"] for r in rows)) if costs else None
    scoped = [e for e in ledger if scope == "ALL" or e["godownId"] == scope]
    welcome = bool(request.cookies.get("sr_welcome"))  # set at login; shown on the first dashboard view only
    res = render(
        request, "stock/dashboard.html", actor, "dashboard", ws=ws, scope=scope, rows=rows, costs=costs, value=value,
        low=[r for r in rows if r["low"]], today=summarize_today(ledger, today, scope), recent=list(reversed(scoped))[:10], panel=panel,
        per=per, view_labels=periods.VIEW_LABEL, month_options=periods.months_of_fy(per.fy), welcome=welcome,
    )
    if welcome:
        res.delete_cookie("sr_welcome", path="/")
    return res


# ---------------- items ----------------


def _group_names(actor) -> list[str]:
    """Item group names for the category suggestions (needs its own session: items_page closed its one)."""
    with session_scope() as db:
        return inventory.group_names(db, actor)


@router.get("/app/items")
def items_page(request: Request, scope: str = "ALL", q: str = "", edit: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        ws = stock.load_workspace(db, actor)
    scope = _scope(ws, scope)
    editing = next((i for i in ws["items"] if i["id"] == edit), None)
    return render(
        request, "stock/items.html", actor, "items", ws=ws, scope=scope, q=q, rows=_rows(ws, scope, q), editing=editing,
        costs=actor.can("costs.view"), today=today_iso(), groups=_group_names(actor),
    )


@router.post("/app/items/save")
def item_save(
    request: Request, id: str = Form(""), name: str = Form(""), sku: str = Form(""), category: str = Form(""),
    unit: str = Form("pcs"), purchasePrice: str = Form("0"), salePrice: str = Form("0"), minStockAlert: str = Form("0"),
    hsn: str = Form(""), gstRate: str = Form("0"), openingQty: str = Form(""), openingGodownId: str = Form(""),
    trackSerial: str = Form(""),
):
    def work(db, actor):
        data: dict[str, Any] = {
            "name": name, "sku": sku, "category": category, "unit": unit, "purchasePrice": _num(purchasePrice),
            "salePrice": _num(salePrice), "minStockAlert": _num(minStockAlert), "hsn": hsn, "gstRate": _num(gstRate),
            "trackSerial": bool(trackSerial),
        }
        if not id:
            if openingQty.strip():
                data["openingQty"] = openingQty
            if openingGodownId:
                data["openingGodownId"] = openingGodownId
        inp = S.ItemInput.model_validate(data)
        if id:
            stock.update_item(db, actor, id, inp)
        else:
            stock.create_item(db, actor, inp)
        inventory.ensure_group(db, actor.account_id, inp.category)  # a new category becomes an item group

    return act(request, ("items.manage",), "/app/items", "Item saved", work)


@router.post("/app/items/{item_id}/delete")
def item_delete(item_id: str, request: Request):
    return act(request, ("items.manage",), "/app/items", "Item deleted", lambda db, a: stock.delete_item(db, a, item_id))


@router.post("/app/stock/move")
def stock_move(
    request: Request, itemId: str = Form(""), godownId: str = Form(""), type: str = Form("IN"), qty: str = Form(""),
    rate: str = Form("0"), party: str = Form(""), remarks: str = Form(""), date: str = Form(""), next: str = Form(""),
):
    def work(db, actor):
        inp = S.MovementInput.model_validate(
            {"itemId": itemId, "godownId": godownId, "type": type, "qty": qty, "rate": _num(rate), "party": party,
             "remarks": remarks, "date": date or today_iso()}
        )
        stock.record_movement(db, actor, inp)

    return act(request, ("stock.move",), _safe_next(next, "/app/items"), "Stock updated", work)


@router.post("/app/stock/transfer")
def stock_transfer(
    request: Request, itemId: str = Form(""), fromGodownId: str = Form(""), toGodownId: str = Form(""), qty: str = Form(""),
    remarks: str = Form(""), date: str = Form(""), serials: str = Form(""), next: str = Form(""),
):
    def work(db, actor):
        inp = S.TransferInput.model_validate(
            {"itemId": itemId, "fromGodownId": fromGodownId, "toGodownId": toGodownId, "qty": qty, "remarks": remarks,
             "date": date or today_iso(), "serials": serials}
        )
        stock.transfer_stock(db, actor, inp)

    return act(request, ("stock.transfer",), _safe_next(next, "/app/items"), "Stock transferred", work)


# ---------------- ledger ----------------


def _ledger_filters(itemId: str, godownId: str, type: str, from_: str, to: str) -> dict:
    q = S.parse_query(
        S.LedgerQuery, {"itemId": itemId, "godownId": godownId, "type": type, "from": from_, "to": to}
    )
    return {"itemId": q.itemId, "godownId": q.godownId, "type": q.type, "from": q.from_, "to": q.to}


LEDGER_PAGE_SIZE = 20


@router.get("/app/ledger")
def ledger_page(request: Request, itemId: str = "", godownId: str = "", type: str = "", to: str = "", page: str = "1"):
    from_ = request.query_params.get("from", "")
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "reports.view", "stock.move")
        ws = stock.load_workspace(db, actor)
        try:
            entries = stock.list_ledger(db, actor, _ledger_filters(itemId, godownId, type, from_, to))
            err = ""
        except (StockError, ValidationError) as e:
            entries, err = [], _msg(e)
    entries = list(reversed(entries))
    total = len(entries)
    pages = max(1, -(-total // LEDGER_PAGE_SIZE))
    page = min(max(int(page) if page.strip().isdigit() else 1, 1), pages)
    start = (page - 1) * LEDGER_PAGE_SIZE
    entries = entries[start:start + LEDGER_PAGE_SIZE]
    return render(
        request, "stock/ledger.html", actor, "ledger", ws=ws, entries=entries, err=err, types=ENTRY_TYPES,
        page=page, pages=pages, total=total, first=start + 1 if total else 0, last=start + len(entries),
        f={"itemId": itemId, "godownId": godownId, "type": type, "from": from_, "to": to}, costs=actor.can("costs.view"),
    )


@router.get("/app/ledger.csv")
def ledger_csv(request: Request, itemId: str = "", godownId: str = "", type: str = "", to: str = ""):
    from_ = request.query_params.get("from", "")
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "reports.view", "stock.move")
        entries = stock.list_ledger(db, actor, _ledger_filters(itemId, godownId, type, from_, to))
    costs = actor.can("costs.view")
    head = ["Date", "Item", "Godown", "Type", "In", "Out", "Balance", "Rate" if costs else "", "Party", "Remarks", "By"]
    rows: list[list[Any]] = [[h for h in head if h]]
    for e in reversed(entries):
        r = [e["date"], e["itemName"], e["godownName"], e["type"], e["qtyIn"], e["qtyOut"], e["balance"]]
        if costs:
            r.append(e["rate"])
        rows.append(r + [e["party"], e["remarks"], e["actorName"]])
    return Response(to_csv(rows), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="stock-ledger.csv"'})


# ---------------- godowns ----------------


@router.get("/app/godowns")
def godowns_page(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "godowns.manage")
        ws = stock.load_workspace(db, actor)
    rows = [{**g, "items": sum(1 for i in ws["items"] if i["stock"].get(g["id"], 0) > 0),
             "qty": sum(i["stock"].get(g["id"], 0) for i in ws["items"])} for g in ws["godowns"]]
    return render(request, "stock/godowns.html", actor, "godowns", rows=rows, limits=ws["limits"])


@router.post("/app/godowns")
def godown_create(request: Request, name: str = Form("")):
    def work(db, actor):
        stock.create_godown(db, actor, S.GodownInput.model_validate({"name": name}).name)

    return act(request, ("godowns.manage",), "/app/godowns", "Godown added", work)


@router.post("/app/godowns/{godown_id}/details")
def godown_details(godown_id: str, request: Request, name: str = Form(""), state: str = Form(""), gstin: str = Form(""), address: str = Form("")):
    def work(db, actor):
        stock.update_godown(db, actor, godown_id, S.GodownInput.model_validate({"name": name, "state": state, "gstin": gstin, "address": address}))

    return act(request, ("godowns.manage",), "/app/godowns", "Godown saved", work)


@router.post("/app/godowns/{godown_id}/rename")
def godown_rename(godown_id: str, request: Request, name: str = Form("")):
    def work(db, actor):
        stock.rename_godown(db, actor, godown_id, S.GodownInput.model_validate({"name": name}).name)

    return act(request, ("godowns.manage",), "/app/godowns", "Godown renamed", work)


@router.post("/app/godowns/{godown_id}/delete")
def godown_delete(godown_id: str, request: Request):
    return act(request, ("godowns.manage",), "/app/godowns", "Godown deleted", lambda db, a: stock.delete_godown(db, a, godown_id))


# ---------------- adjustments ----------------


@router.get("/app/adjustments")
def adjustments_page(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "stock.adjust")
        ws = stock.load_workspace(db, actor)
        history = staff.list_adjustments(db, actor)
    return render(request, "stock/adjustments.html", actor, "adjustments", ws=ws, history=history, today=today_iso())


@router.post("/app/adjustments")
def adjustment_post(
    request: Request, itemId: str = Form(""), godownId: str = Form(""), mode: str = Form("count"), value: str = Form(""),
    reason: str = Form(""), date: str = Form(""),
):
    def work(db, actor):
        data: dict[str, Any] = {"itemId": itemId, "godownId": godownId, "reason": reason, "date": date or today_iso()}
        if value.strip() != "":
            data["newQty" if mode == "count" else "delta"] = value
        staff.record_adjustment(db, actor, S.AdjustmentInput.model_validate(data))

    return act(request, ("stock.adjust",), "/app/adjustments", "Adjustment recorded", work)


# ---------------- stock reports ----------------


def _report(ws: dict, costs: bool) -> list[dict]:
    rows = []
    for it in ws["items"]:
        total = qty_in_scope(it["stock"], "ALL")
        rows.append({**it, "total": total, "low": is_low_stock(it["stock"], it["minStockAlert"], "ALL"),
                     "value": round2(total * it["purchasePrice"]) if costs else None})
    return rows


@router.get("/app/reports")
def reports_page(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "reports.view")
        ws = stock.load_workspace(db, actor)
    costs = actor.can("costs.view")
    rows = _report(ws, costs)
    total_value = round2(sum(r["value"] for r in rows)) if costs else None
    return render(request, "stock/reports.html", actor, "reports", ws=ws, rows=rows, costs=costs, total_value=total_value)


@router.get("/app/reports.csv")
def reports_csv(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "reports.view")
        ws = stock.load_workspace(db, actor)
    costs = actor.can("costs.view")
    head = ["Item", "SKU", "Category", "Unit"] + [g["name"] for g in ws["godowns"]] + ["Total", "Min alert"]
    if costs:
        head += ["Purchase price", "Stock value"]
    rows: list[list[Any]] = [head]
    for r in _report(ws, costs):
        line: list[Any] = [r["name"], r["sku"], r["category"], r["unit"]] + [r["stock"].get(g["id"], 0) for g in ws["godowns"]]
        line += [r["total"], r["minStockAlert"]]
        if costs:
            line += [r["purchasePrice"], r["value"]]
        rows.append(line)
    return Response(to_csv(rows), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="stock-report.csv"'})


# ---------------- bulk import ----------------


@router.get("/app/import")
def import_page(request: Request, kind: str = "items"):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "items.manage", "parties.manage")
    return render(request, "stock/import.html", actor, "import", kind=kind if kind in ("items", "parties") else "items", preview=None, text="")


@router.get("/app/import/template/{kind}.csv")
def import_template(kind: str):
    body = BI.PARTY_TEMPLATE if kind == "parties" else BI.ITEM_TEMPLATE
    return PlainTextResponse(body, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{kind}-template.csv"'})


async def _read_text(text: str, file: Optional[UploadFile]) -> str:
    if file is not None and file.filename:
        return (await file.read()).decode("utf-8-sig", errors="replace")
    return text


def _map(kind: str, text: str) -> BI.MapResult:
    table = BI.parse_delimited(text)
    return BI.map_party_rows(table) if kind == "parties" else BI.map_item_rows(table)


@router.post("/app/import/preview")
async def import_preview(request: Request, kind: str = Form("items"), text: str = Form(""), file: Optional[UploadFile] = File(None)):
    text = await _read_text(text, file)
    kind = "parties" if kind == "parties" else "items"
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "parties.manage" if kind == "parties" else "items.manage")
    result = _map(kind, text)
    ok_rows = sum(1 for r in result.rows if not r.errors)
    return render(
        request, "stock/import.html", actor, "import", kind=kind, text=text,
        preview={"result": result, "ok": ok_rows, "bad": len(result.rows) - ok_rows},
    )


@router.post("/app/import/commit")
def import_commit(request: Request, kind: str = Form("items"), text: str = Form("")):
    kind = "parties" if kind == "parties" else "items"
    url = f"/app/import?kind={kind}"
    result = _map(kind, text)
    good = [r for r in result.rows if not r.errors]
    if result.header_errors or not good:
        return redirect(url, flash="Nothing to import: " + ("; ".join(result.header_errors) or "every row has errors"), error=True)
    created, failed = 0, 0
    try:
        if kind == "parties":
            with session_scope() as db:
                actor = page_actor(db, request)
                need(actor, "parties.manage")
                res = parties.import_parties(db, actor, [{**r.data, "line": r.line} for r in good])
            created, failed = res["created"], res["failed"]
            first = next((x["error"] for x in res["results"] if not x["ok"]), "")
        else:
            with session_scope() as db:
                actor = page_actor(db, request)
                need(actor, "items.manage")
                gmap = {g["name"].lower(): g["id"] for g in stock.load_workspace(db, actor)["godowns"]}
                first_gid = next(iter(gmap.values()), None)
            first = ""
            for r in good:
                try:
                    d = r.data
                    gid = None
                    if d["openingQty"] > 0:
                        gid = gmap.get(d["openingGodown"].strip().lower()) if d["openingGodown"] else first_gid
                        if not gid:
                            raise StockError(f'Godown "{d["openingGodown"]}" not found')
                    inp = S.ItemInput.model_validate({**d, "openingGodownId": gid, "openingQty": d["openingQty"] or None})
                    with session_scope() as db:
                        a = page_actor(db, request)
                        need(a, "items.manage")
                        stock.create_item(db, a, inp)
                    created += 1
                except (StockError, ValidationError, IntegrityError) as e:
                    failed += 1
                    first = first or f"line {r.line}: {_msg(e)}"
    except (StockError, ValidationError) as e:
        return redirect(url, flash=_msg(e), error=True)
    skipped = len(result.rows) - len(good)
    note = f"Imported {created} {kind}" + (f"; {failed + skipped} skipped" if failed + skipped else "") + (f" ({first})" if first else "")
    return redirect(url, flash=note, error=created == 0)

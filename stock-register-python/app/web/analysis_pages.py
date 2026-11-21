"""Display > Stock analysis, Sales & purchase analysis and Serial number reports (read-only)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ..core.engine import to_csv
from ..core.fy import fy_range
from ..db import session_scope
from ..services import display_analysis as da
from .common import need, page_actor, render, selected_fy

router = APIRouter()
VIEW = ("reports.view", "stock.move")
SERIAL_VIEW = ("reports.view", "sales.create", "purchases.create", "stock.move")


def _csv(name: str, rows: list[list[Any]]) -> Response:
    return Response(to_csv(rows), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})


def _period(request: Request, frm: str, to: str) -> tuple[str, str]:
    """The picked dates, else the financial year chosen next to the profile."""
    if not frm and not to:
        return fy_range(selected_fy(request))
    return frm, to


# ---------------- stock status ----------------


@router.get("/app/display/stock-status")
def stock_status_page(request: Request, godown: str = "", q: str = "", low: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *VIEW)
        d = da.stock_status(db, actor, godown, q, low_only=bool(low))
        if request.query_params.get("format") == "csv":
            head = ["Group", "Item", "SKU", "Unit", "Stock", "Min alert", "Status"] + (["Stock value"] if d["costs"] else [])
            rows: list[list[Any]] = [head]
            for g in d["groups"]:
                for r in g["rows"]:
                    rows.append([g["name"], r["name"], r["sku"], r["unit"], r["qty"], r["min"], r["status"]] + ([r["value"]] if d["costs"] else []))
            return _csv("stock-status", rows)
        return render(request, "display/analysis_stock_status.html", actor, "stock_status", d=d)


# ---------------- inventory summary ----------------


@router.get("/app/display/inventory-summary")
def inventory_summary_page(request: Request, godown: str = "", q: str = "", to: str = ""):
    frm, to = _period(request, request.query_params.get("from", ""), to)
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *VIEW)
        d = da.inventory_summary(db, actor, frm, to, godown, q)
        if request.query_params.get("format") == "csv":
            head = ["Item", "SKU", "Unit", "Opening", "Inward", "Outward", "Transfer in", "Transfer out", "Adjustments", "Closing"]
            rows: list[list[Any]] = [head + (["Closing value"] if d["costs"] else [])]
            for r in d["rows"]:
                rows.append([r["name"], r["sku"], r["unit"], r["opening"], r["inward"], r["outward"], r["tin"], r["tout"], r["adj"], r["closing"]]
                            + ([r["value"]] if d["costs"] else []))
            t = d["totals"]
            rows.append(["Total", "", "", t["opening"], t["inward"], t["outward"], t["tin"], t["tout"], t["adj"], t["closing"]] + ([t["value"]] if d["costs"] else []))
            return _csv("inventory-summary", rows)
        return render(request, "display/analysis_inventory_summary.html", actor, "inventory_summary", d=d)


# ---------------- sales / purchase analysis ----------------


def _trade(request: Request, side: str, by: str, godown: str, to: str):
    frm, to = _period(request, request.query_params.get("from", ""), to)
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "reports.view")
        d = da.trade_analysis(db, actor, side, by, frm, to, godown)
        if request.query_params.get("format") == "csv":
            head = [da.BY_LABEL[d["by"]], "Bills", "Qty", "Taxable", "Tax", "Gross", "Returns", "Net", "Share %"]
            if "cost" in d["totals"]:
                head += ["Cost", "Profit", "Margin %"]
            rows: list[list[Any]] = [head]
            for r in d["rows"]:
                rows.append([r["label"], r["bills"], r["qty"], r["taxable"], r["tax"], r["gross"], r["returns"], r["net"], r["share"]]
                            + ([r["cost"], r["profit"], r["margin"]] if "cost" in d["totals"] else []))
            t = d["totals"]
            rows.append(["Total", d["bills"], t["qty"], t["taxable"], t["tax"], t["gross"], t["returns"], t["net"], ""]
                        + ([t["cost"], t["profit"], t["margin"]] if "cost" in t else []))
            rows.append(["Round off", "", "", "", "", "", "", d["roundOff"]])
            rows.append(["Net bill total", "", "", "", "", "", "", d["billTotal"]])
            return _csv(f"{side}-analysis-{d['by']}", rows)
        return render(request, "display/analysis_trade.html", actor, f"{side}s_analysis" if side == "sale" else "purchase_analysis",
                      d=d, by_label=da.BY_LABEL, title="Sales analysis" if side == "sale" else "Purchase analysis")


@router.get("/app/display/sales-analysis")
def sales_analysis_page(request: Request, by: str = "item", godown: str = "", to: str = ""):
    return _trade(request, "sale", by, godown, to)


@router.get("/app/display/purchase-analysis")
def purchase_analysis_page(request: Request, by: str = "item", godown: str = "", to: str = ""):
    return _trade(request, "purchase", by, godown, to)


# ---------------- IMEI wise stock ----------------


@router.get("/app/display/serial-stock")
def serial_stock_page(request: Request, item: str = "", godown: str = "", q: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *SERIAL_VIEW)
        d = da.serial_stock(db, actor, item, godown, q)
        if request.query_params.get("format") == "csv":
            rows: list[list[Any]] = [["Item", "Godown", "In stock", "Sold", "Returned to supplier", "Total", "Stock quantity"]]
            for r in d["rows"]:
                rows.append([r["item"], r["godown"], r["inStock"], r["sold"], r["returned"], r["total"], "" if r["stock"] is None else r["stock"]])
            if d["itemName"]:
                rows += [[], ["IMEIs in stock: " + d["itemName"]], ["IMEI", "IMEI 2", "Godown"]] + [[u["imei"], u["imei2"], u["godown"]] for u in d["imeis"]]
            return _csv("imei-wise-stock", rows)
        return render(request, "display/analysis_serial_stock.html", actor, "serial_stock", d=d)

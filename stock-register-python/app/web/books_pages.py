"""Display > Books & registers, Summaries, Outstanding & ageing. Read-only reports; every page can be downloaded (?format=csv)."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ..core.engine import to_csv
from ..core.errors import StockError
from ..core.fy import fy_range
from ..db import session_scope
from ..services import display_books as books
from .common import need, page_actor, render, selected_fy

router = APIRouter()
REPORT = ("reports.view",)
PARTY_REPORT = ("reports.view", "parties.manage")


def _period(request: Request) -> tuple[str, str]:
    d_from, d_to = fy_range(selected_fy(request))
    frm = books.clean_date(request.query_params.get("frm") or request.query_params.get("from"), d_from)
    to = books.clean_date(request.query_params.get("to"), d_to)
    if frm > to:
        frm, to = to, frm
    return frm, to


def _csv(name: str, rows: list[list[Any]]) -> Response:
    return Response(to_csv(rows), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})


def _wants_csv(request: Request) -> bool:
    return request.query_params.get("format") == "csv"


def _csv_url(request: Request) -> str:
    q = dict(request.query_params)
    q["format"] = "csv"
    from urllib.parse import urlencode

    return f"{request.url.path}?{urlencode(q)}"


# ---------------- day book ----------------


@router.get("/app/display/day-book")
def day_book_page(request: Request):
    frm, to = _period(request)
    type_ = request.query_params.get("type", "")
    if type_ not in {c for c, _ in books.DAY_BOOK_TYPES}:
        type_ = ""
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *REPORT)
        data = books.day_book(db, actor, frm, to, type_)
        if _wants_csv(request):
            rows: list[list[Any]] = [["Date", "Type", "Number / ref", "Party / account", "Amount", "Dr/Cr", "By"]]
            for d in data["days"]:
                rows += [[r["date"], r["type"], r["ref"], r["who"], r["amount"], r["side"], r["by"]] for r in d["rows"]]
            return _csv("day-book", rows)
        return render(request, "display/books_day_book.html", actor, "day_book", data=data, frm=frm, to=to, type_=type_,
                      types=books.DAY_BOOK_TYPES, csv_url=_csv_url(request))


# ---------------- ledger ----------------


@router.get("/app/display/ledger")
def ledger_page(request: Request):
    frm, to = _period(request)
    kind = request.query_params.get("kind", "")
    ledger_id = request.query_params.get("id", "")
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *REPORT)
        choices = books.ledger_choices(db, actor)
        data: Optional[dict] = None
        err = ""
        if kind in ("party", "account") and ledger_id:
            try:
                data = (books.party_ledger_view if kind == "party" else books.account_ledger)(db, actor, ledger_id, frm, to)
            except StockError as e:
                err = e.message
        if data is not None and _wants_csv(request):
            rows: list[list[Any]] = [["Date", "Particulars", "Debit", "Credit", "Balance", "Dr/Cr"]]
            rows += [[r["date"], r["ref"], r["debit"], r["credit"], abs(r["balance"]), r["side"]] for r in data["rows"]]
            return _csv("ledger-" + data["name"].replace(" ", "-").lower(), rows)
        return render(request, "display/books_ledger.html", actor, "book_ledger", data=data, err=err, choices=choices, kind=kind,
                      ledger_id=ledger_id, frm=frm, to=to, csv_url=_csv_url(request))


# ---------------- summaries ----------------


@router.get("/app/display/transaction-summary")
def transaction_summary_page(request: Request):
    frm, to = _period(request)
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *REPORT)
        data = books.transaction_summary(db, actor, frm, to)
        if _wants_csv(request):
            rows: list[list[Any]] = [["Type", "Count", "Amount"]] + [[r["label"], r["count"], r["amount"]] for r in data["rows"]]
            rows += [["Net sales (sales - sales return)", "", data["netSales"]], ["Net purchases (purchase - purchase return)", "", data["netPurchases"]]]
            return _csv("transaction-summary", rows)
        return render(request, "display/books_summary.html", actor, "transaction_summary", data=data, frm=frm, to=to, csv_url=_csv_url(request))


@router.get("/app/display/monthly-summary")
def monthly_summary_page(request: Request):
    frm, to = _period(request)
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *REPORT)
        data = books.monthly_summary(db, actor, frm, to)
        if _wants_csv(request):
            head = ["Month", "Sales", "Sales return", "Purchase", "Purchase return", "Receipts", "Payments", "Expenses", "Net"]
            keys = ["sale", "sale_return", "purchase", "purchase_return", "receipt", "payment", "expense", "net"]
            rows: list[list[Any]] = [head] + [[r["label"]] + [r[k] for k in keys] for r in data["rows"]]
            rows.append(["Total"] + [data["total"][k] for k in keys])
            return _csv("monthly-summary", rows)
        return render(request, "display/books_monthly.html", actor, "monthly_summary", data=data, frm=frm, to=to, csv_url=_csv_url(request))


# ---------------- receivables / ageing / bill-wise ----------------


@router.get("/app/display/receivables")
def receivables_page(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *PARTY_REPORT)
        data = books.receivables(db, actor)
        if _wants_csv(request):
            rows: list[list[Any]] = [["Side", "Party", "Phone", "Amount"]]
            rows += [["To receive", r["name"], r["phone"], r["balance"]] for r in data["receivable"]]
            rows += [["To pay", r["name"], r["phone"], r["balance"]] for r in data["payable"]]
            return _csv("receivables", rows)
        return render(request, "display/books_receivables.html", actor, "receivables", data=data, csv_url=_csv_url(request))


def _side(request: Request) -> str:
    return "payable" if request.query_params.get("side") == "payable" else "receivable"


@router.get("/app/display/ageing")
def ageing_page(request: Request):
    side = _side(request)
    as_on = books.clean_date(request.query_params.get("as_on"), books.default_as_on())
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *PARTY_REPORT)
        data = books.ageing(db, actor, side, as_on)
        if _wants_csv(request):
            rows: list[list[Any]] = [["Party"] + [label for _, label in data["buckets"]] + ["Total", "Unadjusted advance"]]
            rows += [[r["name"]] + [r[k] for k, _ in data["buckets"]] + [r["total"], r["advance"]] for r in data["rows"]]
            rows.append(["Total"] + [data["totals"][k] for k, _ in data["buckets"]] + [data["totals"]["total"], data["totals"]["advance"]])
            return _csv(f"ageing-{side}", rows)
        return render(request, "display/books_ageing.html", actor, "ageing", data=data, side=side, as_on=as_on, csv_url=_csv_url(request))


@router.get("/app/display/bill-outstanding")
def bill_outstanding_page(request: Request):
    side = _side(request)
    as_on = books.clean_date(request.query_params.get("as_on"), books.default_as_on())
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *PARTY_REPORT)
        parties = books.outstanding(db, actor, side, as_on)
        total = round(sum(p["total"] for p in parties), 2)
        if _wants_csv(request):
            rows: list[list[Any]] = [["Party", "Bill", "Date", "Days", "Bill amount", "Settled", "Outstanding"]]
            for p in parties:
                rows += [[p["name"], b["ref"], b["date"], "" if b["age"] is None else b["age"], b["amount"], b["settled"], b["outstanding"]] for b in p["bills"]]
            return _csv(f"bills-{side}", rows)
        return render(request, "display/books_bills.html", actor, "bill_outstanding", parties=parties, total=total, side=side, as_on=as_on,
                      csv_url=_csv_url(request))

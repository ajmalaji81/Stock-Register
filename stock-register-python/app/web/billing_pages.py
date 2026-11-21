"""Billing UI: bill lists, editor, detail, GST reports and the printable invoice."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..core.engine import to_csv, today_iso
from ..core.errors import StockError
from ..core.money import FINANCE_COMPANIES, PAYMENT_MODES
from ..core.gst import CONVERSIONS, KIND_LABEL, VOUCHER_KINDS, amount_in_words, is_purchase_side
from ..db import session_scope
from ..models import Godown, Party
from ..schemas import VoucherCreateInput, first_message
from ..services import branch as branch_svc
from ..services import stock as stock_svc
from ..services import vouchers
from ..services.actor import can_use_godown
from ..services.vouchers import can_see_kind, permission_for
from ..core.fy import current_fy, fy_range
from .common import LoginRedirect, need, page_actor, redirect, render, selected_fy, templates

router = APIRouter()

GROUPS = {
    "sales": ("Sales", ["SALE", "SALE_RETURN"]),
    "purchases": ("Purchases", ["PURCHASE", "PURCHASE_RETURN"]),
    "documents": ("Quotes & orders", ["QUOTATION", "SALES_ORDER", "PURCHASE_ORDER", "CHALLAN", "PURCHASE_QUOTATION"]),
}
#: The sidebar row that lights up for each kind (a page for one kind is shown under its own menu item).
KIND_ACTIVE = {
    "SALE": "sales", "SALE_RETURN": "sale_return", "PURCHASE": "purchases", "PURCHASE_RETURN": "purchase_return",
    "QUOTATION": "documents", "SALES_ORDER": "sales_order", "PURCHASE_ORDER": "purchase_order",
    "PURCHASE_QUOTATION": "purchase_quotation", "CHALLAN": "challan",
}
GROUP_PERM = {"sales": "sales.create", "purchases": "purchases.create", "documents": "documents.manage"}
STATUSES = ["OPEN", "CONVERTED", "CLOSED", "CANCELLED"]


def _retry(fn):
    """Two bills numbered at the same moment: try once more with the next number."""
    try:
        with session_scope() as db:
            return fn(db)
    except IntegrityError:
        with session_scope() as db:
            return fn(db)


def _active_of(kind: str) -> str:
    return KIND_ACTIVE.get(kind) or _group_of(kind)


def _group_of(kind: str) -> str:
    for g, (_, kinds) in GROUPS.items():
        if kind in kinds:
            return g
    return "sales"


@router.get("/app/billing/reports")
def reports(request: Request, side: str = "sales", frm: Optional[str] = None, to: Optional[str] = None, format: str = ""):
    from pydantic import ValidationError

    from .. import schemas as S

    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "reports.view")
        try:
            q = S.SalesReportQuery.model_validate(
                {k: v for k, v in {"side": side, "from": request.query_params.get("from") or fy_range(selected_fy(request))[0],
                                   "to": to or fy_range(selected_fy(request))[1]}.items() if v}
            )
        except ValidationError as e:
            return redirect("/app/billing/reports", flash=first_message(e), error=True)
        try:
            rep = vouchers.sales_report(db, actor, q.side, q.from_, q.to)
        except StockError as e:
            return redirect("/app/billing/reports", flash=e.message, error=True)
        if format == "csv":
            rows = [["Date", "Number", "Type", "Party", "GSTIN", "Taxable", "CGST", "SGST", "IGST", "Total"]]
            rows += [
                [r["date"], r["number"], KIND_LABEL[r["kind"]], r["party"], r["gstin"], r["taxable"], r["cgst"], r["sgst"], r["igst"], r["total"]]
                for r in rep["register"]
            ]
            return Response(
                to_csv(rows), media_type="text/csv",
                headers={"Content-Disposition": f'attachment; filename="{q.side}-register.csv"'},
            )
        return render(request, "billing/reports.html", actor, "billreports", rep=rep, side=q.side,
                      frm=q.from_ or "", to=q.to or "", can_purchases=actor.can("costs.view"))


def _pay_context() -> dict:
    return {"pay_modes": PAYMENT_MODES, "finance_companies": FINANCE_COMPANIES}


HISTORY_KINDS = ("SALE", "PURCHASE", "SALE_RETURN", "PURCHASE_RETURN")


def _default_date(request: Request) -> str:
    """Today, unless an older financial year is selected: then that year's last day."""
    y = selected_fy(request)
    return today_iso() if y >= current_fy() else fy_range(y)[1]


def _party_options(db, actor) -> list[dict]:
    branch_svc.ensure_all(db, actor.account_id)  # own godowns are offered as parties (only when there are two or more)
    rows = db.execute(
        select(Party.id, Party.name, Party.state, Party.phone, Party.linkedGodownId)
        .where(Party.userId == actor.account_id).order_by(Party.name)
    ).all()
    to = {g.id: g.name for g in db.execute(select(Godown).where(Godown.userId == actor.account_id)).scalars()}
    return [{"id": p.id, "name": p.name, "state": p.state, "phone": p.phone, "branch": to.get(p.linkedGodownId) or ""} for p in rows]


def _item_options(ws: dict, purchase_side: bool) -> list[dict]:
    return [
        {"id": i["id"], "name": i["name"], "sku": i["sku"], "unit": i["unit"], "gstRate": i["gstRate"],
         "trackSerial": i.get("trackSerial", False), "price": i["purchasePrice"] if purchase_side else i["salePrice"]}
        for i in ws["items"]
    ]


@router.get("/app/billing/approvals")
def approvals(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, "branch.approve")
        rows = branch_svc.pending_for(db, actor)
        return render(request, "billing/approvals.html", actor, "approvals", rows=rows)


@router.post("/app/billing/{voucher_id}/branch/{decision}")
def branch_decide(voucher_id: str, decision: str, request: Request):
    if decision not in ("approve", "reject"):
        return redirect("/app/billing/approvals", flash="Unknown action", error=True)
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            res = (branch_svc.approve if decision == "approve" else branch_svc.reject)(db, actor, voucher_id)
    except StockError as e:
        return redirect("/app/billing/approvals", flash=e.message, error=True)
    if decision == "approve":
        return redirect("/app/billing/approvals", flash=f"Approved {res['saleNumber']}. Purchase {res['purchaseNumber']} created in your godown.")
    return redirect("/app/billing/approvals", flash=f"Rejected {res['saleNumber']}. The stock went back to the billing godown.")


@router.get("/app/billing/new")
def new_bill(request: Request, kind: str = "SALE", source: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        if kind not in VOUCHER_KINDS:
            kind = "SALE"
        if not can_see_kind(actor, kind) or not actor.can(permission_for(kind)):
            return redirect("/app", flash="Your role doesn't allow this.", error=True)
        ws = stock_svc.load_workspace(db, actor)
        purchase_side = is_purchase_side(kind)
        return render(
            request, "billing/new.html", actor, _active_of(kind), kind=kind, purchase_side=purchase_side, ws=ws,
            parties=_party_options(db, actor), today=_default_date(request), hist_default=selected_fy(request) < current_fy(),
            can_hist=kind in HISTORY_KINDS, fy_start_now=fy_range(current_fy())[0], business_state=actor.owner.state,
            can_pay=kind in ("SALE", "PURCHASE"), items=_item_options(ws, purchase_side), edit=None, edit_lines=[],
            **_pay_context(),
        )


def bill_form(
    kind: str = Form(""), date: str = Form(""), godownId: str = Form(""), partyId: str = Form(""),
    taxType: str = Form(""), notes: str = Form(""), gstEnabled: str = Form(""),
    paymentInfo: str = Form(""), schemeInfo: str = Form(""), history: str = Form(""), oldNumber: str = Form(""),
    paidNow: str = Form("0"), paymentMode: str = Form("CASH"),
    payMode: list[str] = Form(default=[]), payAmount: list[str] = Form(default=[]), payFinance: list[str] = Form(default=[]),
    itemId: list[str] = Form(default=[]), qty: list[str] = Form(default=[]), rate: list[str] = Form(default=[]),
    discountPct: list[str] = Form(default=[]), taxRate: list[str] = Form(default=[]), description: list[str] = Form(default=[]),
    serials: list[str] = Form(default=[]),
) -> dict:
    """The bill editor's fields as the dict VoucherCreateInput validates (shared by create and edit)."""

    def at(lst, i, d="0"):
        return lst[i] if i < len(lst) and lst[i] != "" else d

    lines = [
        {"itemId": iid, "qty": at(qty, i), "rate": at(rate, i), "discountPct": at(discountPct, i),
         "taxRate": at(taxRate, i), "description": at(description, i, ""), "serials": at(serials, i, "")}
        for i, iid in enumerate(itemId) if iid
    ]
    split = [
        {"mode": m, "amount": at(payAmount, i), "finance": at(payFinance, i, "")}
        for i, m in enumerate(payMode) if m
    ]
    return {"kind": kind, "date": date, "partyId": partyId or None, "godownId": godownId, "gstEnabled": bool(gstEnabled),
            "taxType": taxType, "notes": notes, "lines": lines, "paidNow": paidNow or 0, "paymentMode": paymentMode,
            "paymentSplit": split, "paymentInfo": paymentInfo, "schemeInfo": schemeInfo, "history": bool(history),
            "oldNumber": oldNumber}


@router.post("/app/billing/new")
def create_bill(request: Request, data: dict = Depends(bill_form)):
    kind = data["kind"]
    back = f"/app/billing/new?kind={kind}"
    try:
        inp = VoucherCreateInput.model_validate(data)
        with session_scope() as db:  # auth check first so anonymous users go to /login
            page_actor(db, request)

        def work(db):
            return vouchers.create_voucher(db, page_actor(db, request), inp)

        v = _retry(work)
    except LoginRedirect:
        raise
    except StockError as e:
        return redirect(back, flash=e.message, error=True)
    except ValidationError as e:
        return redirect(back, flash=first_message(e), error=True)
    return redirect(f"/app/billing/{v['id']}", flash=f"{KIND_LABEL[kind]} {v['number']} created")


@router.get("/app/billing/{voucher_id}/edit")
def edit_bill_page(voucher_id: str, request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        try:
            v = vouchers.get_voucher(db, actor, voucher_id)
        except StockError as e:
            return redirect("/app/billing/sales", flash=e.message, error=True)
        if not actor.is_owner or v["status"] != "OPEN":
            return redirect(f"/app/billing/{voucher_id}", flash="Only the account owner can edit an open bill.", error=True)
        kind = v["kind"]
        ws = stock_svc.load_workspace(db, actor)
        purchase_side = is_purchase_side(kind)
        return render(
            request, "billing/new.html", actor, _active_of(kind), kind=kind, purchase_side=purchase_side, ws=ws,
            parties=_party_options(db, actor), today=v["date"], hist_default=False, can_hist=False,
            fy_start_now=fy_range(current_fy())[0], business_state=actor.owner.state,
            can_pay=kind in ("SALE", "PURCHASE"), items=_item_options(ws, purchase_side), edit=v,
            edit_lines=[
                {"itemId": l["itemId"], "description": l["description"], "qty": l["qty"], "rate": l["rate"],
                 "discountPct": l["discountPct"], "taxRate": l["taxRate"], "serials": "\n".join(l.get("serials") or [])}
                for l in v["lines"]
            ],
            **_pay_context(),
        )


@router.post("/app/billing/{voucher_id}/edit")
def edit_bill(voucher_id: str, request: Request, data: dict = Depends(bill_form)):
    back = f"/app/billing/{voucher_id}/edit"
    try:
        inp = VoucherCreateInput.model_validate(data)
        with session_scope() as db:
            res = vouchers.update_voucher(db, page_actor(db, request), voucher_id, inp)
    except LoginRedirect:
        raise
    except StockError as e:
        return redirect(back if e.status != 403 else f"/app/billing/{voucher_id}", flash=e.message, error=True)
    except ValidationError as e:
        return redirect(back, flash=first_message(e), error=True)
    return redirect(f"/app/billing/{voucher_id}", flash=f"{KIND_LABEL[res['kind']]} {res['number']} updated")


def _list_page(request: Request, group: str, kind: str, status: str, frm: str, to: str, q: str):
    title, kinds = GROUPS[group]
    with session_scope() as db:
        actor = page_actor(db, request)
        visible = [k for k in kinds if can_see_kind(actor, k)]
        if not visible:
            return redirect("/app", flash="Your role doesn't allow this.", error=True)
        if not q and not frm and not to:  # no filter typed: show the selected financial year
            frm, to = fy_range(selected_fy(request))
        f = {"kind": kind if kind in visible else ",".join(visible), "status": status if status in STATUSES else None,
             "from": frm or None, "to": to or None, "q": q or None}
        rows = vouchers.list_vouchers(db, actor, f)
        creatable = [k for k in visible if actor.can(permission_for(k))]
        single = kind if kind in visible else ""
        if single:  # one kind asked for: title and "+ New" are that kind's
            title = KIND_LABEL[single] + "s"
            creatable = [single] if single in creatable else []
        total = sum((-1 if r["kind"].endswith("_RETURN") else 1) * r["total"] for r in rows if r["status"] != "CANCELLED")
        return render(request, "billing/list.html", actor, _active_of(single) if single else group, group=group, title=title, rows=rows, visible=visible,
                      creatable=creatable, kind=kind, status_f=status, frm=frm, to=to, q=q, statuses=STATUSES, total=total)


@router.get("/app/billing/sales")
def sales(request: Request, kind: str = "", status: str = "", to: str = "", q: str = ""):
    return _list_page(request, "sales", kind, status, request.query_params.get("from", ""), to, q)


@router.get("/app/billing/purchases")
def purchases(request: Request, kind: str = "", status: str = "", to: str = "", q: str = ""):
    return _list_page(request, "purchases", kind, status, request.query_params.get("from", ""), to, q)


@router.get("/app/billing/documents")
def documents(request: Request, kind: str = "", status: str = "", to: str = "", q: str = ""):
    return _list_page(request, "documents", kind, status, request.query_params.get("from", ""), to, q)


@router.get("/app/billing/{voucher_id}")
def detail(voucher_id: str, request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        try:
            v = vouchers.get_voucher(db, actor, voucher_id)
        except StockError as e:
            return redirect("/app/billing/sales", flash=e.message, error=True)
        convert_to = CONVERSIONS.get(v["kind"], []) if v["status"] == "OPEN" and actor.can(permission_for(v["kind"])) else []
        return render(
            request, "billing/detail.html", actor, _active_of(v["kind"]), v=v, group=_group_of(v["kind"]),
            convert_to=convert_to, can_edit=actor.is_owner and v["status"] == "OPEN",
            can_cancel=actor.can(permission_for(v["kind"])) and v["status"] not in ("CANCELLED", "CONVERTED"),
        )


@router.post("/app/billing/{voucher_id}/cancel")
def cancel(voucher_id: str, request: Request):
    try:
        with session_scope() as db:
            res = vouchers.cancel_voucher(db, page_actor(db, request), voucher_id)
        return redirect(f"/app/billing/{voucher_id}", flash=f"{res['number']} cancelled")
    except StockError as e:
        return redirect(f"/app/billing/{voucher_id}", flash=e.message, error=True)


@router.post("/app/billing/{voucher_id}/convert")
def convert(voucher_id: str, request: Request, to: str = Form(...)):
    try:
        res = _retry(lambda db: vouchers.convert_voucher(db, page_actor(db, request), voucher_id, to, None))
        return redirect(f"/app/billing/{res['id']}", flash=f"Converted to {KIND_LABEL[to].lower()} {res['number']}")
    except StockError as e:
        return redirect(f"/app/billing/{voucher_id}", flash=e.message, error=True)
    except KeyError:
        return redirect(f"/app/billing/{voucher_id}", flash="Invalid document type", error=True)


# ---------------- printable invoice ----------------


def _title(v: dict) -> str:
    if v["kind"] == "SALE":
        return "TAX INVOICE" if v["gstEnabled"] else "BILL OF SUPPLY"
    return KIND_LABEL[v["kind"]].upper()


def _breakup(v: dict) -> list[dict]:
    m: dict[float, dict] = {}
    for l in v.get("lines") or []:
        e = m.setdefault(l["taxRate"], {"rate": l["taxRate"], "taxable": 0.0, "tax": 0.0})
        e["taxable"] += l["taxable"]
        e["tax"] += l["tax"]
    return sorted(m.values(), key=lambda e: e["rate"])


@router.get("/print/voucher/{voucher_id}", response_class=HTMLResponse)
def print_voucher(voucher_id: str, request: Request, format: str = "a4", t: str = ""):
    fmt = format if format in ("a4", "t58", "t80") else "a4"
    with session_scope() as db:
        if t:
            shared = vouchers.get_shared_voucher(db, voucher_id, t)
            if not shared:
                return templates.TemplateResponse(request, "billing/print_missing.html", {}, status_code=404)
            v, p = shared["voucher"], shared["profile"]
        else:
            actor = page_actor(db, request)
            try:
                v = vouchers.get_voucher(db, actor, voucher_id)
            except StockError:
                return templates.TemplateResponse(request, "billing/print_missing.html", {}, status_code=404)
            p = vouchers.profile_of(actor.owner)
        p = {**p, "gstin": v["godownGstin"], "state": v["godownState"], "address": v["godownAddress"]}  # the issuing godown's identity
        return templates.TemplateResponse(
            request, "billing/print.html",
            {"v": v, "p": p, "fmt": fmt, "title": _title(v), "breakup": _breakup(v) if v["gstEnabled"] else [],
             "words": amount_in_words(v["total"]), "token": t, "kind_label": KIND_LABEL,
             "finance": [r for r in v.get("paymentSplit") or [] if r["mode"] == "FINANCE"],
             "show_disc": any(l["discountPct"] > 0 for l in v.get("lines") or []),
             "width": 58 if fmt == "t58" else 80},
        )

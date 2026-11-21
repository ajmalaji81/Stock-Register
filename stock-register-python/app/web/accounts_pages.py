"""Account vouchers (receipt, payment, credit / debit note, journal)."""
from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Form, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..core.engine import today_iso
from ..core.errors import StockError
from ..core.fy import current_fy, fy_range
from ..db import session_scope
from ..models import Party
from ..schemas import first_message
from ..services import accounts as acc
from .common import need, page_actor, redirect, render, selected_fy

router = APIRouter()
VOUCHER_PERM = ("payments.manage",)
MASTER_PERM = ("payments.manage", "expenses.manage", "reports.view")


def _msg(e: Exception) -> str:
    if isinstance(e, StockError):
        return e.message
    if isinstance(e, ValidationError):
        return first_message(e)
    return "That name already exists"


def _act(request: Request, perms: tuple[str, ...], ok_url: str, fail_url: str, ok_msg: str, fn: Callable[[Any, Any], Any]):
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            need(actor, *perms)
            fn(db, actor)
    except (StockError, ValidationError, IntegrityError) as e:
        return redirect(fail_url, flash=_msg(e), error=True)
    return redirect(ok_url, flash=ok_msg)


def _default_date(request: Request) -> str:
    y = selected_fy(request)
    return today_iso() if y >= current_fy() else fy_range(y)[1]


# ---------------- journal ----------------


@router.get("/app/accounts/journal/new")
def journal_new(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *VOUCHER_PERM)
        return render(request, "accounts/journal_new.html", actor, "journal", flat=acc.flat_chart(acc.chart(db, actor)), today=_default_date(request))


@router.post("/app/accounts/journal")
async def journal_create(request: Request):
    form = await request.form()
    ids, drs, crs, nts = form.getlist("accountId"), form.getlist("debit"), form.getlist("credit"), form.getlist("lineNote")
    lines = [{"accountId": ids[i], "debit": drs[i] if i < len(drs) else "", "credit": crs[i] if i < len(crs) else "",
              "narration": nts[i] if i < len(nts) else ""} for i in range(len(ids))]
    return _act(request, VOUCHER_PERM, "/app/accounts/vouchers?kind=JOURNAL", "/app/accounts/journal/new", "Journal entry saved",
                lambda db, a: acc.create_journal(db, a, str(form.get("date", "")), str(form.get("narration", "")), lines))


# ---------------- credit / debit notes ----------------


@router.get("/app/accounts/notes/new")
def note_new(request: Request, kind: str = "CREDIT_NOTE"):
    kind = kind if kind in acc.NOTE_KINDS else "CREDIT_NOTE"
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *VOUCHER_PERM)
        parties = db.execute(select(Party).where(Party.userId == actor.account_id).order_by(Party.name)).scalars().all()
        return render(request, "accounts/note_new.html", actor, kind.lower(), kind=kind, label=acc.KINDS[kind][1],
                      parties=[{"id": p.id, "name": p.name, "phone": p.phone} for p in parties],
                      flat=acc.flat_chart(acc.chart(db, actor)), today=_default_date(request))


@router.post("/app/accounts/notes")
def note_create(request: Request, kind: str = Form("CREDIT_NOTE"), date: str = Form(""), partyId: str = Form(""),
                accountId: str = Form(""), amount: str = Form("0"), narration: str = Form("")):
    label = acc.KINDS.get(kind, ("", "Note"))[1]
    return _act(request, VOUCHER_PERM, f"/app/accounts/vouchers?kind={kind}", f"/app/accounts/notes/new?kind={kind}", f"{label} saved",
                lambda db, a: acc.create_note(db, a, kind, date, partyId, accountId, amount, narration))


# ---------------- lists ----------------


@router.get("/app/accounts/vouchers")
def voucher_list(request: Request, kind: str = "JOURNAL", frm: str = "", to: str = ""):
    kind = kind if kind in acc.KINDS else "JOURNAL"
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *VOUCHER_PERM)
        if not frm and not to:
            frm, to = fy_range(selected_fy(request))
        rows = acc.list_vouchers(db, actor, kind, frm, to)
        total = sum(r["amount"] for r in rows if r["status"] != "CANCELLED")
        new_url = {"JOURNAL": "/app/accounts/journal/new"}.get(kind, f"/app/accounts/notes/new?kind={kind}")
        return render(request, "accounts/list.html", actor, "journal" if kind == "JOURNAL" else kind.lower(), kind=kind,
                      label=acc.KINDS[kind][1], rows=rows, frm=frm, to=to, total=total, new_url=new_url, line_kinds=acc.LINE_KINDS)


@router.post("/app/accounts/vouchers/{voucher_id}/cancel")
def voucher_cancel(voucher_id: str, request: Request, kind: str = Form("JOURNAL")):
    return _act(request, VOUCHER_PERM, f"/app/accounts/vouchers?kind={kind}", f"/app/accounts/vouchers?kind={kind}", "Cancelled",
                lambda db, a: acc.cancel_voucher(db, a, voucher_id))


# ---------------- receipts and payments ----------------


def _money_list(request: Request, direction: str, frm: str, to: str):
    with session_scope() as db:
        actor = page_actor(db, request)
        need(actor, *VOUCHER_PERM)
        if not frm and not to:
            frm, to = fy_range(selected_fy(request))
        rows = acc.list_money(db, actor, direction, frm, to)
        total = sum(r["amount"] for r in rows if not r["isReversal"] and not r["reversed"])
        key = "receipts" if direction == "IN" else "payments"
        return render(request, "accounts/money_list.html", actor, key, direction=direction, rows=rows, frm=frm, to=to, total=total,
                      label="Receipt" if direction == "IN" else "Payment", base=f"/app/accounts/{key}")


@router.get("/app/accounts/receipts")
def receipts_page(request: Request, frm: str = "", to: str = ""):
    return _money_list(request, "IN", frm, to)


@router.get("/app/accounts/payments")
def payments_page(request: Request, frm: str = "", to: str = ""):
    return _money_list(request, "OUT", frm, to)

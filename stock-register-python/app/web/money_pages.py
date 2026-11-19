"""Parties, payments, expenses + cash book, staff, activity and settings pages."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Form, Request
from fastapi.responses import Response
from pydantic import ValidationError
from sqlalchemy import select

from .. import schemas as S
from ..core.engine import to_csv, today_iso
from ..core.errors import StockError
from ..core.money import EXPENSE_CATEGORIES, PAYMENT_MODES
from ..core.permissions import STAFF_ROLES
from ..db import session_scope
from ..models import Godown
from ..services import parties, staff, vouchers
from ..services.actor import assert_can
from .common import need, page_actor, redirect, render

router = APIRouter()

ACTION_LABELS = {
    "stock.in": "Stock IN", "stock.out": "Stock OUT", "stock.transfer": "Transfer", "stock.adjust": "Adjustment",
    "item.create": "Item added", "item.update": "Item edited", "item.delete": "Item deleted", "item.import": "Items imported",
    "godown.create": "Godown added", "godown.rename": "Godown renamed", "godown.delete": "Godown deleted",
    "staff.create": "Staff added", "staff.update": "Staff changed", "staff.delete": "Staff removed",
    "voucher.create": "Bill / document created", "voucher.cancel": "Bill cancelled", "voucher.convert": "Document converted",
    "party.create": "Party added", "party.update": "Party edited", "party.delete": "Party deleted", "party.import": "Parties imported",
    "payment.create": "Payment recorded", "payment.reverse": "Payment reversed",
    "expense.create": "Expense added", "expense.delete": "Expense deleted",
    "settings.update": "Settings changed", "profile.update": "Profile picture changed",
}


def action_label(action: str) -> str:
    if action in ACTION_LABELS:
        return ACTION_LABELS[action]
    area, _, verb = action.partition(".")
    return f"{area[:1].upper()}{area[1:]} {verb}".strip()


def _tone(action: str) -> str:
    if action == "stock.in" or action.endswith((".create", ".import")):
        return "in"
    if action == "stock.out" or action.endswith(".delete"):
        return "out"
    return "low" if action == "stock.adjust" else ""


def _fail(url: str, e: Exception):
    if isinstance(e, StockError):
        return redirect(url, e.message, error=True)
    if isinstance(e, ValidationError):
        return redirect(url, S.first_message(e), error=True)
    raise e


def _num(v: str, default: float = 0) -> float:
    try:
        return float(v) if v.strip() != "" else default
    except ValueError:
        return default


# ---------------- parties ----------------


@router.get("/app/parties")
def parties_page(request: Request, q: str = "", type: str = "", sort: str = ""):
    with session_scope() as db:
        actor = page_actor(db, request)
        parties.assert_can_view_parties(actor)
        try:
            qq = S.PartyQuery.model_validate({k: v for k, v in {"q": q, "type": type, "sort": sort}.items() if v})
            data = parties.list_parties(db, actor, {"q": qq.q, "type": qq.type, "sort": qq.sort})
        except (ValidationError, StockError) as e:
            return _fail("/app", e)
        return render(request, "money/parties.html", actor, "parties", data=data, q=q, type=type, sort=sort, modes=PAYMENT_MODES, today=today_iso())


def _party_form(name, type, phone, email, gstin, state, address, openingBalance):
    return S.PartyInput.model_validate(
        {"name": name, "type": type, "phone": phone, "email": email, "gstin": gstin, "state": state, "address": address,
         "openingBalance": _num(openingBalance)}
    )


@router.post("/app/parties")
def party_create(request: Request, name: str = Form(""), type: str = Form("CUSTOMER"), phone: str = Form(""), email: str = Form(""),
                 gstin: str = Form(""), state: str = Form(""), address: str = Form(""), openingBalance: str = Form("0")):
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            r = parties.create_party(db, actor, _party_form(name, type, phone, email, gstin, state, address, openingBalance))
        return redirect(f"/app/parties/{r['id']}", "Party added")
    except (StockError, ValidationError) as e:
        return _fail("/app/parties", e)


@router.post("/app/parties/{party_id}/update")
def party_update(party_id: str, request: Request, name: str = Form(""), type: str = Form("CUSTOMER"), phone: str = Form(""),
                 email: str = Form(""), gstin: str = Form(""), state: str = Form(""), address: str = Form(""), openingBalance: str = Form("0")):
    url = f"/app/parties/{party_id}"
    try:
        with session_scope() as db:
            parties.update_party(db, page_actor(db, request), party_id, _party_form(name, type, phone, email, gstin, state, address, openingBalance))
        return redirect(url, "Party saved")
    except (StockError, ValidationError) as e:
        return _fail(url, e)


@router.post("/app/parties/{party_id}/delete")
def party_delete(party_id: str, request: Request):
    try:
        with session_scope() as db:
            parties.delete_party(db, page_actor(db, request), party_id)
        return redirect("/app/parties", "Party deleted")
    except StockError as e:
        return _fail(f"/app/parties/{party_id}", e)


def _ledger_args(party_id: str, db, actor, frm: str, to: str):
    q = S.DateRange.model_validate({k: v for k, v in {"from": frm, "to": to}.items() if v})
    return parties.party_ledger(db, actor, party_id, q.from_, q.to)


@router.get("/app/parties/{party_id}")
def party_detail(party_id: str, request: Request, frm: str = "", to: str = ""):
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            row = parties.get_party_row(db, actor, party_id)
            ledger = _ledger_args(party_id, db, actor, frm, to)
            pays = parties.list_payments(db, actor, {"partyId": party_id}) if actor.can("payments.manage") else []
            return render(request, "money/party.html", actor, "parties", p=row, ledger=ledger, payments=pays, frm=frm, to=to,
                          modes=PAYMENT_MODES, today=today_iso())
    except (StockError, ValidationError) as e:
        return _fail("/app/parties", e)


@router.get("/app/parties/{party_id}/ledger.csv")
def party_ledger_csv(party_id: str, request: Request, frm: str = "", to: str = ""):
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            ledger = _ledger_args(party_id, db, actor, frm, to)
    except (StockError, ValidationError) as e:
        return _fail(f"/app/parties/{party_id}", e)
    rows = [["Date", "Particulars", "Debit", "Credit", "Balance"]] + [
        [r["date"], r["ref"], r["debit"] or "", r["credit"] or "", r["balance"]] for r in ledger["rows"]
    ]
    return Response(to_csv(rows), media_type="text/csv", headers={"content-disposition": f'attachment; filename="ledger-{party_id}.csv"'})


@router.post("/app/payments")
def payment_create(request: Request, partyId: str = Form(""), direction: str = Form("IN"), amount: str = Form("0"), mode: str = Form("CASH"),
                   date: str = Form(""), reference: str = Form(""), notes: str = Form("")):
    url = f"/app/parties/{partyId}" if partyId else "/app/parties"
    try:
        inp = S.PaymentInput.model_validate({"partyId": partyId, "direction": direction, "amount": _num(amount), "mode": mode,
                                             "date": date or today_iso(), "reference": reference, "notes": notes})
        with session_scope() as db:
            parties.create_payment(db, page_actor(db, request), inp)
        return redirect(url, "Payment recorded")
    except (StockError, ValidationError) as e:
        return _fail(url, e)


@router.post("/app/payments/{payment_id}/reverse")
def payment_reverse(payment_id: str, request: Request, partyId: str = Form("")):
    url = f"/app/parties/{partyId}" if partyId else "/app/parties"
    try:
        with session_scope() as db:
            parties.reverse_payment(db, page_actor(db, request), payment_id)
        return redirect(url, "Payment reversed")
    except StockError as e:
        return _fail(url, e)


# ---------------- expenses & cash book ----------------


@router.get("/app/expenses")
def expenses_page(request: Request, category: str = "", frm: str = "", to: str = "", cb_from: str = "", cb_to: str = ""):
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            q = S.ExpenseQuery.model_validate({k: v for k, v in {"category": category, "from": frm, "to": to}.items() if v})
            data = parties.list_expenses(db, actor, {"category": q.category, "from": q.from_, "to": q.to})
            cb = None
            if actor.can("reports.view") or actor.can("payments.manage"):
                r = S.DateRange.model_validate({k: v for k, v in {"from": cb_from, "to": cb_to}.items() if v})
                cb = parties.cashbook(db, actor, r.from_, r.to)
            return render(request, "money/expenses.html", actor, "expenses", data=data, cb=cb, category=category, frm=frm, to=to,
                          cb_from=cb_from, cb_to=cb_to, categories=EXPENSE_CATEGORIES, modes=PAYMENT_MODES, today=today_iso())
    except (StockError, ValidationError) as e:
        return _fail("/app", e)


@router.post("/app/expenses")
def expense_create(request: Request, category: str = Form(""), amount: str = Form("0"), mode: str = Form("CASH"), date: str = Form(""), notes: str = Form("")):
    try:
        inp = S.ExpenseInput.model_validate({"category": category, "amount": _num(amount), "mode": mode, "date": date or today_iso(), "notes": notes})
        with session_scope() as db:
            parties.create_expense(db, page_actor(db, request), inp)
        return redirect("/app/expenses", "Expense added")
    except (StockError, ValidationError) as e:
        return _fail("/app/expenses", e)


@router.post("/app/expenses/{expense_id}/delete")
def expense_delete(expense_id: str, request: Request):
    try:
        with session_scope() as db:
            parties.delete_expense(db, page_actor(db, request), expense_id)
        return redirect("/app/expenses", "Expense deleted")
    except StockError as e:
        return _fail("/app/expenses", e)


# ---------------- staff ----------------


@router.get("/app/staff")
def staff_page(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        try:
            assert_can(actor, "staff.manage")
        except StockError as e:
            return _fail("/app", e)
        godowns = db.execute(select(Godown).where(Godown.userId == actor.account_id).order_by(Godown.createdAt, Godown.id)).scalars().all()
        from ..core.plans import effective_plan

        return render(request, "money/staff.html", actor, "staff", staff=staff.list_staff(db, actor),
                      godowns=[{"id": g.id, "name": g.name} for g in godowns], roles=STAFF_ROLES,
                      pro=effective_plan(actor.owner.plan, actor.owner.trialEndsAt) != "FREE")


@router.post("/app/staff")
def staff_create(request: Request, name: str = Form(""), email: str = Form(""), password: str = Form(""), role: str = Form(""),
                 godownIds: list[str] = Form([])):
    try:
        inp = S.StaffCreateInput.model_validate({"name": name, "email": email, "password": password, "role": role, "godownIds": godownIds})
        with session_scope() as db:
            staff.create_staff(db, page_actor(db, request), inp)
        return redirect("/app/staff", "Staff added")
    except (StockError, ValidationError) as e:
        return _fail("/app/staff", e)


@router.post("/app/staff/{staff_id}/update")
def staff_update(staff_id: str, request: Request, name: str = Form(""), role: str = Form(""), active: str = Form(""),
                 password: str = Form(""), godownIds: list[str] = Form([])):
    try:
        data: dict = {"name": name or None, "role": role or None, "active": active == "on", "godownIds": godownIds}
        if password:
            data["password"] = password
        inp = S.StaffUpdateInput.model_validate(data)
        with session_scope() as db:
            staff.update_staff(db, page_actor(db, request), staff_id, inp)
        return redirect("/app/staff", "Staff saved")
    except (StockError, ValidationError) as e:
        return _fail("/app/staff", e)


@router.post("/app/staff/{staff_id}/delete")
def staff_delete(staff_id: str, request: Request):
    try:
        with session_scope() as db:
            staff.delete_staff(db, page_actor(db, request), staff_id)
        return redirect("/app/staff", "Staff removed")
    except StockError as e:
        return _fail("/app/staff", e)


# ---------------- activity ----------------


@router.get("/app/activity")
def activity_page(request: Request, actorId: str = "", action: str = "", frm: str = "", to: str = "", page: str = "1"):
    try:
        with session_scope() as db:
            actor = page_actor(db, request)
            assert_can(actor, "activity.view")
            q = S.ActivityQuery.model_validate({k: v for k, v in {"actorId": actorId, "action": action, "from": frm, "to": to, "page": page}.items() if v})
            data = staff.list_activity(db, actor, q)
            for i in data["items"]:
                i["label"], i["tone"] = action_label(i["action"]), _tone(i["action"])
            pages = max(1, -(-data["total"] // data["size"]))
            return render(request, "money/activity.html", actor, "activity", data=data, pages=pages, actorId=actorId, action=action,
                          frm=frm, to=to, areas=sorted({a.split(".")[0] for a in ACTION_LABELS}))
    except (StockError, ValidationError) as e:
        return _fail("/app", e)


# ---------------- settings ----------------


@router.get("/app/settings")
def settings_page(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        try:
            assert_can(actor, "settings.manage")
        except StockError as e:
            return _fail("/app", e)
        return render(request, "money/settings.html", actor, "settings", profile=vouchers.profile_of(actor.owner))


@router.post("/app/settings")
def settings_save(request: Request, businessName: str = Form(""), gstin: str = Form(""), address: str = Form(""), state: str = Form(""),
                  phone: str = Form(""), invoicePrefix: str = Form("INV"), invoiceTerms: str = Form(""), bankDetails: str = Form("")):
    try:
        inp = S.SettingsInput.model_validate(
            {"businessName": businessName, "gstin": gstin, "address": address, "state": state, "phone": phone,
             "invoicePrefix": invoicePrefix, "invoiceTerms": invoiceTerms, "bankDetails": bankDetails}
        )
        with session_scope() as db:
            actor = page_actor(db, request)
            assert_can(actor, "settings.manage")
            vouchers.update_profile(db, actor, inp)
        return redirect("/app/settings", "Settings saved")
    except (StockError, ValidationError) as e:
        return _fail("/app/settings", e)

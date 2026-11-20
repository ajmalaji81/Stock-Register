"""JSON API: same paths, request/response shapes and error envelope as the Next.js `app/api` routes."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from .. import config
from ..core.avatar import avatar_error
from ..core.errors import StockError
from ..core.plans import effective_plan, limits_for, trial_end_from, utcnow
from ..core.ppp import country_from_headers, price_for
from ..db import session_scope
from ..models import Godown, Item, Payment, StaffMember, User, WebhookEvent
from .. import schemas as S
from ..services import branch as branch_svc, parties, staff, stock, vouchers
from ..services.activity import log_activity
from ..services.actor import actor_info, current_actor, require_actor, require_permission
from ..services.auth import DUMMY_HASH, end_session, hash_password, start_session, verify_password

router = APIRouter(prefix="/api")


def ok(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status)


def qparams(request: Request) -> dict:
    return dict(request.query_params)


# ---------------- auth ----------------


@router.post("/auth/signup")
def signup(body: S.SignupInput):
    with session_scope() as db:
        if db.execute(select(User.id).where(User.email == body.email)).first():
            raise StockError("An account with this email already exists. Log in instead.", 409)
        if db.execute(select(StaffMember.id).where(StaffMember.email == body.email)).first():
            raise StockError("This email is used by a staff login. Log in with it, or sign up with a different email.", 409)
        user = User(name=body.name, email=body.email, passwordHash=hash_password(body.password), trialEndsAt=trial_end_from(utcnow()))
        db.add(user)
        db.flush()
        db.add(Godown(userId=user.id, name="Main Shop"))
        user_id = user.id
    res = ok({"ok": True}, 201)
    start_session(res, user_id)
    return res


@router.post("/auth/login")
def login(body: S.LoginInput):
    """One login form for owners and staff. Emails are unique across both tables (enforced at creation)."""
    with session_scope() as db:
        user = db.execute(select(User).where(User.email == body.email)).scalar_one_or_none()
        member = db.execute(select(StaffMember).where(StaffMember.email == body.email)).scalar_one_or_none()
        # An email that exists in both tables (shouldn't happen) is refused rather than guessed.
        target = None
        if user and not member:
            target = (user.id, user.passwordHash, "owner")
        elif member and not user and member.active:
            target = (member.id, member.passwordHash, "staff")
    okpw = verify_password(body.password, target[1] if target else DUMMY_HASH)
    if not target or not okpw:
        raise StockError("Wrong email or password", 401)
    res = ok({"ok": True, "kind": target[2]})
    start_session(res, target[0], target[2])
    return res


@router.post("/auth/logout")
def logout():
    res = ok({"ok": True})
    end_session(res)
    return res


@router.get("/me")
def me(request: Request):
    with session_scope() as db:
        a = current_actor(db, request)
        if a is None:
            return ok({"user": None}, 401)
        return ok({"user": {"name": a.owner.name, "email": a.owner.email, "plan": a.owner.plan}, "actor": actor_info(a)})


@router.get("/workspace")
def workspace(request: Request):
    with session_scope() as db:
        return ok(stock.load_workspace(db, require_actor(db, request)))


@router.get("/profile")
def get_profile(request: Request):
    with session_scope() as db:
        a = require_actor(db, request)
        return ok({"name": a.name, "email": a.email, "role": a.role, "avatar": a.avatar})


@router.patch("/profile")
def patch_profile(request: Request, body: S.ProfileBody):
    with session_scope() as db:
        a = require_actor(db, request)
        if body.avatar is not None:
            err = avatar_error(body.avatar)
            if err:
                raise StockError(err, 400)
        target = db.get(User, a.actor_id) if a.is_owner else db.get(StaffMember, a.actor_id)
        target.avatar = body.avatar
        db.flush()
        log_activity(db, a, "profile.update", "New profile picture" if body.avatar else "Removed profile picture")
        return ok({"ok": True, "avatar": body.avatar})


# ---------------- stock ----------------


@router.post("/items")
def create_item(request: Request, body: S.ItemInput):
    with session_scope() as db:
        stock.create_item(db, require_permission(db, request, "items.manage"), body)
    return ok({"ok": True}, 201)


@router.patch("/items/{item_id}")
def update_item(item_id: str, request: Request, body: S.ItemInput):
    with session_scope() as db:
        stock.update_item(db, require_permission(db, request, "items.manage"), item_id, body)
    return ok({"ok": True})


@router.delete("/items/{item_id}")
def delete_item(item_id: str, request: Request):
    with session_scope() as db:
        stock.delete_item(db, require_permission(db, request, "items.manage"), item_id)
    return ok({"ok": True})


@router.post("/items/import")
def import_items(request: Request, body: S.ItemImportBody):
    """Bulk-create items. Each row is its own transaction; returns a result per row."""
    with session_scope() as db:
        actor = require_permission(db, request, "items.manage")
        godowns = db.execute(select(Godown.id, Godown.name).where(Godown.userId == actor.account_id).order_by(Godown.createdAt, Godown.id)).all()
        count = db.execute(select(func.count()).select_from(Item).where(Item.userId == actor.account_id)).scalar_one()
        owner = actor.owner
        maximum = limits_for(owner.plan, owner.trialEndsAt)["maxItems"]
    by_name = {n.lower(): i for i, n in godowns}
    results: list[dict] = []
    created = 0
    for i, r in enumerate(body.rows):
        line = r.line if r.line is not None else i + 2
        try:
            if maximum is not None and count >= maximum:
                raise StockError(f"Free plan is limited to {maximum} items. Get Lifetime Pro for unlimited items.", 402, "LIMIT")
            opening_godown = None
            if r.openingQty > 0:
                opening_godown = by_name.get(r.openingGodown.strip().lower()) if r.openingGodown else (godowns[0][0] if godowns else None)
                if not opening_godown:
                    raise StockError(f'Godown "{r.openingGodown}" not found')
            inp = S.ItemInput.model_validate({**r.model_dump(exclude={"line"}), "openingGodownId": opening_godown, "openingQty": r.openingQty or None})
            with session_scope() as db:  # each row is its own transaction
                actor = require_permission(db, request, "items.manage")
                stock.create_item(db, actor, inp)
            count += 1
            created += 1
            results.append({"line": line, "ok": True})
        except ValidationError as e:
            results.append({"line": line, "ok": False, "error": S.first_message(e)})
        except IntegrityError:
            results.append({"line": line, "ok": False, "error": f'SKU "{r.sku}" already exists'})
        except StockError as e:
            results.append({"line": line, "ok": False, "error": e.message})
    if created > 0:
        with session_scope() as db:
            log_activity(db, require_permission(db, request, "items.manage"), "item.import", f"{created} items imported")
    return ok({"created": created, "failed": len(results) - created, "results": results})


@router.post("/godowns")
def create_godown(request: Request, body: S.GodownInput):
    with session_scope() as db:
        stock.create_godown(db, require_permission(db, request, "godowns.manage"), body.name)
    return ok({"ok": True}, 201)


@router.patch("/godowns/{godown_id}")
def rename_godown(godown_id: str, request: Request, body: S.GodownInput):
    """Rename, and/or set the godown's own state / GSTIN / address (whatever is sent)."""
    with session_scope() as db:
        stock.update_godown(db, require_permission(db, request, "godowns.manage"), godown_id, body)
    return ok({"ok": True})


@router.get("/branch/pending")
def branch_pending(request: Request):
    with session_scope() as db:
        return ok(branch_svc.pending_for(db, require_actor(db, request)))


@router.post("/vouchers/{voucher_id}/branch/approve")
def branch_approve(voucher_id: str, request: Request):
    with session_scope() as db:
        return ok(branch_svc.approve(db, require_actor(db, request), voucher_id))


@router.post("/vouchers/{voucher_id}/branch/reject")
def branch_reject(voucher_id: str, request: Request):
    with session_scope() as db:
        return ok(branch_svc.reject(db, require_actor(db, request), voucher_id))


@router.delete("/godowns/{godown_id}")
def delete_godown(godown_id: str, request: Request):
    with session_scope() as db:
        stock.delete_godown(db, require_permission(db, request, "godowns.manage"), godown_id)
    return ok({"ok": True})


@router.post("/movements")
def movements(request: Request, body: S.MovementInput):
    with session_scope() as db:
        stock.record_movement(db, require_permission(db, request, "stock.move"), body)
    return ok({"ok": True}, 201)


@router.post("/transfers")
def transfers(request: Request, body: S.TransferInput):
    with session_scope() as db:
        stock.transfer_stock(db, require_permission(db, request, "stock.transfer"), body)
    return ok({"ok": True}, 201)


@router.get("/ledger")
def ledger(request: Request):
    # Any signed-in actor may read the ledger for the godowns they can access (the dashboard needs it).
    with session_scope() as db:
        actor = require_actor(db, request)
        q = S.parse_query(S.LedgerQuery, qparams(request))
        return ok(stock.list_ledger(db, actor, {"itemId": q.itemId, "godownId": q.godownId, "type": q.type, "from": q.from_, "to": q.to}))


@router.get("/adjustments")
def get_adjustments(request: Request):
    with session_scope() as db:
        return ok(staff.list_adjustments(db, require_permission(db, request, "stock.adjust")))


@router.post("/adjustments")
def post_adjustment(request: Request, body: S.AdjustmentInput):
    with session_scope() as db:
        return ok(staff.record_adjustment(db, require_permission(db, request, "stock.adjust"), body), 201)


# ---------------- billing ----------------


@router.get("/vouchers")
def get_vouchers(request: Request):
    with session_scope() as db:
        actor = require_actor(db, request)
        q = S.parse_query(S.VoucherListQuery, qparams(request))
        f = {"kind": q.kind, "partyId": q.partyId, "status": q.status, "from": q.from_, "to": q.to, "q": q.q}
        return ok(vouchers.list_vouchers(db, actor, f))


def _with_number_retry(fn):
    """Two bills numbered at the same moment: try once more with the next number."""
    try:
        with session_scope() as db:
            return fn(db)
    except IntegrityError:
        with session_scope() as db:
            return fn(db)


@router.post("/vouchers")
def post_voucher(request: Request, body: S.VoucherCreateInput):
    def work(db):
        return vouchers.create_voucher(db, require_actor(db, request), body)

    return ok(_with_number_retry(work), 201)


@router.get("/vouchers/{voucher_id}")
def get_voucher(voucher_id: str, request: Request):
    with session_scope() as db:
        return ok(vouchers.get_voucher(db, require_actor(db, request), voucher_id))


@router.put("/vouchers/{voucher_id}")
def put_voucher(voucher_id: str, request: Request, body: S.VoucherCreateInput):
    with session_scope() as db:
        return ok(vouchers.update_voucher(db, require_actor(db, request), voucher_id, body))


@router.post("/vouchers/{voucher_id}/cancel")
def cancel_voucher(voucher_id: str, request: Request):
    with session_scope() as db:
        return ok(vouchers.cancel_voucher(db, require_actor(db, request), voucher_id))


@router.post("/vouchers/{voucher_id}/convert")
def convert_voucher(voucher_id: str, request: Request, body: S.VoucherConvertInput):
    def work(db):
        return vouchers.convert_voucher(db, require_actor(db, request), voucher_id, body.to, body.date)

    return ok(_with_number_retry(work), 201)


@router.get("/settings")
def get_settings(request: Request):
    # Any signed-in actor may read the business profile (needed for bills); only settings.manage may change it.
    with session_scope() as db:
        return ok(vouchers.profile_of(require_actor(db, request).owner))


@router.put("/settings")
async def put_settings(request: Request):
    # Fields left out of the body keep their saved values (the schema defaults would otherwise blank them).
    try:
        body: Any = await request.json()
    except ValueError as e:
        raise StockError("Invalid JSON body", 400) from e
    with session_scope() as db:
        actor = require_permission(db, request, "settings.manage")
        sent = body if isinstance(body, dict) else {}
        merged = {**vouchers.profile_of(actor.owner), **{k: v for k, v in sent.items() if v is not None}}
        return ok(vouchers.update_profile(db, actor, S.SettingsInput.model_validate(merged)))


@router.get("/reports/sales")
def sales_report(request: Request):
    with session_scope() as db:
        actor = require_actor(db, request)
        q = S.parse_query(S.SalesReportQuery, qparams(request))
        return ok(vouchers.sales_report(db, actor, q.side, q.from_, q.to))


# ---------------- parties & money ----------------


@router.get("/parties")
def get_parties(request: Request):
    with session_scope() as db:
        actor = require_actor(db, request)
        q = S.parse_query(S.PartyQuery, qparams(request))
        branch_svc.ensure_all(db, actor.account_id)  # own godowns show up as parties
        return ok(parties.list_parties(db, actor, {"q": q.q, "type": q.type, "sort": q.sort}))


@router.post("/parties")
def post_party(request: Request, body: S.PartyInput):
    with session_scope() as db:
        return ok(parties.create_party(db, require_actor(db, request), body), 201)


@router.post("/parties/import")
def import_parties(request: Request, body: S.PartyImportBody):
    with session_scope() as db:
        return ok(parties.import_parties(db, require_actor(db, request), body.rows))


@router.get("/parties/{party_id}")
def get_party(party_id: str, request: Request):
    with session_scope() as db:
        return ok(parties.get_party_row(db, require_actor(db, request), party_id))


@router.patch("/parties/{party_id}")
def patch_party(party_id: str, request: Request, body: S.PartyInput):
    with session_scope() as db:
        parties.update_party(db, require_actor(db, request), party_id, body)
    return ok({"ok": True})


@router.delete("/parties/{party_id}")
def remove_party(party_id: str, request: Request):
    with session_scope() as db:
        parties.delete_party(db, require_actor(db, request), party_id)
    return ok({"ok": True})


@router.get("/parties/{party_id}/ledger")
def get_party_ledger(party_id: str, request: Request):
    with session_scope() as db:
        q = S.parse_query(S.DateRange, qparams(request))
        return ok(parties.party_ledger(db, require_actor(db, request), party_id, q.from_, q.to))


@router.get("/payments")
def get_payments(request: Request):
    with session_scope() as db:
        q = S.parse_query(S.PaymentQuery, qparams(request))
        f = {"partyId": q.partyId, "direction": q.direction, "mode": q.mode, "from": q.from_, "to": q.to}
        return ok(parties.list_payments(db, require_actor(db, request), f))


@router.post("/payments")
def post_payment(request: Request, body: S.PaymentInput):
    with session_scope() as db:
        return ok(parties.create_payment(db, require_actor(db, request), body), 201)


@router.post("/payments/{payment_id}/reverse")
def reverse_payment(payment_id: str, request: Request):
    with session_scope() as db:
        return ok(parties.reverse_payment(db, require_actor(db, request), payment_id), 201)


@router.get("/expenses")
def get_expenses(request: Request):
    with session_scope() as db:
        q = S.parse_query(S.ExpenseQuery, qparams(request))
        return ok(parties.list_expenses(db, require_actor(db, request), {"category": q.category, "from": q.from_, "to": q.to}))


@router.post("/expenses")
def post_expense(request: Request, body: S.ExpenseInput):
    with session_scope() as db:
        return ok(parties.create_expense(db, require_actor(db, request), body), 201)


@router.delete("/expenses/{expense_id}")
def remove_expense(expense_id: str, request: Request):
    with session_scope() as db:
        parties.delete_expense(db, require_actor(db, request), expense_id)
    return ok({"ok": True})


@router.get("/cashbook")
def get_cashbook(request: Request):
    with session_scope() as db:
        q = S.parse_query(S.DateRange, qparams(request))
        return ok(parties.cashbook(db, require_actor(db, request), q.from_, q.to))


# ---------------- staff & activity ----------------


@router.get("/staff")
def get_staff(request: Request):
    with session_scope() as db:
        actor = require_permission(db, request, "staff.manage")
        return ok({"staff": staff.list_staff(db, actor), "plan": effective_plan(actor.owner.plan, actor.owner.trialEndsAt)})


@router.post("/staff")
def post_staff(request: Request, body: S.StaffCreateInput):
    with session_scope() as db:
        return ok(staff.create_staff(db, require_permission(db, request, "staff.manage"), body), 201)


@router.patch("/staff/{staff_id}")
def patch_staff(staff_id: str, request: Request, body: S.StaffUpdateInput):
    # Only staff ids are accepted here, so the owner can never be demoted or deleted through this route.
    with session_scope() as db:
        return ok(staff.update_staff(db, require_permission(db, request, "staff.manage"), staff_id, body))


@router.delete("/staff/{staff_id}")
def remove_staff(staff_id: str, request: Request):
    with session_scope() as db:
        staff.delete_staff(db, require_permission(db, request, "staff.manage"), staff_id)
    return ok({"ok": True})


@router.get("/activity")
def get_activity(request: Request):
    with session_scope() as db:
        actor = require_permission(db, request, "activity.view")
        return ok(staff.list_activity(db, actor, S.parse_query(S.ActivityQuery, qparams(request))))


# ---------------- billing (Dodo Payments) ----------------


@router.post("/checkout")
def checkout(request: Request):
    """Starts a Dodo one-time checkout for Lifetime Pro, priced for the visitor's country."""
    from dodopayments import DodoPayments

    with session_scope() as db:
        actor = require_permission(db, request, "billing.upgrade")
        user = actor.owner
        if user.plan == "PRO":
            raise StockError("You already have Lifetime Pro", 400)
        email, name, user_id = user.email, user.name, user.id
    product_id = config.env("DODO_PRODUCT_ID")
    if not product_id:
        raise RuntimeError("DODO_PRODUCT_ID is not set")
    key = config.env("DODO_PAYMENTS_API_KEY")
    if not key:
        raise RuntimeError("DODO_PAYMENTS_API_KEY is not set")
    price = price_for(country_from_headers(dict(request.headers)))
    params: dict[str, Any] = {
        # `amount` sets the price for a Pay-What-You-Want product (our PPP price).
        # If the product isn't PWYW, Dodo ignores it and charges the product's fixed price.
        "product_cart": [{"product_id": product_id, "quantity": 1, "amount": price["amountCents"]}],
        "customer": {"email": email, "name": name},
        "return_url": f"{config.app_url()}/upgrade/success",
        "cancel_url": f"{config.app_url()}/app",
        "metadata": {"userId": user_id, "pppCountry": price["country"] or "", "pppAmountCents": str(price["amountCents"])},
    }
    # Pre-filling the country lets Dodo's adaptive pricing show the local currency.
    if price["country"]:
        params["billing_address"] = {"country": price["country"]}
    client = DodoPayments(
        bearer_token=key, environment="live_mode" if config.env("DODO_PAYMENTS_ENVIRONMENT") == "live_mode" else "test_mode"
    )
    session = client.checkout_sessions.create(**params)
    if not session.checkout_url:
        raise RuntimeError("Dodo did not return a checkout URL")
    return ok({"url": session.checkout_url})


@router.post("/webhooks/dodo")
async def dodo_webhook(request: Request):
    """Verifies the Standard Webhooks signature, then on `payment.succeeded` for our Lifetime
    product upgrades the buyer to PRO. Safe to receive the same event twice."""
    from standardwebhooks import Webhook

    secret = config.env("DODO_WEBHOOK_SECRET")
    if not secret:
        return ok({"error": "Webhook not configured"}, 500)
    raw = await request.body()
    headers = {
        "webhook-id": request.headers.get("webhook-id", ""),
        "webhook-signature": request.headers.get("webhook-signature", ""),
        "webhook-timestamp": request.headers.get("webhook-timestamp", ""),
    }
    try:
        event = Webhook(secret).verify(raw, headers)
        if isinstance(event, (str, bytes)):
            event = json.loads(event)
    except Exception:  # noqa: BLE001 - any verification failure is a 401
        return ok({"error": "Invalid signature"}, 401)

    if event.get("type") != "payment.succeeded":
        return ok({"received": True})
    p = event.get("data") or {}
    product_id = config.env("DODO_PRODUCT_ID")
    cart = p.get("product_cart") or []
    if product_id and cart and not any(c.get("product_id") == product_id for c in cart):
        return ok({"received": True, "ignored": "other product"})
    if not p.get("payment_id"):
        return ok({"error": "Missing payment_id"}, 400)

    try:
        with session_scope() as db:
            user = None
            uid = (p.get("metadata") or {}).get("userId")
            if uid:
                user = db.get(User, uid)
            email = (p.get("customer") or {}).get("email")
            if user is None and email:
                user = db.execute(select(User).where(User.email == email.lower())).scalar_one_or_none()
            if user is None:
                # Acknowledge so Dodo stops retrying; the payment is visible in the Dodo dashboard.
                return ok({"received": True, "ignored": "no user"})
            db.add(WebhookEvent(id=headers["webhook-id"], type=event["type"]))
            db.flush()  # a repeated webhook-id violates the primary key -> duplicate
            existing = db.execute(select(Payment).where(Payment.dodoPaymentId == p["payment_id"])).scalar_one_or_none()
            if existing:
                existing.status = "succeeded"
            else:
                db.add(Payment(userId=user.id, dodoPaymentId=p["payment_id"], status="succeeded",
                               amount=int(p.get("total_amount") or 0), currency=p.get("currency") or ""))
            user.plan = "PRO"
            user.proSince = user.proSince or utcnow()
    except IntegrityError:
        return ok({"received": True, "duplicate": True})
    return ok({"received": True})


# Re-exported for the web layer.
__all__ = ["router", "ok"]

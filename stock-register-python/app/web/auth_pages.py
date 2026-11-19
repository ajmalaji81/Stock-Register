"""Landing, login/signup/logout, upgrade and profile-picture pages."""
from __future__ import annotations

import base64

import time
from urllib.parse import quote

import jwt
from fastapi import APIRouter, BackgroundTasks, Form, Request
from pydantic import ValidationError
from sqlalchemy import select

from .. import config
from ..core.avatar import avatar_error
from ..core.errors import StockError
from ..core.plans import trial_end_from, utcnow
from ..core.ppp import country_from_headers, format_usd, price_for
from ..db import session_scope
from ..models import Godown, StaffMember, User
from ..schemas import LoginInput, Password8, SignupInput, first_message
from ..services.mailer import send_mail
from ..services.activity import log_activity
from ..services.actor import current_actor
from ..services.auth import DUMMY_HASH, end_session, hash_password, start_session, verify_password
from .common import page_actor, redirect, render

router = APIRouter()

FAQ = [
    ("How does the free trial work?", "Every new account gets all Pro features for 90 days. After that you can stay on the Free plan (5 items, 2 godowns) or pay once for Lifetime Pro. Nothing you entered is ever deleted."),
    ("Is it really a one-time payment?", "Yes. Lifetime Pro is a single payment with no subscription and no renewal."),
    ("Why is the price different in my country?", "We use fair, purchasing-power-based pricing. Your discount is applied automatically based on where you are."),
    ("Can it make GST bills?", "Yes. Add your GSTIN and each item's HSN and tax rate, and bills split tax into CGST/SGST or IGST automatically."),
    ("Can someone edit old entries?", "Stock ledger entries are never edited. Only the account owner can edit an open bill, and every edit is logged with who made it and when."),
]
FEATURES = [
    ("Stock", "Multi-godown stock, transfers, an immutable ledger, adjustments and low-stock alerts."),
    ("Billing", "GST bills, returns, quotations, orders and challans with printable invoices."),
    ("Money", "Parties, payments, expenses and a cash book."),
    ("Team", "Staff roles, godown access and a full activity log."),
]
FREE_FEATURES = ["First 90 days: every Pro feature", "Then up to 5 items & 2 godowns", "Stock IN / OUT / Transfer", "Ledger, reports, CSV & PDF"]
PRO_FEATURES = ["Unlimited items & godowns", "Staff logins with roles", "GST billing & parties", "One payment, no renewal"]


def _price(request: Request) -> dict:
    p = price_for(country_from_headers(dict(request.headers)))
    return {**p, "amount": format_usd(p["amountCents"]), "base": format_usd(p["baseCents"])}


def _signed_in(request: Request) -> bool:
    with session_scope() as db:
        return current_actor(db, request) is not None


@router.get("/")
def landing(request: Request):
    return render(request, "auth/landing.html", signed_in=_signed_in(request), price=_price(request), faq=FAQ,
                  features=FEATURES, free_features=FREE_FEATURES, pro_features=PRO_FEATURES)


@router.get("/login")
def login_page(request: Request):
    if _signed_in(request):
        return redirect("/app")
    return render(request, "auth/login.html", error="", email="")


@router.post("/login")
def login_submit(request: Request, email: str = Form(""), password: str = Form("")):
    def fail(msg: str, status: int = 400):
        return render(request, "auth/login.html", status=status, error=msg, email=email)

    try:
        body = LoginInput.model_validate({"email": email, "password": password})
    except ValidationError as e:
        return fail(first_message(e))
    with session_scope() as db:
        user = db.execute(select(User).where(User.email == body.email)).scalar_one_or_none()
        member = db.execute(select(StaffMember).where(StaffMember.email == body.email)).scalar_one_or_none()
        target = None
        if user and not member:
            target = (user.id, user.passwordHash, "owner")
        elif member and not user and member.active:
            target = (member.id, member.passwordHash, "staff")
    ok = verify_password(body.password, target[1] if target else DUMMY_HASH)
    if not target or not ok:
        return fail("Wrong email or password", 401)
    res = redirect("/app")
    start_session(res, target[0], target[2])
    return res


RESET_TTL = 3600


def _fingerprint(password_hash: str) -> str:
    import hashlib

    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def _find_account(db, email: str):
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    member = db.execute(select(StaffMember).where(StaffMember.email == email)).scalar_one_or_none()
    if user and not member:
        return "owner", user
    if member and not user and member.active:
        return "staff", member
    return None, None


def _reset_token(kind: str, acct) -> str:
    now = int(time.time())
    return jwt.encode(
        {"purpose": "reset", "kind": kind, "sub": acct.id, "fp": _fingerprint(acct.passwordHash), "iat": now, "exp": now + RESET_TTL},
        config.auth_secret(), algorithm="HS256",
    )


def _read_reset_token(db, token: str):
    """(kind, account) when the token is valid, unexpired and the password hasn't changed since; else (None, None)."""
    try:
        p = jwt.decode(token, config.auth_secret(), algorithms=["HS256"], options={"require": ["sub", "exp"]})
    except jwt.PyJWTError:
        return None, None
    if p.get("purpose") != "reset":
        return None, None
    kind = p.get("kind")
    acct = db.get(StaffMember if kind == "staff" else User, p.get("sub"))
    if acct is None or p.get("fp") != _fingerprint(acct.passwordHash) or (kind == "staff" and not acct.active):
        return None, None
    return kind, acct


@router.get("/forgot-password")
def forgot_page(request: Request):
    return render(request, "auth/forgot.html", sent=False, email="")


@router.post("/forgot-password")
def forgot_submit(request: Request, background: BackgroundTasks, email: str = Form("")):
    email = email.strip().lower()
    token = name = None
    with session_scope() as db:
        kind, acct = _find_account(db, email) if email else (None, None)
        if acct:
            token, name = _reset_token(kind, acct), acct.name
    if token:
        link = f"{config.app_url()}/reset-password?token={quote(token)}"
        background.add_task(
            send_mail, email, "Reset your GodownBook password",
            f"Hi {name},\n\nUse this link to set a new password (valid for 1 hour):\n{link}\n\n"
            "If you didn't ask for this, you can ignore this email.",
        )
    return render(request, "auth/forgot.html", sent=True, email="")


@router.get("/reset-password")
def reset_page(request: Request, token: str = ""):
    with session_scope() as db:
        valid = _read_reset_token(db, token)[1] is not None
    return render(request, "auth/reset.html", valid=valid, token=token,
                  error="" if valid else "This link is invalid or has expired.")


@router.post("/reset-password")
def reset_submit(request: Request, token: str = Form(""), password: str = Form("")):
    from pydantic import TypeAdapter

    with session_scope() as db:
        _, acct = _read_reset_token(db, token)
        if acct is None:
            return render(request, "auth/reset.html", status=400, valid=False, token="", error="This link is invalid or has expired.")
        try:
            TypeAdapter(Password8).validate_python(password)
        except ValidationError as e:
            return render(request, "auth/reset.html", status=400, valid=True, token=token, error=first_message(e))
        acct.passwordHash = hash_password(password)
    return redirect("/login", flash="Password updated. Log in with your new password.")


@router.get("/signup")
def signup_page(request: Request):
    if _signed_in(request):
        return redirect("/app")
    return render(request, "auth/signup.html", error="", form_name="", email="")


@router.post("/signup")
def signup_submit(request: Request, name: str = Form(""), email: str = Form(""), password: str = Form("")):
    def fail(msg: str, status: int = 400):
        return render(request, "auth/signup.html", status=status, error=msg, form_name=name, email=email)

    try:
        body = SignupInput.model_validate({"name": name, "email": email, "password": password})
    except ValidationError as e:
        return fail(first_message(e))
    with session_scope() as db:
        if db.execute(select(User.id).where(User.email == body.email)).first():
            return fail("An account with this email already exists. Log in instead.", 409)
        if db.execute(select(StaffMember.id).where(StaffMember.email == body.email)).first():
            return fail("This email is used by a staff login. Log in with it, or sign up with a different email.", 409)
        user = User(name=body.name, email=body.email, passwordHash=hash_password(body.password), trialEndsAt=trial_end_from(utcnow()))
        db.add(user)
        db.flush()
        db.add(Godown(userId=user.id, name="Main Shop"))
        uid = user.id
    res = redirect("/app")
    start_session(res, uid)
    return res


@router.post("/logout")
def logout():
    res = redirect("/")
    end_session(res)
    return res


@router.get("/upgrade")
def upgrade_page(request: Request):
    with session_scope() as db:
        actor = current_actor(db, request)
        return render(request, "auth/upgrade.html", actor=actor, price=_price(request), free_features=FREE_FEATURES,
                      pro_features=PRO_FEATURES, is_pro=bool(actor and actor.owner.plan == "PRO"),
                      can_buy=bool(actor and actor.can("billing.upgrade")))


@router.post("/upgrade/checkout")
def upgrade_checkout(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        if not actor.can("billing.upgrade"):
            return redirect("/upgrade", "Only the account owner can buy Lifetime Pro.", True)
        if actor.owner.plan == "PRO":
            return redirect("/upgrade", "You already have Lifetime Pro", True)
        email, name, uid = actor.owner.email, actor.owner.name, actor.owner.id
    product_id, key = config.env("DODO_PRODUCT_ID"), config.env("DODO_PAYMENTS_API_KEY")
    if not product_id or not key:
        return redirect("/upgrade", "Payments aren't configured yet. Please try again later.", True)
    price = price_for(country_from_headers(dict(request.headers)))
    params = {
        "product_cart": [{"product_id": product_id, "quantity": 1, "amount": price["amountCents"]}],
        "customer": {"email": email, "name": name},
        "return_url": f"{config.app_url()}/upgrade/success",
        "cancel_url": f"{config.app_url()}/app",
        "metadata": {"userId": uid, "pppCountry": price["country"] or "", "pppAmountCents": str(price["amountCents"])},
    }
    if price["country"]:
        params["billing_address"] = {"country": price["country"]}
    try:
        from dodopayments import DodoPayments

        env = "live_mode" if config.env("DODO_PAYMENTS_ENVIRONMENT") == "live_mode" else "test_mode"
        session = DodoPayments(bearer_token=key, environment=env).checkout_sessions.create(**params)
        url = session.checkout_url
        if not url:
            raise RuntimeError("no checkout url")
    except Exception:  # noqa: BLE001
        return redirect("/upgrade", "Couldn't start checkout. Please try again.", True)
    return redirect(url)


@router.get("/upgrade/success")
def upgrade_success(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        return render(request, "auth/success.html", actor=actor, is_pro=actor.owner.plan == "PRO")


@router.post("/app/profile/avatar")
async def profile_avatar(request: Request):
    form = await request.form()
    upload = form.get("file")
    remove = form.get("remove", "")
    data = b""
    ctype = ""
    if not remove and upload is not None and hasattr(upload, "read"):
        data = await upload.read()
        ctype = getattr(upload, "content_type", "") or ""
    with session_scope() as db:
        a = page_actor(db, request)
        value = None
        if not remove:
            if not data:
                return redirect("/app", "Choose a picture first.", True)
            value = f"data:{ctype};base64,{base64.b64encode(data).decode()}"
            err = avatar_error(value)
            if err:
                return redirect("/app", err, True)
        target = db.get(User, a.actor_id) if a.is_owner else db.get(StaffMember, a.actor_id)
        target.avatar = value
        db.flush()
        log_activity(db, a, "profile.update", "New profile picture" if value else "Removed profile picture")
    return redirect("/app", "Profile picture updated")

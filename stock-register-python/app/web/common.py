"""Shared helpers for the server-rendered UI. Every section module imports from here.

Contract for section modules (app/web/<name>.py):
  * expose `router = APIRouter()`; app/web/pages.py includes it
  * templates live in app/web/templates/<name>/*.html and extend "base.html"
  * handlers are sync `def`; use `with session_scope() as db:` for DB work
  * authenticate with `page_actor(db, request)` (raises Redirect -> /login) and enforce permissions
    with `need(actor, "perm")`; the services in app/services already enforce them too
  * after a POST, `return redirect("/app/x", flash="Saved")`; on StockError use `redirect(url, flash=e.message, error=True)`
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, unquote

from fastapi import Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from ..core.errors import StockError
from ..core.gst import INDIAN_STATES, KIND_LABEL
from ..core.money import format_inr
from ..core.permissions import role_label
from ..core.plans import effective_plan, trial_days_left
from ..services.actor import Actor, current_actor

BASE = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE / "templates"))

#: key, label, icon, group, any-of permissions ([] = everyone), href
NAV: list[tuple[str, str, str, str, list[str], str]] = [
    ("workspace", "Multi-tab workspace", "🗂", "Stock", [], "/app/workspace"),
    ("dashboard", "Dashboard", "▦", "Stock", [], "/app"),
    ("items", "Items", "📦", "Stock", [], "/app/items"),
    ("ledger", "Stock ledger", "📒", "Stock", ["reports.view", "stock.move"], "/app/ledger"),
    ("serials", "IMEI tracking", "📱", "Stock", ["reports.view", "sales.create", "purchases.create", "stock.move"], "/app/serials"),
    ("adjustments", "Adjustments", "⚖", "Stock", ["stock.adjust"], "/app/adjustments"),
    ("godowns", "Godowns", "🏬", "Stock", ["godowns.manage"], "/app/godowns"),
    ("import", "Bulk import", "⇪", "Stock", ["items.manage", "parties.manage"], "/app/import"),
    ("sales", "Sales", "🧾", "Billing", ["sales.create"], "/app/billing/sales"),
    ("purchases", "Purchases", "🛒", "Billing", ["purchases.create"], "/app/billing/purchases"),
    ("documents", "Quotes & orders", "📄", "Billing", ["documents.manage"], "/app/billing/documents"),
    ("parties", "Parties", "👥", "Money", ["parties.manage", "payments.manage"], "/app/parties"),
    ("expenses", "Expenses", "💸", "Money", ["expenses.manage"], "/app/expenses"),
    ("reports", "Stock reports", "📊", "Reports", ["reports.view"], "/app/reports"),
    ("billreports", "Sales & GST", "₹", "Reports", ["reports.view"], "/app/billing/reports"),
    ("staff", "Staff", "🧑‍💼", "Business", ["staff.manage"], "/app/staff"),
    ("activity", "Activity", "🕒", "Business", ["activity.view"], "/app/activity"),
    ("settings", "Settings", "⚙", "Business", ["settings.manage"], "/app/settings"),
]


class LoginRedirect(Exception):
    """Raised by page_actor when nobody is signed in; main.py turns it into a redirect to /login."""


def page_actor(db, request: Request) -> Actor:
    a = current_actor(db, request)
    if a is None:
        raise LoginRedirect()
    return a


def need(actor: Actor, *perms: str) -> None:
    """Page-level gate: allow if the actor has ANY of the permissions."""
    from ..services.actor import assert_can

    if not any(actor.can(p) for p in perms):
        assert_can(actor, perms[0])


def redirect(url: str, flash: str = "", error: bool = False) -> RedirectResponse:
    res = RedirectResponse(url, status_code=303)
    if flash:
        res.set_cookie("sr_flash", quote(("!" if error else "") + flash), max_age=30, httponly=True, samesite="lax", path="/")
    return res


def pop_flash(request: Request) -> Optional[dict]:
    raw = request.cookies.get("sr_flash")
    if not raw:
        return None
    text = unquote(raw)
    return {"text": text.lstrip("!"), "error": text.startswith("!")}


def nav_for(actor: Actor) -> list[dict]:
    out: dict[str, list[dict]] = {}
    for key, label, icon, group, perms, href in NAV:
        if not perms or any(actor.can(p) for p in perms):
            out.setdefault(group, []).append({"key": key, "label": label, "icon": icon, "href": href})
    return [{"group": g, "items": items} for g, items in out.items()]


def render(request: Request, name: str, actor: Optional[Actor] = None, active: str = "", status: int = 200, **ctx: Any):
    """Render a template with the standard context (actor, nav, flash, plan badge, formatters)."""
    flash = pop_flash(request)
    base: dict[str, Any] = {
        "request": request, "actor": actor, "active": active, "flash": flash,
        "nav": nav_for(actor) if actor else [], "states": INDIAN_STATES, "kind_label": KIND_LABEL,
    }
    if actor:
        o = actor.owner
        base["plan"] = effective_plan(o.plan, o.trialEndsAt)
        base["trial_days"] = trial_days_left(o.trialEndsAt)
        base["role_label"] = role_label(actor.role)
    res = templates.TemplateResponse(request, name, {**base, **ctx}, status_code=status)
    if flash:
        res.delete_cookie("sr_flash", path="/")
    return res


def _inr(n: Any) -> str:
    return format_inr(float(n or 0))


def _qty(n: Any) -> str:
    n = float(n or 0)
    return f"{n:,.3f}".rstrip("0").rstrip(".") if not n.is_integer() else f"{int(n):,}"


templates.env.filters["inr"] = _inr
templates.env.filters["qty"] = _qty
templates.env.globals["can"] = lambda actor, p: bool(actor and actor.can(p))


def _pct(n: Any) -> str:
    """Discount / tax percentages: at most 2 decimals, no trailing zeros (a stored 3.333333 prints as 3.33)."""
    return f"{float(n or 0):.2f}".rstrip("0").rstrip(".")


def _dt(iso_str: Any) -> str:
    """ISO timestamp -> '19 Nov 2026, 14:05' (UTC)."""
    from datetime import datetime

    try:
        return datetime.strptime(str(iso_str), "%Y-%m-%dT%H:%M:%S.%fZ").strftime("%d %b %Y, %H:%M")
    except ValueError:
        return str(iso_str or "")


templates.env.filters["pct"] = _pct
templates.env.filters["dt"] = _dt


_asset_cache: dict[str, tuple[float, str]] = {}


def _asset(name: str) -> str:
    """/static/<name>?v=<content hash>: the address changes whenever the file does, so browsers never reuse a stale copy."""
    import hashlib

    path = BASE / "static" / name
    try:
        mtime = path.stat().st_mtime
        hit = _asset_cache.get(name)
        if hit is None or hit[0] != mtime:
            hit = (mtime, hashlib.sha1(path.read_bytes()).hexdigest()[:10])
            _asset_cache[name] = hit
        return f"/static/{name}?v={hit[1]}"
    except OSError:
        return f"/static/{name}"


templates.env.globals["asset"] = _asset

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
from ..core.fy import current_fy, fy_label, fy_options, fy_range, parse_fy
from ..core.gst import INDIAN_STATES, KIND_LABEL
from ..core.money import format_inr
from ..core.permissions import role_label
from ..core.plans import effective_plan, trial_days_left
from ..services.actor import Actor, current_actor

BASE = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE / "templates"))

#: key, label, icon, group, any-of permissions ([] = everyone), href
NAV: list[tuple[str, str, str, str, list[str], str]] = [
    # (key, label, icon, "Group" or "Group/Sub group", any-of permissions ([] = everyone), href). The key marks the row as active on its pages.
    # ---- Home
    ("workspace", "Multi-tab workspace", "🗂", "Home", [], "/app/workspace"),
    ("dashboard", "Dashboard", "▦", "Home", [], "/app"),
    # ---- Masters
    ("items", "Items", "📦", "Masters/Inventory", [], "/app/items"),
    ("item_groups", "Item groups", "🗂", "Masters/Inventory", ["items.manage", "reports.view"], "/app/masters/item-groups"),
    ("godowns", "Godowns", "🏬", "Masters/Inventory", ["godowns.manage"], "/app/godowns"),
    ("parties", "Parties", "👥", "Masters/Parties", ["parties.manage", "payments.manage"], "/app/parties"),
    ("import", "Bulk import", "⇪", "Masters/Master tools", ["items.manage", "parties.manage"], "/app/import"),
    # ---- Vouchers
    ("purchases", "Purchase", "🛒", "Vouchers/Item vouchers", ["purchases.create"], "/app/billing/purchases?kind=PURCHASE"),
    ("purchase_return", "Purchase return", "↩", "Vouchers/Item vouchers", ["purchases.create"], "/app/billing/purchases?kind=PURCHASE_RETURN"),
    ("sales", "Sales", "🧾", "Vouchers/Item vouchers", ["sales.create"], "/app/billing/sales?kind=SALE"),
    ("sale_return", "Sales return", "↪", "Vouchers/Item vouchers", ["sales.create"], "/app/billing/sales?kind=SALE_RETURN"),
    ("material_in", "Material in", "⬇", "Vouchers/Item vouchers", ["stock.move"], "/app/stock/material-in"),
    ("material_out", "Material out", "⬆", "Vouchers/Item vouchers", ["stock.move"], "/app/stock/material-out"),
    ("adjustments", "Stock journal", "⚖", "Vouchers/Item vouchers", ["stock.adjust"], "/app/adjustments"),
    ("stock_transfer", "Stock transfer", "⇄", "Vouchers/Item vouchers", ["stock.transfer"], "/app/stock/transfers"),
    ("purchase_quotation", "Purchase quotation", "📝", "Vouchers/Item vouchers", ["documents.manage"], "/app/billing/documents?kind=PURCHASE_QUOTATION"),
    ("documents", "Sales quotation", "📄", "Vouchers/Item vouchers", ["documents.manage"], "/app/billing/documents?kind=QUOTATION"),
    ("purchase_order", "Purchase order", "📑", "Vouchers/Item vouchers", ["documents.manage"], "/app/billing/documents?kind=PURCHASE_ORDER"),
    ("sales_order", "Sales order", "📋", "Vouchers/Item vouchers", ["documents.manage"], "/app/billing/documents?kind=SALES_ORDER"),
    ("challan", "Delivery challan", "🚚", "Vouchers/Item vouchers", ["documents.manage"], "/app/billing/documents?kind=CHALLAN"),
    ("receipts", "Receipt", "💰", "Vouchers/Account vouchers", ["payments.manage"], "/app/accounts/receipts"),
    ("payments", "Payment", "💳", "Vouchers/Account vouchers", ["payments.manage"], "/app/accounts/payments"),
    ("credit_note", "Credit note", "➕", "Vouchers/Account vouchers", ["payments.manage"], "/app/accounts/vouchers?kind=CREDIT_NOTE"),
    ("debit_note", "Debit note", "➖", "Vouchers/Account vouchers", ["payments.manage"], "/app/accounts/vouchers?kind=DEBIT_NOTE"),
    ("journal", "Journal", "📓", "Vouchers/Account vouchers", ["payments.manage"], "/app/accounts/vouchers?kind=JOURNAL"),
    ("expenses", "Expenses", "💸", "Vouchers/Account vouchers", ["expenses.manage"], "/app/expenses"),
    ("approvals", "Branch approvals", "✅", "Vouchers/Approval management", ["branch.approve"], "/app/billing/approvals"),
    # ---- Display
    ("day_book", "Day book", "📅", "Display/Books & registers", ["reports.view"], "/app/display/day-book"),
    ("book_ledger", "Ledger", "📒", "Display/Books & registers", ["reports.view"], "/app/display/ledger"),
    ("transaction_summary", "Transaction summary", "Σ", "Display/Summaries", ["reports.view"], "/app/display/transaction-summary"),
    ("monthly_summary", "Monthly summary", "🗓", "Display/Summaries", ["reports.view"], "/app/display/monthly-summary"),
    ("receivables", "Amount receivables", "📥", "Display/Outstanding & ageing", ["reports.view", "parties.manage"], "/app/display/receivables"),
    ("ageing", "Ageing analysis", "⏳", "Display/Outstanding & ageing", ["reports.view", "parties.manage"], "/app/display/ageing"),
    ("bill_outstanding", "Bill receivables / payables", "🧮", "Display/Outstanding & ageing", ["reports.view", "parties.manage"], "/app/display/bill-outstanding"),
    ("stock_status", "Stock status", "📶", "Display/Stock analysis", ["reports.view", "stock.move"], "/app/display/stock-status"),
    ("ledger", "Stock ledger", "📒", "Display/Stock analysis", ["reports.view", "stock.move"], "/app/ledger"),
    ("inventory_summary", "Inventory summary", "🧺", "Display/Stock analysis", ["reports.view", "stock.move"], "/app/display/inventory-summary"),
    ("reports", "Stock reports", "📊", "Display/Stock analysis", ["reports.view"], "/app/reports"),
    ("sales_analysis", "Sales analysis", "📈", "Display/Sales & purchase analysis", ["reports.view"], "/app/display/sales-analysis"),
    ("purchase_analysis", "Purchase analysis", "📉", "Display/Sales & purchase analysis", ["reports.view"], "/app/display/purchase-analysis"),
    ("billreports", "Sales & GST", "₹", "Display/Sales & purchase analysis", ["reports.view"], "/app/billing/reports"),
    ("serial_stock", "IMEI wise stock", "📱", "Display/Serial number reports", ["reports.view", "sales.create", "purchases.create", "stock.move"], "/app/display/serial-stock"),
    ("serials", "Serial no. history", "🔎", "Display/Serial number reports", ["reports.view", "sales.create", "purchases.create", "stock.move"], "/app/serials"),
    # ---- Business
    ("staff", "Staff", "🧑‍💼", "Business", ["staff.manage"], "/app/staff"),
    ("activity", "Activity", "🕒", "Business", ["activity.view"], "/app/activity"),
    ("settings", "Settings", "⚙", "Business", ["settings.manage"], "/app/settings"),
]


#: id, label, group, url (None = done in the browser), any-of permissions ([] = everyone), default key, sidebar item it also labels.
#: Defaults avoid the browser's own keys (Ctrl+T/N/W/R/P/S..., Alt+D/F/E). People can change every one of them (static/shortcuts.js).
SHORTCUTS: list[tuple[str, str, str, Optional[str], list[str], str, str]] = [
    ("sales.new", "Add sales invoice", "Create", "/app/billing/new?kind=SALE", ["sales.create"], "Alt+S", "sales"),
    ("purchase.new", "Add purchase bill", "Create", "/app/billing/new?kind=PURCHASE", ["purchases.create"], "Alt+P", "purchases"),
    ("receipt.new", "Add receipt (money in)", "Create", "/app/payments/new?direction=IN", ["payments.manage"], "Alt+R", ""),
    ("payment.new", "Add payment (money out)", "Create", "/app/payments/new?direction=OUT", ["payments.manage"], "Alt+Y", ""),
    ("quote.new", "Add quotation", "Create", "/app/billing/new?kind=QUOTATION", ["documents.manage"], "Alt+Q", "documents"),
    ("dashboard", "Dashboard", "Go to", "/app", [], "Alt+H", "dashboard"),
    ("items", "Items", "Go to", "/app/items", [], "Alt+I", "items"),
    ("ledger", "Stock ledger", "Go to", "/app/ledger", ["reports.view", "stock.move"], "Alt+L", "ledger"),
    ("serials", "IMEI tracking", "Go to", "/app/serials", ["reports.view", "sales.create", "purchases.create", "stock.move"], "Alt+M", "serials"),
    ("parties", "Parties", "Go to", "/app/parties", ["parties.manage", "payments.manage"], "Alt+A", "parties"),
    ("expenses", "Expenses", "Go to", "/app/expenses", ["expenses.manage"], "Alt+X", "expenses"),
    ("approvals", "Branch approvals", "Go to", "/app/billing/approvals", ["branch.approve"], "Alt+B", "approvals"),
    ("workspace", "Multi-tab workspace", "Go to", "/app/workspace", [], "Alt+W", "workspace"),
    ("stock.report", "Stock report", "Reports", "/app/reports", ["reports.view"], "Alt+K", "reports"),
    ("bill.report", "Sales & GST report", "Reports", "/app/billing/reports", ["reports.view"], "Alt+G", "billreports"),
    ("search", "Search invoices", "General", None, [], "Alt+/", ""),
    ("help", "Show / edit shortcuts", "General", None, [], "F1", ""),
]


def shortcuts_for(actor: Actor) -> list[dict]:
    """The shortcuts this person may use (a clerk without purchase rights never sees "Add purchase bill")."""
    return [
        {"id": i, "label": label, "group": group, "url": url, "key": key, "nav": nav}
        for i, label, group, url, perms, key, nav in SHORTCUTS if not perms or any(actor.can(p) for p in perms)
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
            top, _, sub = group.partition("/")  # "Accounts/Account vouchers": a sub group inside the Accounts group
            out.setdefault(top, []).append({"key": key, "label": label, "icon": icon, "href": href, "sub": sub})
    result = []
    for g, items in out.items():
        sections: list[dict] = []
        for it in items:
            if not sections or sections[-1]["sub"] != it["sub"] or not it["sub"]:
                sections.append({"sub": it["sub"], "items": []})
            sections[-1]["items"].append(it)
        result.append({"group": g, "items": items, "sections": sections})
    return result


FY_COOKIE = "sr_fy"


def selected_fy(request: Request) -> int:
    """The financial year picked next to the profile (a cookie); the current year when none."""
    return parse_fy(request.cookies.get(FY_COOKIE))


def fy_context(request: Request) -> dict:
    y = selected_fy(request)
    start, end = fy_range(y)
    return {"selected": y, "label": fy_label(y), "start": start, "end": end, "is_current": y == current_fy(),
            "options": fy_options(y)}


def render(request: Request, name: str, actor: Optional[Actor] = None, active: str = "", status: int = 200, **ctx: Any):
    """Render a template with the standard context (actor, nav, flash, plan badge, formatters)."""
    flash = pop_flash(request)
    base: dict[str, Any] = {
        "request": request, "actor": actor, "active": active, "flash": flash,
        "nav": nav_for(actor) if actor else [], "states": INDIAN_STATES, "kind_label": KIND_LABEL,
        "fy": fy_context(request), "sc_actions": shortcuts_for(actor) if actor else [],
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

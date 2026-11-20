"""Multi-tab workspace: several app pages open side by side as in-app tabs (one live page per tab)."""
from __future__ import annotations

from fastapi import APIRouter, Form, Request

from ..db import session_scope
from ..core.fy import parse_fy
from .common import FY_COOKIE, page_actor, redirect, render

router = APIRouter()


@router.get("/app/workspace")
def workspace(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        return render(request, "workspace/index.html", actor, "workspace")


@router.post("/app/fy")
def set_financial_year(fy: str = Form(""), next: str = Form("/app")):
    """Remember the financial year picked in the top bar (this browser only) and go back to where you were."""
    target = next if next.startswith("/app") and "//" not in next and "\\" not in next else "/app"
    res = redirect(target)
    res.set_cookie(FY_COOKIE, str(parse_fy(fy)), max_age=60 * 60 * 24 * 400, samesite="lax", path="/")
    return res

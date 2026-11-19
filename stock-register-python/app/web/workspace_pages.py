"""Multi-tab workspace: several app pages open side by side as in-app tabs (one live page per tab)."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..db import session_scope
from .common import page_actor, render

router = APIRouter()


@router.get("/app/workspace")
def workspace(request: Request):
    with session_scope() as db:
        actor = page_actor(db, request)
        return render(request, "workspace/index.html", actor, "workspace")

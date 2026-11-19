"""The signed-in person and the business account they act on.

EVERY query on business data must use `actor.account_id` (the owner's User.id).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

from fastapi import Request
from sqlalchemy.orm import Session

from ..core.errors import StockError
from ..core.permissions import PERMISSIONS, role_can
from ..models import StaffMember, User
from .auth import read_session


@dataclass
class Actor:
    account_id: str  # owner's User.id: scope every query with this
    owner: User  # plan, trial, business profile
    actor_id: str  # User.id (owner) or StaffMember.id (staff)
    name: str
    email: str
    avatar: Optional[str]
    role: str  # OWNER | STORE_ADMIN | SALES_PURCHASE | SALES
    is_owner: bool
    godown_ids: Optional[list[str]]  # None = all godowns
    _can: Optional[callable] = None  # override (used for public share links)

    def can(self, permission: str) -> bool:
        if self._can is not None:
            return self._can(permission)
        return self.is_owner or role_can(self.role, permission)


def parse_godown_ids(raw: str) -> Optional[list[str]]:
    """Stored as a JSON array; empty / invalid means "all godowns" (None)."""
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if isinstance(v, list) and v:
        return [x for x in v if isinstance(x, str)]
    return None


def current_actor(db: Session, request: Request) -> Optional[Actor]:
    """The signed-in actor, or None. Inactive staff count as signed out."""
    s = read_session(request)
    if s is None:
        return None
    if s.kind == "owner":
        owner = db.get(User, s.id)
        if owner is None:
            return None
        return Actor(owner.id, owner, owner.id, owner.name, owner.email, owner.avatar, "OWNER", True, None)
    staff = db.get(StaffMember, s.id)
    if staff is None or not staff.active:
        return None
    return Actor(
        staff.userId, staff.user, staff.id, staff.name, staff.email, staff.avatar, staff.role, False,
        parse_godown_ids(staff.godownIds),
    )


def require_actor(db: Session, request: Request) -> Actor:
    a = current_actor(db, request)
    if a is None:
        raise StockError("Please log in", 401)
    return a


def assert_can(a: Actor, permission: str) -> None:
    if not a.can(permission):
        raise StockError("Your role doesn't allow this. Ask the owner for access.", 403, "FORBIDDEN")


def require_permission(db: Session, request: Request, permission: str) -> Actor:
    a = require_actor(db, request)
    assert_can(a, permission)
    return a


def can_use_godown(a: Actor, godown_id: str) -> bool:
    return a.godown_ids is None or godown_id in a.godown_ids


def assert_godown_access(a: Actor, godown_id: str) -> None:
    if not can_use_godown(a, godown_id):
        raise StockError("You don't have access to this godown.", 403, "FORBIDDEN")


def actor_info(a: Actor) -> dict:
    """Safe-to-send summary for the browser."""
    return {
        "name": a.name,
        "role": a.role,
        "isOwner": a.is_owner,
        "permissions": [p for p in PERMISSIONS if a.can(p)],
        "godownIds": a.godown_ids,
        "avatar": a.avatar,
    }

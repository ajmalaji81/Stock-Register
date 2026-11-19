"""Session cookie (HS256 JWT, same cookie name and claims as the TypeScript app) and password hashing."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

import bcrypt
import jwt
from fastapi import Request
from fastapi.responses import Response

from .. import config

COOKIE = "sr_session"
MAX_AGE = 60 * 60 * 24 * 30  # 30 days

#: Compared against when the email doesn't exist, so response time doesn't reveal accounts.
DUMMY_HASH = "$2b$12$M8/sqyLj07IdzSTFHBLiTuf541Qp95uEDwdzH3sSwBppxZio2Mfze"


@dataclass
class Session:
    kind: str  # "owner" | "staff"
    id: str  # User.id for owners, StaffMember.id for staff


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8")[:72], bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    """bcryptjs `$2a$` hashes verify fine with the `bcrypt` package."""
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:72], hashed.encode("ascii"))
    except ValueError:
        return False


def make_token(user_id: str, kind: str = "owner") -> str:
    now = int(time.time())
    return jwt.encode({"kind": kind, "sub": user_id, "iat": now, "exp": now + MAX_AGE}, config.auth_secret(), algorithm="HS256")


def start_session(response: Response, user_id: str, kind: str = "owner") -> None:
    response.set_cookie(
        COOKIE, make_token(user_id, kind), max_age=MAX_AGE, httponly=True, samesite="lax",
        secure=config.is_production(), path="/",
    )


def end_session(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


def read_session(request: Request) -> Optional[Session]:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    try:
        payload = jwt.decode(token, config.auth_secret(), algorithms=["HS256"], options={"require": ["sub", "exp"]})
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    if not sub or not isinstance(sub, str):
        return None
    return Session(kind="staff" if payload.get("kind") == "staff" else "owner", id=sub)

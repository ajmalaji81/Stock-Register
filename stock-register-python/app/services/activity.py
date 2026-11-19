from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import ActivityLog
from .actor import Actor


def iso(d: datetime) -> str:
    """JavaScript `Date.toISOString()` format, e.g. 2026-11-17T10:00:00.123Z."""
    d = d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def log_activity(db: Session, actor: Actor, action: str, detail: str = "") -> None:
    """Record what someone did. Runs in the caller's transaction, so the log rolls back with the change.

    action: "<area>.<verb>", e.g. "item.create", "voucher.create", "payment.create", "staff.update".
    """
    db.add(ActivityLog(userId=actor.account_id, actorId=actor.actor_id, actorName=actor.name, action=action, detail=detail[:500]))
    db.flush()

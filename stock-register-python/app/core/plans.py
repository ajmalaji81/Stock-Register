from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import ceil
from typing import Optional

FREE_LIMITS = {"maxItems": 5, "maxGodowns": 2}
PRO_LIMITS = {"maxItems": None, "maxGodowns": None}
DEMO_LIMITS = {"maxItems": 5, "maxGodowns": 3}

#: New accounts get every Pro feature free for this many days.
TRIAL_DAYS = 90
_DAY = timedelta(days=1)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(d: datetime) -> datetime:
    """SQLite hands back naive datetimes; treat them as UTC."""
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


def trial_end_from(start: datetime) -> datetime:
    return start + timedelta(days=TRIAL_DAYS)


def effective_plan(plan: str, trial_ends_at: Optional[datetime], now: Optional[datetime] = None) -> str:
    """Lifetime purchase wins; otherwise Pro features while the trial lasts; then Free."""
    now = as_utc(now) if now else utcnow()
    if plan == "PRO":
        return "PRO"
    if trial_ends_at is not None and as_utc(trial_ends_at) > now:
        return "TRIAL"
    return "FREE"


def limits_for(plan: str, trial_ends_at: Optional[datetime], now: Optional[datetime] = None) -> dict:
    return dict(FREE_LIMITS if effective_plan(plan, trial_ends_at, now) == "FREE" else PRO_LIMITS)


def trial_days_left(trial_ends_at: Optional[datetime], now: Optional[datetime] = None) -> int:
    if trial_ends_at is None:
        return 0
    now = as_utc(now) if now else utcnow()
    return max(0, ceil((as_utc(trial_ends_at) - now) / _DAY))

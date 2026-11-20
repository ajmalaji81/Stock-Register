"""Indian financial years: 1 April to 31 March. A year is named by the calendar year it starts in (2026 = FY 2026-27)."""
from __future__ import annotations

from datetime import date
from typing import Optional

KEEP_YEARS = 7  # the switcher offers the current year and the six before it


def fy_of(d: date) -> int:
    """The FY a date falls in: April-December belong to their own year, January-March to the year before."""
    return d.year if d.month >= 4 else d.year - 1


def current_fy(today: Optional[date] = None) -> int:
    return fy_of(today or date.today())


def fy_label(year: int) -> str:
    return f"{year}-{(year + 1) % 100:02d}"


def fy_range(year: int) -> tuple[str, str]:
    """(first day, last day) as YYYY-MM-DD."""
    return f"{year}-04-01", f"{year + 1}-03-31"


def fy_of_iso(iso: str) -> int:
    return fy_of(date.fromisoformat(iso))


def fy_options(selected: int, today: Optional[date] = None) -> list[dict]:
    cur = current_fy(today)
    years = list(range(cur, cur - KEEP_YEARS, -1))
    if selected not in years:
        years.append(selected)
        years.sort(reverse=True)
    return [{"year": y, "label": fy_label(y), "current": y == cur} for y in years]


def parse_fy(raw: Optional[str], today: Optional[date] = None) -> int:
    """A year from the cookie / form; anything odd means the current FY."""
    cur = current_fy(today)
    try:
        y = int(str(raw))
    except (TypeError, ValueError):
        return cur
    return y if cur - 30 <= y <= cur else cur

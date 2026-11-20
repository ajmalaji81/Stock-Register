"""Dashboard periods: a week, a month, a financial quarter or a financial year, each split into chart buckets.

Quarters follow the Indian financial year: Q1 = Apr-Jun, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar (named by the FY's start year).
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from .fy import current_fy, fy_label, fy_of, fy_range

VIEWS = ("week", "month", "quarter", "year")
VIEW_LABEL = {"week": "Weekly", "month": "Monthly", "quarter": "Quarterly", "year": "Yearly"}
_UNIT = {"week": "day", "month": "day", "quarter": "week", "year": "month"}


@dataclass
class Period:
    view: str
    start: date
    end: date
    title: str
    anchor: str  # the `p` value that selects exactly this period
    prev: Optional[str]
    next: Optional[str]  # None when that period hasn't started yet
    buckets: list[tuple[date, date, str, str]] = field(default_factory=list)  # (first day, last day, axis label, tooltip label)
    unit: str = "day"
    fy: int = 0

    def index_by_day(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for i, (s, e, _, _) in enumerate(self.buckets):
            d = s
            while d <= e:
                out[d.isoformat()] = i
                d += timedelta(days=1)
        return out

    def elapsed(self, today: date) -> int:
        """Buckets that have started (for averages): all of them for a finished period."""
        return max(1, sum(1 for s, _, _, _ in self.buckets if s <= today))


def _month_add(y: int, m: int, n: int) -> tuple[int, int]:
    i = y * 12 + (m - 1) + n
    return i // 12, i % 12 + 1


def _last_day(y: int, m: int) -> date:
    return date(y, m, calendar.monthrange(y, m)[1])


def _quarter_start(fy: int, q: int) -> date:
    y, m = _month_add(fy, 4, 3 * (q - 1))
    return date(y, m, 1)


def _week(d: date, today: date) -> Period:
    mon = d - timedelta(days=d.weekday())
    end = mon + timedelta(days=6)
    buckets = [(mon + timedelta(days=i), mon + timedelta(days=i), f"{(mon + timedelta(days=i)):%a} {(mon + timedelta(days=i)).day}",
                f"{(mon + timedelta(days=i)):%a} {(mon + timedelta(days=i)).day} {(mon + timedelta(days=i)):%b}") for i in range(7)]
    title = f"{mon.day} {mon:%b} – {end.day} {end:%b %Y}"
    nxt = mon + timedelta(days=7)
    return Period("week", mon, end, title, mon.isoformat(), (mon - timedelta(days=7)).isoformat(),
                  nxt.isoformat() if nxt <= today else None, buckets, _UNIT["week"], fy_of(mon))


def _month(y: int, m: int, today: date) -> Period:
    start, end = date(y, m, 1), _last_day(y, m)
    buckets = [(date(y, m, d), date(y, m, d), str(d), f"{d} {start:%b}") for d in range(1, end.day + 1)]
    ny, nm = _month_add(y, m, 1)
    py, pm = _month_add(y, m, -1)
    return Period("month", start, end, f"{start:%B %Y}", f"{y}-{m:02d}", f"{py}-{pm:02d}",
                  f"{ny}-{nm:02d}" if date(ny, nm, 1) <= today else None, buckets, _UNIT["month"], fy_of(start))


def _quarter(fy: int, q: int, today: date) -> Period:
    start = _quarter_start(fy, q)
    ey, em = _month_add(start.year, start.month, 2)
    end = _last_day(ey, em)
    buckets, d = [], start
    while d <= end:
        e = min(d + timedelta(days=6), end)
        buckets.append((d, e, f"{d.day} {d:%b}", f"Week of {d.day} {d:%b}"))
        d = e + timedelta(days=1)
    pfy, pq = (fy, q - 1) if q > 1 else (fy - 1, 4)
    nfy, nq = (fy, q + 1) if q < 4 else (fy + 1, 1)
    title = f"Q{q} · FY {fy_label(fy)} ({start:%b} – {end:%b %Y})"
    return Period("quarter", start, end, title, f"{fy}-Q{q}", f"{pfy}-Q{pq}",
                  f"{nfy}-Q{nq}" if _quarter_start(nfy, nq) <= today else None, buckets, _UNIT["quarter"], fy)


def _year(fy: int, today: date) -> Period:
    start, end = (date.fromisoformat(x) for x in fy_range(fy))
    buckets = []
    for i in range(12):
        y, m = _month_add(fy, 4, i)
        buckets.append((date(y, m, 1), _last_day(y, m), f"{date(y, m, 1):%b} {str(y)[2:]}", f"{date(y, m, 1):%b %Y}"))
    return Period("year", start, end, f"FY {fy_label(fy)}", str(fy), str(fy - 1), str(fy + 1) if fy + 1 <= current_fy(today) else None,
                  buckets, _UNIT["year"], fy)


def resolve(view: str, p: str, selected_fy: int, today: Optional[date] = None) -> Period:
    """The period to show. Without `p` it is the current week / month / quarter / year (of the selected FY when that
    is an older year: its last week / month / quarter). A bad or future `p` falls back the same way."""
    today = today or date.today()
    view = view if view in VIEWS else "month"
    anchor_day = today if selected_fy >= current_fy(today) else date.fromisoformat(fy_range(selected_fy)[1])
    anchor_fy = fy_of(anchor_day)
    p = (p or "").strip()
    try:
        if view == "week":
            d = date.fromisoformat(p) if p else anchor_day
            per = _week(d, today)
        elif view == "month":
            m = re.fullmatch(r"(\d{4})-(\d{2})", p)
            y, mo = (int(m.group(1)), int(m.group(2))) if m else (anchor_day.year, anchor_day.month)
            per = _month(y, mo, today)
        elif view == "quarter":
            m = re.fullmatch(r"(\d{4})-Q([1-4])", p)
            if m:
                fy, q = int(m.group(1)), int(m.group(2))
            else:
                fy, q = anchor_fy, (anchor_day.month - 4) % 12 // 3 + 1
            per = _quarter(fy, q, today)
        else:
            per = _year(int(p) if re.fullmatch(r"\d{4}", p) else selected_fy, today)
    except ValueError:
        per = resolve(view, "", selected_fy, today)
        return per
    if per.start > today or per.start.year < 2000:  # nothing in the future
        return resolve(view, "", selected_fy, today) if p else per
    return per


def months_of_fy(fy: int, today: Optional[date] = None) -> list[dict]:
    """The 12 months of a financial year for the month picker (months that haven't started are marked)."""
    today = today or date.today()
    out = []
    for i in range(12):
        y, m = _month_add(fy, 4, i)
        out.append({"p": f"{y}-{m:02d}", "label": f"{date(y, m, 1):%B %Y}", "future": date(y, m, 1) > today})
    return out

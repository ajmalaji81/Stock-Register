"""Pure stock-ledger rules (port of lib/engine.ts, minus the in-browser demo register)."""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Mapping, Optional, Sequence

from .errors import StockError
from .jsmath import round2, round3

__all__ = [
    "StockError", "round2", "round3", "today_iso", "item_total", "qty_in_scope", "is_low_stock", "stock_value",
    "assert_can_remove", "assert_within_limit", "summarize_today", "matches_filter", "to_csv",
]


def today_iso(d: Optional[date | datetime] = None) -> str:
    d = d or datetime.now()
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"


def item_total(stock: Mapping[str, float]) -> float:
    return round3(sum(stock.values()))


def qty_in_scope(stock: Mapping[str, float], scope: str) -> float:
    return item_total(stock) if scope == "ALL" else round3(stock.get(scope, 0))


def is_low_stock(stock: Mapping[str, float], min_alert: float, scope: str) -> bool:
    return min_alert > 0 and qty_in_scope(stock, scope) <= min_alert


def stock_value(items: Sequence[Mapping[str, Any]], scope: str) -> float:
    return round2(sum(qty_in_scope(it["stock"], scope) * it["purchasePrice"] for it in items))


def assert_can_remove(available: float, qty: float, item_name: str, godown_name: str) -> None:
    """Throws if taking `qty` out of a godown that holds `available` would go negative."""
    if round3(available - qty) < 0:
        raise StockError(
            f'Not enough stock of "{item_name}" in {godown_name}: available {fmt(round3(available))}, requested {fmt(round3(qty))}.',
            400,
            "INSUFFICIENT_STOCK",
        )


def assert_within_limit(current: int, maximum: Optional[int], what: str) -> None:
    if maximum is not None and current >= maximum:
        raise StockError(
            f"The Free plan is limited to {maximum} {what}. Get Lifetime Pro for unlimited {what}.", 402, "LIMIT"
        )


def fmt(n: float) -> str:
    """Render numbers the way JavaScript template strings do (25 not 25.0)."""
    return str(int(n)) if float(n).is_integer() else repr(float(n))


def summarize_today(entries: Sequence[Mapping[str, Any]], today: str, scope: str) -> dict:
    """Today's purchases vs sales. Transfers and opening stock are not counted."""
    s = {"inCount": 0, "outCount": 0, "inValue": 0.0, "outValue": 0.0}
    for e in entries:
        if e["date"] != today:
            continue
        if scope != "ALL" and e["godownId"] != scope:
            continue
        if e["type"] == "IN":
            s["inCount"] += 1
            s["inValue"] += e["qtyIn"] * e["rate"]
        elif e["type"] == "OUT":
            s["outCount"] += 1
            s["outValue"] += e["qtyOut"] * e["rate"]
    s["inValue"] = round2(s["inValue"])
    s["outValue"] = round2(s["outValue"])
    return s


def matches_filter(e: Mapping[str, Any], f: Mapping[str, Any]) -> bool:
    if f.get("itemId") and e["itemId"] != f["itemId"]:
        return False
    if f.get("godownId") and f["godownId"] != "ALL" and e["godownId"] != f["godownId"]:
        return False
    if f.get("type") and e["type"] != f["type"]:
        return False
    if f.get("from") and e["date"] < f["from"]:
        return False
    if f.get("to") and e["date"] > f["to"]:
        return False
    return True


# ---------- CSV ----------


def _csv_cell(v: Any) -> str:
    s = fmt(v) if isinstance(v, float) else str(v)
    # Neutralise spreadsheet formula injection, then quote if needed.
    safe = f"'{s}" if re.match(r"^[=+\-@\t\r]", s) and not re.match(r"^-?\d", s) else s
    return '"' + safe.replace('"', '""') + '"' if re.search(r'[",\n\r]', safe) else safe


def to_csv(rows: Sequence[Sequence[Any]]) -> str:
    return "\r\n".join(",".join(_csv_cell(c) for c in r) for r in rows)

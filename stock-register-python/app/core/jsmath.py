"""JavaScript-compatible rounding.

The TypeScript app used ``Math.round``, which rounds halves toward +infinity
(``Math.round(-2.5) == -2``). Python's ``round`` uses banker's rounding, so every
money/quantity calculation goes through these helpers to keep results identical.
"""
from __future__ import annotations

import math

EPSILON = 2.220446049250313e-16  # Number.EPSILON


def js_round(x: float) -> float:
    """Equivalent of JavaScript ``Math.round``."""
    return float(math.floor(x + 0.5))


def r2(n: float) -> float:
    """gst.ts / money.ts ``r2`` / ``round2``: ``Math.round((n + EPSILON) * 100) / 100``."""
    return js_round((n + EPSILON) * 100) / 100


def round2(n: float) -> float:
    """engine.ts ``round2``: ``Math.round(n * 100) / 100`` (no epsilon nudge)."""
    return js_round(n * 100) / 100


def round3(n: float) -> float:
    """Quantities are kept to 3 decimals (grams, millilitres)."""
    return js_round(n * 1000) / 1000

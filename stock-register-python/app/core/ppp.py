"""Purchasing-power-parity pricing for the one-time Lifetime Pro purchase.

The country comes ONLY from a header the host sets (Vercel / Cloudflare), never from
anything the visitor can choose, so the discount can't be picked by hand.
"""
from __future__ import annotations

import math
import os
import re
from typing import Mapping, Optional

from .jsmath import js_round

TIERS: list[tuple[float, list[str]]] = [
    (0.4, "IN PK BD NP LK MM KH LA NG GH KE UG TZ ET EG ZW ZM MW MZ RW SN CM CI AF BT MV UZ KG TJ".split()),
    (0.5, "ID PH VN MA DZ TN BO PY HN NI GT SV UA MD GE AM AZ MN JO LB IQ IR SY YE".split()),
    (0.7, "BR MX AR CO PE CL EC TR ZA TH MY RU BY KZ RS BA MK AL ME RO BG DO JM PA CR UY CN".split()),
]


def base_price_cents(env: Optional[Mapping[str, str]] = None) -> int:
    env = os.environ if env is None else env
    try:
        n = float(env.get("LIFETIME_PRICE_CENTS", "2900"))
    except ValueError:
        return 2900
    return int(js_round(n)) if math.isfinite(n) and n > 0 else 2900


def country_from_headers(headers: Mapping[str, str], env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    env = os.environ if env is None else env
    lowered = {k.lower(): v for k, v in headers.items()}
    dev = (env.get("PPP_DEV_COUNTRY") or "").strip()
    if dev and env.get("APP_ENV", "development") != "production":
        return dev.upper()
    name = (env.get("PPP_COUNTRY_HEADER") or "x-vercel-ipcountry").lower()
    v = (lowered.get(name) or "").strip().upper()
    return v if re.fullmatch(r"[A-Z]{2}", v) and v not in ("XX", "T1") else None


def price_for(country: Optional[str], env: Optional[Mapping[str, str]] = None) -> dict:
    base = base_price_cents(env)
    multiplier = 1.0
    if country:
        for m, countries in TIERS:
            if country in countries:
                multiplier = m
                break
    amount = max(100, int(js_round(base * multiplier / 100)) * 100)
    return {
        "country": country,
        "baseCents": base,
        "amountCents": amount,
        "discountPct": int(js_round((1 - amount / base) * 100)),
    }


def format_usd(cents: int) -> str:
    return f"${cents / 100:.0f}" if cents % 100 == 0 else f"${cents / 100:.2f}"

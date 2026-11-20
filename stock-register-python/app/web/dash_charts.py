"""Small server-rendered SVG charts for the dashboard (no JS libraries)."""
from __future__ import annotations

import math
from itertools import count

from markupsafe import Markup, escape

_ids = count(1)
BLUE, BLUE_LIGHT = "var(--brand)", "var(--brand-pale)"
DONUT = ["var(--brand-deep)", "var(--brand)", "var(--brand-light)", "var(--brand-pale)", "color-mix(in srgb, var(--brand) 25%, #fff)", "color-mix(in srgb, var(--brand) 12%, #fff)"]


def compact(n: float) -> str:
    a = abs(n)
    for div, suf in ((1e7, "Cr"), (1e5, "L"), (1e3, "K")):
        if a >= div:
            return f"₹{n / div:.1f}".rstrip("0").rstrip(".") + suf
    return f"₹{n:.0f}"


def spark(values: list[float], color: str = BLUE, w: int = 140, h: int = 56,
          tips: list[str] | None = None) -> Markup:
    """Smooth area sparkline."""
    n = len(values)
    if n < 2:
        return Markup("")
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1
    pts = [(i * w / (n - 1), h - 6 - (v - lo) / span * (h - 14)) for i, v in enumerate(values)]
    d = f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        mx = (x0 + x1) / 2
        d += f" C{mx:.1f},{y0:.1f} {mx:.1f},{y1:.1f} {x1:.1f},{y1:.1f}"
    gid = f"sg{next(_ids)}"
    hits = ""
    if tips:
        step = w / (n - 1)
        hits = "".join(
            f'<rect class="hit" x="{x - step / 2:.1f}" y="0" width="{step:.1f}" height="{h}" fill="transparent" data-tip="{escape(t)}"/>'
            for (x, _), t in zip(pts, tips)
        )
    return Markup(
        f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="trend">'
        f'<defs><linearGradient id="{gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="{color}" stop-opacity=".28"/>'
        f'<stop offset="1" stop-color="{color}" stop-opacity="0"/></linearGradient></defs>'
        f'<path d="{d} L{w},{h} L0,{h} Z" fill="url(#{gid})"/><path d="{d}" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round"/>{hits}</svg>'
    )


def _nice_max(v: float) -> float:
    if v <= 0:
        return 1
    mag = 10 ** math.floor(math.log10(v))
    for m in (1, 2, 2.5, 5, 10):
        if v <= m * mag:
            return m * mag
    return 10 * mag


def bars(labels: list[str], a: list[float], b: list[float] | None = None, w: int = 640, h: int = 270,
         tip_labels: list[str] | None = None) -> Markup:
    """Grouped vertical bars: a = dark blue (sales), b = light blue (purchases)."""
    left, bottom, top = 54, 28, 10
    ph = h - bottom - top
    vmax = _nice_max(max(a + (b or []) + [0]))
    out = [f'<svg viewBox="0 0 {w} {h}" class="barchart" role="img" aria-label="Sales and purchases by day">']
    for i in range(5):
        y = top + ph - ph * i / 4
        out.append(f'<line x1="{left}" x2="{w}" y1="{y:.1f}" y2="{y:.1f}" stroke="#e4e7ec" stroke-dasharray="4 4"/>')
        out.append(f'<text x="{left - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="#667085">{compact(vmax * i / 4)}</text>')
    n = len(labels)
    slot = (w - left) / max(n, 1)
    bw = min(16, slot / 3)
    tip_labels = tip_labels or labels
    every = 1 if n <= 16 else 2 if n <= 31 else 3  # keep the day numbers of a long month readable
    for i, lab in enumerate(labels):
        full = tip_labels[i]
        cx = left + slot * i + slot / 2
        series = [(BLUE_LIGHT, b[i] if b else None), (BLUE, a[i])] if b else [(BLUE, a[i])]
        x = cx - bw * len(series) / 2
        for color, v in series:
            if v is None:
                continue
            bh = max(0.0, v / vmax * ph)
            out.append(f'<rect x="{x:.1f}" y="{top + ph - bh:.1f}" width="{bw - 2:.1f}" height="{bh:.1f}" rx="2" fill="{color}"><title>{escape(full)}: ₹{v:,.0f}</title></rect>')
            x += bw
        tip = f"{full}\u2002Sales ₹{a[i]:,.0f}" + (f"\u2002Purchases ₹{b[i]:,.0f}" if b else "")
        out.append(f'<rect class="hit" x="{left + slot * i:.1f}" y="{top}" width="{slot:.1f}" height="{ph}" fill="transparent" data-tip="{escape(tip)}"/>')
        if i % every == 0:
            out.append(f'<text x="{cx:.1f}" y="{h - 8}" text-anchor="middle" font-size="11" fill="#667085">{escape(lab)}</text>')
    out.append("</svg>")
    return Markup("".join(out))


def donut(values: list[float], w: int = 300, labels: list[str] | None = None) -> Markup:
    """Half-circle donut."""
    total = sum(values)
    cx, cy, ro, ri = w / 2, w / 2 - 10, w / 2 - 10, w / 2 - 70
    if total <= 0:
        return Markup("")
    out = [f'<svg viewBox="0 0 {w} {cy + 8:.0f}" class="donut" role="img" aria-label="Payment modes">']
    ang = math.pi
    for i, v in enumerate(values):
        sweep = v / total * math.pi
        a0, a1 = ang, ang + sweep
        ang = a1

        def pt(r, t):
            return cx + r * math.cos(t), cy + r * math.sin(t)

        x0, y0, x1, y1 = (*pt(ro, a0), *pt(ro, a1))
        x2, y2, x3, y3 = (*pt(ri, a1), *pt(ri, a0))
        out.append(
            f'<path d="M{x0:.1f},{y0:.1f} A{ro},{ro} 0 0 1 {x1:.1f},{y1:.1f} L{x2:.1f},{y2:.1f} A{ri},{ri} 0 0 0 {x3:.1f},{y3:.1f} Z" '
            f'fill="{DONUT[i % len(DONUT)]}" stroke="#fff" stroke-width="2" class="hit" data-tip="{escape(f"{labels[i]}: ₹{v:,.0f} ({v / total:.0%})" if labels else f"₹{v:,.0f}")}"/>'
        )
    out.append("</svg>")
    return Markup("".join(out))

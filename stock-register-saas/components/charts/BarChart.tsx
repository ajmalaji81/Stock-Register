"use client";

import { useState } from "react";
import { niceMax } from "@/lib/report-months";

export interface Bar {
  key: string;
  label: string; // axis label, e.g. "Apr 26"
  value: number;
  /** Text shown above the bar (already formatted, e.g. "₹1.2L"). */
  valueLabel: string;
  /** Lines for the hover / focus tooltip. */
  tooltip: { title: string; lines: [string, string][] };
}

const SLOT = 56; // px per month column
const AXIS_W = 64;
const H = 240; // plot height
const TOP = 26; // room for value labels
const BOTTOM = 28; // room for month labels
const BAR_W = 26; // thin marks

/**
 * Single-series vertical bar chart (one hue, no legend — the title names the series).
 * Values are labelled above each bar; full numbers in a tooltip on hover or keyboard focus.
 * Scrolls sideways inside its card when there are more bars than fit.
 */
export default function BarChart({
  bars,
  summary,
  formatAxis,
}: {
  bars: Bar[];
  /** Screen-reader summary of the whole chart. */
  summary: string;
  formatAxis: (v: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const width = AXIS_W + bars.length * SLOT + 8;
  const max = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const minRaw = Math.min(0, ...bars.map((b) => b.value));
  const min = minRaw < 0 ? -niceMax(-minRaw) : 0;
  const y = (v: number) => TOP + ((max - v) / (max - min)) * H;
  const zero = y(0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t);
  const a = active === null ? null : bars[active];

  return (
    <div className="overflow-x-auto print:overflow-visible">
      <div className="relative" style={{ minWidth: width }}>
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${width} ${TOP + H + BOTTOM}`}
          width="100%"
          className="block [print-color-adjust:exact]"
        >
          {/* recessive grid + axis labels */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} className="stroke-ink/10" strokeWidth={1} />
              <text x={AXIS_W - 8} y={y(t) + 4} textAnchor="end" className="fill-ink/50 text-[11px] tabular-nums">
                {formatAxis(t)}
              </text>
            </g>
          ))}
          <line x1={AXIS_W} x2={width} y1={zero} y2={zero} className="stroke-ink/40" strokeWidth={1} />

          {bars.map((b, i) => {
            const cx = AXIS_W + i * SLOT + SLOT / 2;
            const top = y(Math.max(0, b.value));
            const h = Math.max(b.value === 0 ? 0 : 2, Math.abs(y(b.value) - zero));
            const neg = b.value < 0;
            const r = Math.min(4, h / 2);
            // Rounded only at the data end; square at the baseline.
            const x0 = cx - BAR_W / 2;
            const path = neg
              ? `M${x0},${zero} h${BAR_W} v${h - r} q0,${r} ${-r},${r} h${-(BAR_W - 2 * r)} q${-r},0 ${-r},${-r} z`
              : `M${x0},${zero} v${-(h - r)} q0,${-r} ${r},${-r} h${BAR_W - 2 * r} q${r},0 ${r},${r} v${h - r} z`;
            const on = active === i;
            return (
              <g key={b.key}>
                {h > 0 && <path d={path} className={neg ? "fill-out" : on ? "fill-in" : "fill-brand"} />}
                <text
                  x={cx}
                  y={neg ? y(b.value) + 14 : top - 7}
                  textAnchor="middle"
                  className={`text-[11px] font-semibold tabular-nums ${b.value === 0 ? "fill-ink/35" : "fill-ink"}`}
                >
                  {b.valueLabel}
                </text>
                <text x={cx} y={TOP + H + 18} textAnchor="middle" className={`text-[11px] ${on ? "fill-ink font-bold" : "fill-ink/60"}`}>
                  {b.label}
                </text>
                {/* hit target: the whole column, bigger than the mark */}
                <rect
                  x={cx - SLOT / 2}
                  y={TOP}
                  width={SLOT}
                  height={H + BOTTOM}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${b.tooltip.title}: ${b.tooltip.lines.map(([k, v]) => `${k} ${v}`).join(", ")}`}
                  className="cursor-pointer outline-none focus-visible:stroke-ink focus-visible:stroke-2"
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                />
              </g>
            );
          })}
        </svg>
      {a && active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-xl border border-ink/15 bg-paper px-3 py-2 text-xs shadow-lg print:hidden"
          style={{ left: Math.min(Math.max(AXIS_W + active * SLOT - 40, 0), Math.max(0, width - 200)) }}
        >
          <div className="mb-1 font-bold">{a.tooltip.title}</div>
          {a.tooltip.lines.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <span className="text-ink/60">{k}</span>
              <span className="font-semibold tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

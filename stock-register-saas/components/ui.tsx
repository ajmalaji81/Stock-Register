"use client";

import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

export const money = (n: number): string => inr.format(n);
export const qty = (n: number): string => num.format(n);

type Variant = "primary" | "in" | "out" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "btn-edge-ink bg-ink text-paper hover:bg-[#1c2620]",
  in: "btn-edge-in bg-in text-white hover:bg-[#178a43]",
  out: "btn-edge-out bg-out text-white hover:bg-[#e53434]",
  ghost: "btn-edge-ghost border-2 border-ink bg-paper text-ink hover:bg-surface",
  danger: "btn-edge-danger border-2 border-out bg-paper text-out hover:bg-out/5",
};

/** Raised 3D key. The bottom edge presses in on click. */
export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`btn-3d mb-1 inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink/70">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink/60">{hint}</span>}
    </label>
  );
}

const control =
  "well w-full rounded-xl border-2 border-ink/15 px-3 py-2 text-sm text-ink outline-none transition focus:border-ink focus:bg-paper focus:ring-4 focus:ring-brand/20";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${control} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${control} ${props.className ?? ""}`} />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-4 print:hidden"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card-3d pop-in max-h-[92vh] w-full overflow-y-auto rounded-b-none p-5 sm:max-w-lg sm:rounded-b-[1.1rem]"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="icon-tile h-8 w-8 bg-surface text-xl leading-none hover:bg-muted"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

type Tone = "ink" | "in" | "out" | "low";

const TONE_BAR: Record<Tone, string> = {
  ink: "from-ink/80 to-ink/40",
  in: "from-in to-brand",
  out: "from-out to-[#f87171]",
  low: "from-low to-[#fbbf24]",
};

/** Raised stat card with a coloured depth strip on top. */
export function Stat({
  label,
  value,
  sub,
  tone = "ink",
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  /** Optional emoji / glyph shown in a raised tile at the top-right. */
  icon?: ReactNode;
}) {
  return (
    <div className="card-3d tilt relative overflow-hidden p-4">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r ${TONE_BAR[tone]}`} />
      {icon && (
        <span className="absolute right-3 top-3.5">
          <IconTile size="sm" tone={tone === "ink" ? "ink" : tone}>{icon}</IconTile>
        </span>
      )}
      <div className={`text-xs font-bold uppercase tracking-wide text-ink/60 ${icon ? "pr-10" : ""}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-sm text-ink/70">{sub}</div>}
    </div>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls = {
    in: "bg-in/12 text-in ring-in/25",
    out: "bg-out/12 text-out ring-out/25",
    low: "bg-low/15 text-low ring-low/30",
    ink: "bg-muted text-ink ring-ink/15",
  }[tone];
  return (
    <span className={`inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-bold ring-1 ring-inset shadow-[inset_0_1px_0_rgb(255_255_255/0.6)] ${cls}`}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="well rounded-2xl border-2 border-dashed border-ink/15 p-8 text-center text-sm text-ink/60">{children}</div>;
}

// ---------- Additional building blocks ----------

/** Raised surface. `tilt` adds the hover tilt; `dark` uses the ink variant. */
export function Card({
  children,
  className = "",
  tilt = false,
  dark = false,
}: {
  children: ReactNode;
  className?: string;
  tilt?: boolean;
  dark?: boolean;
}) {
  return <div className={`${dark ? "card-3d-dark" : "card-3d"} ${tilt ? "tilt" : ""} ${className}`}>{children}</div>;
}

/** Title row for a section: title, optional subtitle, actions on the right (wraps on phones). */
export function SectionHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        {subtitle && <p className="text-sm text-ink/65">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 print:hidden">{actions}</div>}
    </div>
  );
}

const TILE_TONE: Record<Tone | "brand", string> = {
  ink: "bg-surface text-ink",
  in: "bg-brand-soft text-in",
  out: "bg-out/12 text-out",
  low: "bg-low/15 text-low",
  brand: "bg-brand text-ink",
};

/** Raised square tile holding an emoji / icon / number. */
export function IconTile({
  children,
  tone = "ink",
  size = "md",
}: {
  children: ReactNode;
  tone?: Tone | "brand";
  size?: "sm" | "md" | "lg";
}) {
  const s = { sm: "h-8 w-8 text-base", md: "h-11 w-11 text-xl", lg: "h-14 w-14 text-2xl" }[size];
  return (
    <span aria-hidden className={`icon-tile shrink-0 font-bold ${s} ${TILE_TONE[tone]}`}>
      {children}
    </span>
  );
}

/** Segmented control with a raised active segment. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: [K, string][];
  value: K;
  onChange: (k: K) => void;
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="well inline-flex max-w-full gap-1 overflow-x-auto rounded-xl p-1 print:hidden">
      {tabs.map(([k, text]) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
          className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
            value === k ? "bg-paper text-ink shadow-[0_2px_0_0_rgb(11_15_12/0.15),0_4px_10px_-4px_rgb(11_15_12/0.3)]" : "text-ink/60 hover:text-ink"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

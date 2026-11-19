// Pure helpers for the month-wise sales report (no imports, so Node can unit-test them directly).
// Months are "YYYY-MM" strings; bill dates are "YYYY-MM-DD", so a bill's month is date.slice(0, 7).

export type MonthPreset = "last12" | "thisFY" | "lastFY" | "year";

export interface MonthRange {
  from: string; // YYYY-MM, inclusive
  to: string; // YYYY-MM, inclusive
}

/** Longest range the report will compute (3 years of bars is already a lot). */
export const MAX_MONTHS = 36;

const pad = (n: number) => String(n).padStart(2, "0");
export const monthKey = (year: number, month1: number): string => `${year}-${pad(month1)}`;

export function isMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** "2026-04" + n months (n may be negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return monthKey(Math.floor(idx / 12), (idx % 12) + 1);
}

/** Indian financial year (April–March) that a month belongs to, as its starting calendar year. */
export function fyStartYear(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

/** Resolve a preset to a concrete month range, relative to `now`. */
export function presetRange(preset: MonthPreset, now: Date, year?: number): MonthRange {
  const current = monthKey(now.getFullYear(), now.getMonth() + 1);
  switch (preset) {
    case "thisFY": {
      const fy = fyStartYear(current);
      return { from: monthKey(fy, 4), to: monthKey(fy + 1, 3) };
    }
    case "lastFY": {
      const fy = fyStartYear(current) - 1;
      return { from: monthKey(fy, 4), to: monthKey(fy + 1, 3) };
    }
    case "year": {
      const y = year ?? now.getFullYear();
      return { from: monthKey(y, 1), to: monthKey(y, 12) };
    }
    default:
      return { from: addMonths(current, -11), to: current };
  }
}

/** Every month from `from` to `to` inclusive, oldest first. Empty if from > to. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length <= MAX_MONTHS * 2; m = addMonths(m, 1)) out.push(m);
  return out;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-04" -> "Apr 26" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${SHORT[m - 1]} ${String(y).slice(2)}`;
}

/** "2026-04" -> "April 2026" */
export function monthLabelLong(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${LONG[m - 1]} ${y}`;
}

/** Last calendar day of a month as YYYY-MM-DD (for date-string range queries). */
export function monthEndDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${pad(last)}`;
}

/**
 * Compact Indian rupee label for bar values: ₹950, ₹12.5K, ₹1.2L, ₹3.4Cr.
 * One decimal, trailing ".0" dropped. Negative values keep their sign.
 */
export function compactInr(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  const fmt = (v: number, unit: string) => `${sign}₹${(Math.round(v * 10) / 10).toString().replace(/\.0$/, "")}${unit}`;
  if (a >= 1e7) return fmt(a / 1e7, "Cr");
  if (a >= 1e5) return fmt(a / 1e5, "L");
  if (a >= 1e3) return fmt(a / 1e3, "K");
  return `${sign}₹${Math.round(a)}`;
}

/** A "nice" axis maximum (1, 2, 2.5, 5 × 10^k) at or above `max`, so gridlines land on round numbers. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * exp >= max) return step * exp;
  return 10 * exp;
}

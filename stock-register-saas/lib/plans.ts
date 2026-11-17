import type { Limits, Plan } from "./types";

export const FREE_LIMITS: Limits = { maxItems: 5, maxGodowns: 2 };
export const PRO_LIMITS: Limits = { maxItems: null, maxGodowns: null };
export const DEMO_LIMITS: Limits = { maxItems: 5, maxGodowns: 3 };

/** New accounts get every Pro feature free for this many days. */
export const TRIAL_DAYS = 90;

export function trialEndFrom(start: Date): Date {
  return new Date(start.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

type PlanUser = { plan: string; trialEndsAt: Date | null };

/** Lifetime purchase wins; otherwise Pro features while the trial lasts; then Free. */
export function effectivePlan(user: PlanUser, now = new Date()): Plan {
  if (user.plan === "PRO") return "PRO";
  if (user.trialEndsAt && user.trialEndsAt > now) return "TRIAL";
  return "FREE";
}

export function limitsFor(user: PlanUser, now = new Date()): Limits {
  return effectivePlan(user, now) === "FREE" ? FREE_LIMITS : PRO_LIMITS;
}

export function trialDaysLeft(trialEndsAt: Date | string | null, now = new Date()): number {
  if (!trialEndsAt) return 0;
  return Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

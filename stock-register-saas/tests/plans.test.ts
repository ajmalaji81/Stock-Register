import { test } from "node:test";
import assert from "node:assert/strict";
import { effectivePlan, FREE_LIMITS, limitsFor, PRO_LIMITS, TRIAL_DAYS, trialDaysLeft, trialEndFrom } from "../lib/plans.ts";

const now = new Date("2026-11-17T10:00:00Z");
const day = 24 * 60 * 60 * 1000;

test("trial lasts 90 days from signup", () => {
  assert.equal(TRIAL_DAYS, 90);
  assert.equal(trialEndFrom(now).getTime() - now.getTime(), 90 * day);
});

test("effectivePlan: lifetime beats trial, trial gives Pro limits, expired trial is Free", () => {
  const future = new Date(now.getTime() + day);
  const past = new Date(now.getTime() - 1);
  assert.equal(effectivePlan({ plan: "PRO", trialEndsAt: past }, now), "PRO");
  assert.equal(effectivePlan({ plan: "FREE", trialEndsAt: future }, now), "TRIAL");
  assert.equal(effectivePlan({ plan: "FREE", trialEndsAt: past }, now), "FREE");
  assert.equal(effectivePlan({ plan: "FREE", trialEndsAt: null }, now), "FREE");
  assert.deepEqual(limitsFor({ plan: "FREE", trialEndsAt: future }, now), PRO_LIMITS);
  assert.deepEqual(limitsFor({ plan: "FREE", trialEndsAt: past }, now), FREE_LIMITS);
  assert.deepEqual(limitsFor({ plan: "PRO", trialEndsAt: null }, now), PRO_LIMITS);
});

test("trialDaysLeft rounds up and never goes negative", () => {
  assert.equal(trialDaysLeft(trialEndFrom(now), now), 90);
  assert.equal(trialDaysLeft(new Date(now.getTime() + 1), now), 1);
  assert.equal(trialDaysLeft(new Date(now.getTime() - day), now), 0);
  assert.equal(trialDaysLeft(null, now), 0);
});

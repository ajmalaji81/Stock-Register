import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMonths,
  compactInr,
  fyStartYear,
  isMonth,
  monthEndDate,
  monthLabel,
  monthLabelLong,
  monthsBetween,
  niceMax,
  presetRange,
} from "../lib/report-months.ts";
import { bucketOf, PAYMENT_MODES } from "../lib/money.ts";

test("addMonths crosses year boundaries both ways", () => {
  assert.equal(addMonths("2026-11", 1), "2026-12");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-11", -11), "2025-12");
});

test("monthsBetween is inclusive, ordered, and empty when reversed", () => {
  assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(monthsBetween("2026-03", "2026-03"), ["2026-03"]);
  assert.deepEqual(monthsBetween("2026-04", "2026-03"), []);
});

test("financial year runs April to March", () => {
  assert.equal(fyStartYear("2026-03"), 2025);
  assert.equal(fyStartYear("2026-04"), 2026);
  const nov = new Date(2026, 10, 19);
  assert.deepEqual(presetRange("thisFY", nov), { from: "2026-04", to: "2027-03" });
  assert.deepEqual(presetRange("lastFY", nov), { from: "2025-04", to: "2026-03" });
  const feb = new Date(2026, 1, 10); // Feb 2026 is still FY 2025-26
  assert.deepEqual(presetRange("thisFY", feb), { from: "2025-04", to: "2026-03" });
});

test("last 12 months ends with the current month; calendar year is Jan-Dec", () => {
  const nov = new Date(2026, 10, 19);
  const r = presetRange("last12", nov);
  assert.deepEqual(r, { from: "2025-12", to: "2026-11" });
  assert.equal(monthsBetween(r.from, r.to).length, 12);
  assert.deepEqual(presetRange("year", nov, 2025), { from: "2025-01", to: "2025-12" });
});

test("month labels and month end dates", () => {
  assert.equal(monthLabel("2026-04"), "Apr 26");
  assert.equal(monthLabelLong("2026-04"), "April 2026");
  assert.equal(monthEndDate("2026-02"), "2026-02-28");
  assert.equal(monthEndDate("2028-02"), "2028-02-29");
  assert.equal(monthEndDate("2026-12"), "2026-12-31");
  assert.ok(isMonth("2026-12"));
  assert.ok(!isMonth("2026-13"));
  assert.ok(!isMonth("2026-1"));
});

test("compactInr uses Indian units", () => {
  assert.equal(compactInr(0), "₹0");
  assert.equal(compactInr(950), "₹950");
  assert.equal(compactInr(12500), "₹12.5K");
  assert.equal(compactInr(120000), "₹1.2L");
  assert.equal(compactInr(100000), "₹1L");
  assert.equal(compactInr(34000000), "₹3.4Cr");
  assert.equal(compactInr(-25000), "-₹25K");
});

test("niceMax rounds the axis up to a round number", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(180000), 200000);
  assert.equal(niceMax(230000), 250000);
  assert.equal(niceMax(400000), 500000);
});

test("cash book: only CASH is cash; card, UPI, bank, cheque and finance are non-cash", () => {
  assert.deepEqual(PAYMENT_MODES, ["CASH", "CARD", "UPI", "BANK", "CHEQUE", "FINANCE"]);
  assert.equal(bucketOf("CASH"), "cash");
  for (const m of ["CARD", "UPI", "BANK", "CHEQUE", "FINANCE"]) assert.equal(bucketOf(m), "bank");
});

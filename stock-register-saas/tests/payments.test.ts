import { test } from "node:test";
import assert from "node:assert/strict";
import { calcLine, calcTotals, lineDiscount, paymentError, paymentSummary, type BillPaymentInput } from "../lib/gst.ts";

test("lineDiscount: ₹ amount gives the %, % gives the ₹ amount", () => {
  // ₹500 off a ₹10,000 line = 5%
  assert.deepEqual(lineDiscount(1, 10000, 0, 500), { amount: 500, pct: 5 });
  // 7.5% of 2 × 1,299 = 194.85
  assert.deepEqual(lineDiscount(2, 1299, 7.5, 0), { amount: 194.85, pct: 7.5 });
  // Odd ₹ amount → % kept to 4 decimals
  assert.deepEqual(lineDiscount(3, 999, 0, 100), { amount: 100, pct: 3.3367 });
  // ₹ wins when both are sent
  assert.equal(lineDiscount(1, 1000, 50, 10).amount, 10);
  // Clamped to the line value, never negative
  assert.deepEqual(lineDiscount(1, 100, 0, 250), { amount: 100, pct: 100 });
  assert.deepEqual(lineDiscount(0, 100, 10, 0), { amount: 0, pct: 0 });
});

test("calcLine with a ₹ discount: taxable is gross minus the exact rupees", () => {
  const r = calcLine({ qty: 1, rate: 12711.86, discountAmt: 211.86, taxRate: 18 });
  assert.equal(r.taxable, 12500);
  assert.equal(r.tax, 2250);
  assert.equal(r.amount, 14750);
  assert.equal(r.discount, 211.86);
  // The same discount entered as the derived % gives the same taxable value
  const viaPct = calcLine({ qty: 1, rate: 12711.86, discountPct: r.discountPct, taxRate: 18 });
  assert.ok(Math.abs(viaPct.taxable - r.taxable) <= 0.01);
});

test("calcTotals reports the ₹ discount across lines", () => {
  const t = calcTotals(
    [
      { qty: 1, rate: 1000, discountAmt: 100, taxRate: 18 },
      { qty: 2, rate: 500, discountPct: 10, taxRate: 18 },
    ],
    { gstEnabled: true, interState: false },
  );
  assert.equal(t.discount, 200);
  assert.equal(t.subtotal, 1800);
});

const pay = (mode: BillPaymentInput["mode"], amount: number, extra: Partial<BillPaymentInput> = {}): BillPaymentInput => ({ mode, amount, ...extra });
const finance = (amount: number, extra: Partial<BillPaymentInput> = {}) =>
  pay("FINANCE", amount, { financier: "Bajaj Finserv", paymentInfo: "DO 55123", scheme: "6 EMI, 0 down", ...extra });

test("paymentError: split payment 5000 card + 4000 UPI + 1000 cash on a 10,000 bill", () => {
  const rows = [pay("CARD", 5000), pay("UPI", 4000), pay("CASH", 1000)];
  assert.equal(paymentError(rows, { total: 10000, hasParty: true }), null);
  assert.equal(paymentError(rows, { total: 10000, hasParty: false }), null);
  assert.equal(paymentSummary(rows), "CARD 5,000 · UPI 4,000 · CASH 1,000");
});

test("paymentError: walk-in sale must be fully paid; party sale may be part-paid", () => {
  const part = [pay("CASH", 4000)];
  assert.match(paymentError(part, { total: 10000, hasParty: false }) ?? "", /walk-in sale must be fully paid/);
  assert.equal(paymentError(part, { total: 10000, hasParty: true }), null);
  // No payments at all: nothing to check
  assert.equal(paymentError([], { total: 10000, hasParty: false }), null);
});

test("paymentError: more than the total is refused (incl. payments recorded later)", () => {
  assert.match(paymentError([pay("CASH", 10001)], { total: 10000, hasParty: true }) ?? "", /more than the bill total/);
  assert.match(paymentError([pay("CASH", 6000)], { total: 10000, hasParty: true, otherPaid: 5000 }) ?? "", /already received/);
  assert.equal(paymentError([pay("CASH", 5000)], { total: 10000, hasParty: true, otherPaid: 5000 }), null);
});

test("paymentError: FINANCE needs financier, payment info and scheme", () => {
  assert.equal(paymentError([finance(8000), pay("CASH", 2000)], { total: 10000, hasParty: false }), null);
  assert.match(paymentError([finance(8000, { financier: "" })], { total: 8000, hasParty: true }) ?? "", /financier/);
  assert.match(paymentError([finance(8000, { paymentInfo: " " })], { total: 8000, hasParty: true }) ?? "", /payment info/);
  assert.match(paymentError([finance(8000, { scheme: "" })], { total: 8000, hasParty: true }) ?? "", /scheme/);
  assert.match(paymentError([finance(0)], { total: 8000, hasParty: true }) ?? "", /disbursement amount/);
  assert.equal(paymentSummary([finance(60000), pay("CASH", 20000)]), "FINANCE (Bajaj Finserv) 60,000 · CASH 20,000");
});

test("paymentError: zero amounts and too many rows are refused", () => {
  assert.match(paymentError([pay("UPI", 0)], { total: 100, hasParty: true }) ?? "", /amount for UPI/);
  const seven = Array.from({ length: 7 }, () => pay("CASH", 1));
  assert.match(paymentError(seven, { total: 100, hasParty: true }) ?? "", /at most 6/);
});

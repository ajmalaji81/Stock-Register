import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountInWords,
  calcLine,
  calcTotals,
  CONVERSIONS,
  formatNumber,
  INDIAN_STATES,
  isInterState,
  stockEffect,
} from "../lib/gst.ts";

test("calcLine: discount then tax, rounded to paise", () => {
  assert.deepEqual(calcLine({ qty: 3, rate: 99.99, discountPct: 10, taxRate: 18 }), { taxable: 269.97, tax: 48.59, amount: 318.56, discount: 30, discountPct: 10 });
  assert.deepEqual(calcLine({ qty: 2, rate: 50, taxRate: 5 }, false), { taxable: 100, tax: 0, amount: 100, discount: 0, discountPct: 0 });
  // Discount is clamped to 0..100
  assert.equal(calcLine({ qty: 1, rate: 100, discountPct: 150, taxRate: 18 }).taxable, 0);
});

test("isInterState compares business state with place of supply", () => {
  assert.equal(isInterState("Tamil Nadu", "Tamil Nadu"), false);
  assert.equal(isInterState("Tamil Nadu", " tamil nadu "), false);
  assert.equal(isInterState("Tamil Nadu", "Kerala"), true);
  assert.equal(isInterState("", "Kerala"), false);
  assert.equal(isInterState("Tamil Nadu", ""), false);
});

test("calcTotals intra-state splits CGST/SGST; inter-state uses IGST", () => {
  const lines = [{ qty: 2, rate: 1800, taxRate: 5 }, { qty: 1, rate: 135, discountPct: 0, taxRate: 0 }];
  const intra = calcTotals(lines, { gstEnabled: true, interState: false });
  assert.equal(intra.subtotal, 3735);
  assert.equal(intra.cgst, 90);
  assert.equal(intra.sgst, 90);
  assert.equal(intra.igst, 0);
  assert.equal(intra.total, 3915);
  const inter = calcTotals(lines, { gstEnabled: true, interState: true });
  assert.equal(inter.igst, 180);
  assert.equal(inter.cgst + inter.sgst, 0);
  assert.equal(inter.total, 3915);
});

test("odd tax splits so CGST + SGST equals the tax exactly", () => {
  const t = calcTotals([{ qty: 1, rate: 10.1, taxRate: 5 }], { gstEnabled: true, interState: false });
  // tax = 0.51 (0.505 rounded) -> 0.26 + 0.25
  assert.equal(r(t.cgst + t.sgst), 0.51);
});

test("round-off to the nearest rupee and records the difference", () => {
  const t = calcTotals([{ qty: 1, rate: 100.4, taxRate: 0 }], { gstEnabled: true, interState: false });
  assert.equal(t.total, 100);
  assert.equal(t.roundOff, -0.4);
  const up = calcTotals([{ qty: 1, rate: 100.5, taxRate: 0 }], { gstEnabled: true, interState: false });
  assert.equal(up.total, 101);
  assert.equal(up.roundOff, 0.5);
  const exact = calcTotals([{ qty: 1, rate: 100.4, taxRate: 0 }], { gstEnabled: true, interState: false, roundOff: false });
  assert.equal(exact.total, 100.4);
  assert.equal(exact.roundOff, 0);
});

test("discount total is reported", () => {
  const t = calcTotals([{ qty: 4, rate: 250, discountPct: 10, taxRate: 12 }], { gstEnabled: true, interState: false });
  assert.equal(t.discount, 100);
  assert.equal(t.subtotal, 900);
  assert.equal(t.cgst + t.sgst, 108);
});

test("amountInWords uses Indian numbering", () => {
  assert.equal(amountInWords(0), "Rupees Zero Only");
  assert.equal(amountInWords(15), "Rupees Fifteen Only");
  assert.equal(amountInWords(1234.5), "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only");
  assert.equal(amountInWords(100000), "Rupees One Lakh Only");
  assert.equal(amountInWords(25_07_300), "Rupees Twenty Five Lakh Seven Thousand Three Hundred Only");
  assert.equal(amountInWords(12_34_56_789), "Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only");
});

test("stock effect and conversions per voucher kind", () => {
  assert.equal(stockEffect("SALE"), "OUT");
  assert.equal(stockEffect("PURCHASE_RETURN"), "OUT");
  assert.equal(stockEffect("CHALLAN"), "OUT");
  assert.equal(stockEffect("PURCHASE"), "IN");
  assert.equal(stockEffect("SALE_RETURN"), "IN");
  assert.equal(stockEffect("QUOTATION"), null);
  assert.equal(stockEffect("SALES_ORDER"), null);
  assert.equal(stockEffect("PURCHASE_ORDER"), null);
  assert.deepEqual(CONVERSIONS.QUOTATION, ["SALES_ORDER", "SALE"]);
  assert.deepEqual(CONVERSIONS.CHALLAN, ["SALE"]);
  assert.equal(CONVERSIONS.SALE, undefined);
});

test("numbering and states list", () => {
  assert.equal(formatNumber("INV", 7), "INV-0007");
  assert.equal(formatNumber("QT", 12345), "QT-12345");
  assert.equal(INDIAN_STATES.length, 36);
  assert.ok(INDIAN_STATES.includes("Tamil Nadu"));
});

function r(n: number) {
  return Math.round(n * 100) / 100;
}

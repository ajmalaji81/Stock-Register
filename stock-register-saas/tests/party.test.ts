import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPartyLedger,
  bucketOf,
  ledgerSign,
  partyBalance,
  paymentSign,
  reminderMessage,
  summarizeCash,
  waPhone,
  whatsappLink,
  type LedgerSource,
} from "../lib/money.ts";

const zero = { openingBalance: 0, sale: 0, saleReturn: 0, purchase: 0, purchaseReturn: 0, paidIn: 0, paidOut: 0 };

test("partyBalance: receivable +, payable −", () => {
  assert.equal(partyBalance({ ...zero, sale: 1000 }), 1000);
  assert.equal(partyBalance({ ...zero, sale: 1000, saleReturn: 200, paidIn: 300 }), 500);
  assert.equal(partyBalance({ ...zero, purchase: 5000, paidOut: 2000 }), -3000);
  assert.equal(partyBalance({ ...zero, purchase: 5000, purchaseReturn: 500 }), -4500);
  assert.equal(partyBalance({ ...zero, openingBalance: -250, sale: 250 }), 0);
  assert.equal(partyBalance({ ...zero, sale: 0.1, paidIn: 0.3, openingBalance: 0.2 }), 0);
});

test("signs agree with the balance formula", () => {
  assert.equal(paymentSign("IN"), -1);
  assert.equal(paymentSign("OUT"), 1);
  assert.equal(ledgerSign("SALE"), 1);
  assert.equal(ledgerSign("SALE_RETURN"), -1);
  assert.equal(ledgerSign("PURCHASE"), -1);
  assert.equal(ledgerSign("PURCHASE_RETURN"), 1);
  assert.equal(ledgerSign("PAYMENT_IN"), -1);
  assert.equal(ledgerSign("PAYMENT_OUT"), 1);
});

const src = (id: string, date: string, kind: LedgerSource["kind"], amount: number): LedgerSource => ({
  id,
  date,
  createdAt: `${date}T10:00:00.000Z`,
  kind,
  ref: id,
  amount,
  notes: "",
});

test("buildPartyLedger: sorted, running balance, opening row", () => {
  const rows = buildPartyLedger(100, [src("p1", "2026-11-05", "PAYMENT_IN", 300), src("s1", "2026-11-01", "SALE", 500)]);
  assert.deepEqual(
    rows.map((r) => [r.ref, r.debit, r.credit, r.balance]),
    [
      ["Opening balance", 100, 0, 100],
      ["s1", 500, 0, 600],
      ["p1", 0, 300, 300],
    ],
  );
});

test("buildPartyLedger: date filter folds earlier rows into Balance b/f and stops after `to`", () => {
  const all = [src("s1", "2026-10-01", "SALE", 1000), src("p1", "2026-10-15", "PAYMENT_IN", 400), src("s2", "2026-11-02", "SALE", 200), src("s3", "2026-12-01", "SALE", 50)];
  const rows = buildPartyLedger(0, all, "2026-11-01", "2026-11-30");
  assert.deepEqual(
    rows.map((r) => [r.ref, r.balance]),
    [
      ["Balance b/f", 600],
      ["s2", 800],
    ],
  );
  // No rows in range: still shows the carried balance.
  assert.deepEqual(
    buildPartyLedger(0, all, "2026-11-10", "2026-11-20").map((r) => [r.ref, r.balance]),
    [["Balance b/f", 800]],
  );
  // Payable side shows as credit.
  const pay = buildPartyLedger(-500, [], undefined, undefined);
  assert.deepEqual([pay[0].debit, pay[0].credit, pay[0].balance], [0, 500, -500]);
});

test("waPhone / whatsappLink", () => {
  assert.equal(waPhone("98765 43210"), "919876543210");
  assert.equal(waPhone("09876543210"), "919876543210");
  assert.equal(waPhone("+91-98765-43210"), "919876543210");
  assert.equal(waPhone("+1 415 555 0100"), "14155550100");
  assert.equal(waPhone("12345"), null);
  assert.equal(whatsappLink("", "hi"), null);
  const link = whatsappLink("9876543210", reminderMessage("Sharma Kirana", 1500, "Gupta Traders"));
  assert.ok(link?.startsWith("https://wa.me/919876543210?text="));
  const text = decodeURIComponent(link!.split("text=")[1]);
  assert.match(text, /Sharma Kirana/);
  assert.match(text, /Gupta Traders/);
  assert.match(text, /1,500/);
});

test("summarizeCash: opening from earlier flows, cash vs bank buckets, day-wise", () => {
  assert.equal(bucketOf("CASH"), "cash");
  assert.equal(bucketOf("UPI"), "bank");
  assert.equal(bucketOf("CHEQUE"), "bank");
  const s = summarizeCash(
    [
      { date: "2026-10-30", mode: "CASH", amount: 1000 },
      { date: "2026-10-31", mode: "BANK", amount: 5000 },
      { date: "2026-11-01", mode: "CASH", amount: 300 },
      { date: "2026-11-01", mode: "CASH", amount: -120 },
      { date: "2026-11-02", mode: "UPI", amount: -2000 },
      { date: "2026-12-01", mode: "CASH", amount: 9999 },
    ],
    "2026-11-01",
    "2026-11-30",
  );
  assert.equal(s.openingCash, 1000);
  assert.equal(s.openingBank, 5000);
  assert.equal(s.closingCash, 1180);
  assert.equal(s.closingBank, 3000);
  assert.deepEqual(s.days, [
    { date: "2026-11-01", cashIn: 300, cashOut: 120, bankIn: 0, bankOut: 0 },
    { date: "2026-11-02", cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 2000 },
  ]);
});

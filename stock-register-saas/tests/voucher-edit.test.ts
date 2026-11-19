import { test } from "node:test";
import assert from "node:assert/strict";
import { editBlockReason, EDITABLE_KINDS, netStockEffect } from "../lib/gst.ts";

test("only sales invoices are editable, and only while open and not from a challan", () => {
  assert.deepEqual(EDITABLE_KINDS, ["SALE"]);
  assert.equal(editBlockReason("SALE", "OPEN", null), null);
  assert.equal(editBlockReason("SALE", "OPEN", "QUOTATION"), null);
  assert.equal(editBlockReason("SALE", "OPEN", "SALES_ORDER"), null);
  assert.match(editBlockReason("SALE", "CANCELLED", null) ?? "", /cancelled/);
  assert.match(editBlockReason("SALE", "CONVERTED", null) ?? "", /converted/);
  assert.match(editBlockReason("SALE", "OPEN", "CHALLAN") ?? "", /challan/);
  assert.ok(editBlockReason("PURCHASE", "OPEN", null));
  assert.ok(editBlockReason("SALE_RETURN", "OPEN", null));
  assert.ok(editBlockReason("QUOTATION", "OPEN", null));
});

test("netStockEffect sums a bill's entries per item + godown and drops zeros", () => {
  const e = (itemId: string, godownId: string, qtyIn: number, qtyOut: number) => ({ itemId, godownId, qtyIn, qtyOut });
  // original sale: 3 of A, 2 of B out of g1
  const original = [e("A", "g1", 0, 3), e("B", "g1", 0, 2)];
  assert.deepEqual(netStockEffect(original), [
    { itemId: "A", godownId: "g1", qty: -3 },
    { itemId: "B", godownId: "g1", qty: -2 },
  ]);
  // edit 1: reversal (+3 A, +2 B) then new lines: 5 of A only
  const afterEdit = [...original, e("A", "g1", 3, 0), e("B", "g1", 2, 0), e("A", "g1", 0, 5)];
  assert.deepEqual(netStockEffect(afterEdit), [{ itemId: "A", godownId: "g1", qty: -5 }]);
  // edit 2: reversal (+5 A) then move to another godown
  const afterEdit2 = [...afterEdit, e("A", "g1", 5, 0), e("A", "g2", 0, 1.5)];
  assert.deepEqual(netStockEffect(afterEdit2), [{ itemId: "A", godownId: "g2", qty: -1.5 }]);
  // float noise rounds away
  assert.deepEqual(netStockEffect([e("A", "g1", 0.1, 0), e("A", "g1", 0.2, 0), e("A", "g1", 0, 0.3)]), []);
});

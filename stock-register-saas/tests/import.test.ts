import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_TEMPLATE, PARTY_TEMPLATE, mapItemRows, mapPartyRows, parseDelimited } from "../lib/import.ts";

test("parseDelimited: quotes, escaped quotes, commas and newlines inside quotes", () => {
  const rows = parseDelimited('a,b,c\n"x, y","say ""hi""","line1\nline2"\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["x, y", 'say "hi"', "line1\nline2"]]);
});

test("parseDelimited: CRLF, BOM, blank lines and trimming", () => {
  const rows = parseDelimited("﻿name,sku\r\n Rice , R1 \r\n\r\n,\r\nOil,O1");
  assert.deepEqual(rows, [["name", "sku"], ["Rice", "R1"], ["Oil", "O1"]]);
});

test("parseDelimited: tab-separated paste from Excel (commas inside cells kept)", () => {
  const rows = parseDelimited("Name\tSKU\tAddress\nRice\tR1\t12, Market Rd\n");
  assert.deepEqual(rows, [["Name", "SKU", "Address"], ["Rice", "R1", "12, Market Rd"]]);
});

test("mapItemRows: header aliases, numbers with ₹ and commas, defaults", () => {
  const t = parseDelimited('Item Name,Barcode,MRP,Cost Price,GST %,Opening Stock,Godown\nRice,R1,"₹2,150",1800,5%,40,Main Shop\n');
  const r = mapItemRows(t);
  assert.deepEqual(r.headerErrors, []);
  assert.equal(r.rows.length, 1);
  const d = r.rows[0].data;
  assert.equal(d.name, "Rice");
  assert.equal(d.sku, "R1");
  assert.equal(d.salePrice, 2150);
  assert.equal(d.purchasePrice, 1800);
  assert.equal(d.gstRate, 5);
  assert.equal(d.openingQty, 40);
  assert.equal(d.openingGodown, "Main Shop");
  assert.equal(d.unit, "pcs");
  assert.deepEqual(r.rows[0].errors, []);
  assert.equal(r.rows[0].line, 2);
});

test("mapItemRows: missing required column, bad numbers, duplicate SKU, unknown columns", () => {
  assert.deepEqual(mapItemRows(parseDelimited("name,price\nRice,10")).headerErrors, ['Missing column "sku".']);
  const r = mapItemRows(parseDelimited("name,sku,purchasePrice,colour\nRice,R1,abc,red\nOil,r1,5,blue\n,X,1,\n"));
  assert.deepEqual(r.ignored, ["colour"]);
  assert.match(r.rows[0].errors.join(), /Purchase price/);
  assert.match(r.rows[1].errors.join(), /Duplicate SKU \(also on line 2\)/);
  assert.match(r.rows[2].errors.join(), /Name is required/);
  assert.equal(mapItemRows([]).headerErrors[0], "The file is empty.");
});

test("mapPartyRows: types, GSTIN upper-cased, signed opening balance, bad email", () => {
  const r = mapPartyRows(parseDelimited("Party Name,Type,Mobile,GSTIN,Opening Balance,Email\nA,Supplier,999,33abcde1234f1z5,-1200,\nB,,1,,500,bad\nC,friend,,,,\n"));
  assert.equal(r.rows[0].data.type, "SUPPLIER");
  assert.equal(r.rows[0].data.gstin, "33ABCDE1234F1Z5");
  assert.equal(r.rows[0].data.openingBalance, -1200);
  assert.deepEqual(r.rows[0].errors, []);
  assert.equal(r.rows[1].data.type, "CUSTOMER");
  assert.match(r.rows[1].errors.join(), /Email/);
  assert.match(r.rows[2].errors.join(), /Type must be/);
});

test("sample templates parse cleanly", () => {
  const items = mapItemRows(parseDelimited(ITEM_TEMPLATE));
  assert.equal(items.rows.length, 2);
  assert.ok(items.rows.every((r) => r.errors.length === 0));
  const parties = mapPartyRows(parseDelimited(PARTY_TEMPLATE));
  assert.equal(parties.rows.length, 2);
  assert.ok(parties.rows.every((r) => r.errors.length === 0));
  assert.equal(parties.rows[0].data.address, "12, Market Road, Chennai");
});

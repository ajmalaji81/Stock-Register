import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StockError,
  assertCanRemove,
  assertWithinLimit,
  demoAddGodown,
  demoDeleteItem,
  demoMovement,
  demoSaveItem,
  demoTransfer,
  isLowStock,
  itemTotal,
  matchesFilter,
  qtyInScope,
  round3,
  seedDemo,
  stockValue,
  summarizeToday,
  toCsv,
  todayISO,
  type DemoState,
} from "../lib/engine.ts";
import type { Item, LedgerEntry } from "../lib/types.ts";

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  name: "Rice",
  sku: "R1",
  category: "Grains",
  unit: "Bag",
  purchasePrice: 100,
  salePrice: 120,
  minStockAlert: 10,
  hsn: "",
  gstRate: 0,
  stock: { g1: 4, g2: 6 },
  ...over,
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "e1",
  itemId: "i1",
  itemName: "Rice",
  unit: "Bag",
  godownId: "g1",
  godownName: "Main",
  type: "IN",
  qtyIn: 1,
  qtyOut: 0,
  balance: 1,
  itemBalance: 1,
  rate: 10,
  party: "",
  remarks: "",
  date: "2026-11-17",
  createdAt: "2026-11-17T00:00:00.000Z",
  transferId: null,
  ...over,
});

function expectStockError(fn: () => unknown, status: number, code?: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof StockError, "expected StockError");
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

// ---------- helpers ----------

test("round3 rounds to 3 decimals", () => {
  assert.equal(round3(0.1 + 0.2), 0.3);
  assert.equal(round3(1.23456), 1.235);
  assert.equal(round3(-2.0004), -2);
});

test("todayISO is YYYY-MM-DD in local time", () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayISO(new Date(2026, 0, 5)), "2026-01-05");
});

test("itemTotal / qtyInScope", () => {
  const it = item();
  assert.equal(itemTotal(it), 10);
  assert.equal(qtyInScope(it, "ALL"), 10);
  assert.equal(qtyInScope(it, "g2"), 6);
  assert.equal(qtyInScope(it, "missing"), 0);
});

test("isLowStock uses scope and treats minStockAlert 0 as never low", () => {
  const it = item({ minStockAlert: 5 });
  assert.equal(isLowStock(it, "ALL"), false); // 10 > 5
  assert.equal(isLowStock(it, "g1"), true); // 4 <= 5
  assert.equal(isLowStock(item({ minStockAlert: 10 }), "ALL"), true); // equal counts as low
  assert.equal(isLowStock(item({ minStockAlert: 0, stock: { g1: 0 } }), "ALL"), false);
});

test("stockValue = qty x purchase price in scope", () => {
  const items = [item(), item({ id: "i2", purchasePrice: 2.5, stock: { g1: 3 } })];
  assert.equal(stockValue(items, "ALL"), 1000 + 7.5);
  assert.equal(stockValue(items, "g1"), 400 + 7.5);
});

test("assertCanRemove: exact ok, more fails, float noise tolerated", () => {
  assert.doesNotThrow(() => assertCanRemove(5, 5, "Rice", "Main"));
  assert.doesNotThrow(() => assertCanRemove(0.1 + 0.2, 0.3, "Rice", "Main"));
  expectStockError(() => assertCanRemove(5, 5.001, "Rice", "Main"), 400, "INSUFFICIENT_STOCK");
  assert.throws(() => assertCanRemove(2, 3, "Rice", "Main"), /available 2, requested 3/);
});

test("assertWithinLimit: null is unlimited, at limit throws 402 LIMIT", () => {
  assert.doesNotThrow(() => assertWithinLimit(10_000, null, "items"));
  assert.doesNotThrow(() => assertWithinLimit(4, 5, "items"));
  expectStockError(() => assertWithinLimit(5, 5, "items"), 402, "LIMIT");
});

test("summarizeToday counts only today's IN/OUT in scope", () => {
  const today = "2026-11-17";
  const rows = [
    entry({ type: "IN", qtyIn: 2, rate: 10 }),
    entry({ type: "OUT", qtyIn: 0, qtyOut: 3, rate: 5 }),
    entry({ type: "OPENING", qtyIn: 100 }),
    entry({ type: "TRANSFER_IN", qtyIn: 7 }),
    entry({ type: "TRANSFER_OUT", qtyOut: 7, qtyIn: 0 }),
    entry({ type: "IN", qtyIn: 9, date: "2026-11-16" }),
    entry({ type: "IN", qtyIn: 4, rate: 1, godownId: "g2" }),
  ];
  assert.deepEqual(summarizeToday(rows, today, "ALL"), { inCount: 2, outCount: 1, inValue: 24, outValue: 15 });
  assert.deepEqual(summarizeToday(rows, today, "g1"), { inCount: 1, outCount: 1, inValue: 20, outValue: 15 });
  assert.deepEqual(summarizeToday(rows, today, "g2"), { inCount: 1, outCount: 0, inValue: 4, outValue: 0 });
});

test("matchesFilter", () => {
  const e = entry({ date: "2026-11-10" });
  assert.equal(matchesFilter(e, {}), true);
  assert.equal(matchesFilter(e, { itemId: "i1" }), true);
  assert.equal(matchesFilter(e, { itemId: "x" }), false);
  assert.equal(matchesFilter(e, { godownId: "ALL" }), true);
  assert.equal(matchesFilter(e, { godownId: "g2" }), false);
  assert.equal(matchesFilter(e, { type: "IN" }), true);
  assert.equal(matchesFilter(e, { type: "OUT" }), false);
  assert.equal(matchesFilter(e, { from: "2026-11-10", to: "2026-11-10" }), true);
  assert.equal(matchesFilter(e, { from: "2026-11-11" }), false);
  assert.equal(matchesFilter(e, { to: "2026-11-09" }), false);
});

test("toCsv quoting and formula-injection guard", () => {
  assert.equal(toCsv([["a", 1], ["b", 2.5]]), "a,1\r\nb,2.5");
  assert.equal(toCsv([['say "hi"', "x,y", "line1\nline2"]]), '"say ""hi""","x,y","line1\nline2"');
  assert.equal(toCsv([["=SUM(A1)", "+cmd", "@x", "-foo"]]), "'=SUM(A1),'+cmd,'@x,'-foo");
  assert.equal(toCsv([[-5, "-5", "-3.2"]]), "-5,-5,-3.2");
});

// ---------- demo register ----------

function assertConsistent(s: DemoState) {
  for (const it of s.items) {
    const rows = s.ledger.filter((e) => e.itemId === it.id);
    if (rows.length) assert.equal(rows[rows.length - 1].itemBalance, itemTotal(it), `itemBalance for ${it.name}`);
    const running: Record<string, number> = {};
    let total = 0;
    for (const e of rows) {
      running[e.godownId] = round3((running[e.godownId] ?? 0) + e.qtyIn - e.qtyOut);
      // A transfer only moves stock between godowns: both of its entries show the unchanged item total.
      if (e.type !== "TRANSFER_IN" && e.type !== "TRANSFER_OUT") total = round3(total + e.qtyIn - e.qtyOut);
      assert.equal(e.balance, running[e.godownId], `balance of ${e.id}`);
      assert.equal(e.itemBalance, total, `itemBalance of ${e.id}`);
    }
    for (const g of s.godowns) assert.equal(it.stock[g.id] ?? 0, running[g.id] ?? 0, `${it.name} @ ${g.name}`);
  }
}

test("seedDemo: 2 godowns, 4 items, balances consistent", () => {
  const s = seedDemo(new Date(2026, 10, 17));
  assert.equal(s.godowns.length, 2);
  assert.equal(s.items.length, 4);
  assert.ok(s.ledger.length > 4);
  assertConsistent(s);
  for (const it of s.items) for (const g of s.godowns) assert.equal(typeof it.stock[g.id], "number");
});

test("demoMovement IN/OUT updates stock; OUT beyond stock throws without mutating input", () => {
  const s = seedDemo();
  const [main] = s.godowns;
  const it = s.items[0];
  const before = JSON.stringify(s);
  const have = it.stock[main.id];
  const base = { itemId: it.id, godownId: main.id, rate: 1, party: "", remarks: "", date: todayISO() };

  expectStockError(() => demoMovement(s, { ...base, type: "OUT", qty: have + 1 }), 400, "INSUFFICIENT_STOCK");
  assert.equal(JSON.stringify(s), before, "input state untouched after failure");

  const s2 = demoMovement(s, { ...base, type: "IN", qty: 2.5 });
  assert.equal(JSON.stringify(s), before, "input state untouched after success");
  assert.equal(s2.items[0].stock[main.id], round3(have + 2.5));
  const s3 = demoMovement(s2, { ...base, type: "OUT", qty: have + 2.5 });
  assert.equal(s3.items[0].stock[main.id], 0);
  assertConsistent(s3);
});

test("demoTransfer pairs entries and keeps item total", () => {
  const s = seedDemo();
  const [main, gA] = s.godowns;
  const it = s.items.find((i) => (i.stock[gA.id] ?? 0) >= 5)!;
  const total = itemTotal(it);
  const s2 = demoTransfer(s, { itemId: it.id, fromGodownId: gA.id, toGodownId: main.id, qty: 5, date: todayISO(), remarks: "" });
  const [out, inn] = s2.ledger.slice(-2);
  assert.equal(out.type, "TRANSFER_OUT");
  assert.equal(inn.type, "TRANSFER_IN");
  assert.ok(out.transferId);
  assert.equal(out.transferId, inn.transferId);
  assert.equal(inn.itemBalance, total);
  assert.equal(itemTotal(s2.items.find((i) => i.id === it.id)!), total);
  assertConsistent(s2);

  expectStockError(() => demoTransfer(s, { itemId: it.id, fromGodownId: main.id, toGodownId: main.id, qty: 1, date: todayISO(), remarks: "" }), 400);
  expectStockError(
    () => demoTransfer(s, { itemId: it.id, fromGodownId: gA.id, toGodownId: main.id, qty: total + 100, date: todayISO(), remarks: "" }),
    400,
    "INSUFFICIENT_STOCK",
  );
});

const newItem = (sku: string) => ({
  name: `Item ${sku}`,
  sku,
  category: "",
  unit: "pcs",
  purchasePrice: 1,
  salePrice: 2,
  minStockAlert: 0,
});

test("demoSaveItem: 5-item limit, case-insensitive SKU, edit renames ledger", () => {
  let s = seedDemo();
  s = demoSaveItem(s, newItem("NEW-1"), null, 5);
  assert.equal(s.items.length, 5);
  expectStockError(() => demoSaveItem(s, newItem("NEW-2"), null, 5), 402, "LIMIT");
  expectStockError(() => demoSaveItem(s, newItem("gr-25kg"), null, null), 409);

  const rice = s.items[0];
  const edited = demoSaveItem(s, { ...newItem(rice.sku), name: "Rice Renamed" }, rice.id, 5);
  assert.equal(edited.items.length, 5, "editing does not count against the limit");
  assert.equal(edited.items[0].name, "Rice Renamed");
  assert.deepEqual(edited.items[0].stock, rice.stock, "edit never changes stock");
  for (const e of edited.ledger.filter((x) => x.itemId === rice.id)) assert.equal(e.itemName, "Rice Renamed");
});

test("demoSaveItem with opening stock writes an OPENING entry", () => {
  const s = seedDemo();
  const gA = s.godowns[1];
  const s2 = demoSaveItem(s, { ...newItem("OPN"), openingQty: 7, openingGodownId: gA.id }, null, null);
  const it = s2.items.at(-1)!;
  assert.equal(it.stock[gA.id], 7);
  const last = s2.ledger.at(-1)!;
  assert.equal(last.type, "OPENING");
  assert.equal(last.qtyIn, 7);
  assertConsistent(s2);
});

test("demoAddGodown adds zero stock for every item and rejects duplicates / limit", () => {
  const s = seedDemo();
  const s2 = demoAddGodown(s, "Godown B", null);
  const g = s2.godowns.at(-1)!;
  assert.equal(g.name, "Godown B");
  for (const it of s2.items) assert.equal(it.stock[g.id], 0);
  expectStockError(() => demoAddGodown(s2, "  godown b ", null), 409);
  expectStockError(() => demoAddGodown(s2, "   ", null), 400);
  expectStockError(() => demoAddGodown(s2, "Godown C", 3), 402, "LIMIT");
});

test("demoDeleteItem removes the item and its ledger", () => {
  const s = seedDemo();
  const id = s.items[0].id;
  const s2 = demoDeleteItem(s, id);
  assert.equal(s2.items.some((i) => i.id === id), false);
  assert.equal(s2.ledger.some((e) => e.itemId === id), false);
  assert.ok(s.ledger.some((e) => e.itemId === id), "original untouched");
});

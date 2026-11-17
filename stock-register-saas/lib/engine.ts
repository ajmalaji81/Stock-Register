// Pure stock-ledger logic. No database, no React: used by the API (balance rules),
// the browser (stats, CSV) and the landing-page demo (full in-memory register).
// Only `import type` here so Node can run the unit tests directly.
import type {
  Godown,
  Item,
  ItemInput,
  LedgerEntry,
  LedgerFilter,
  MovementInput,
  Scope,
  TransferInput,
} from "./types";

export class StockError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Quantities are kept to 3 decimals (grams, millilitres). */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function todayISO(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function itemTotal(item: Item): number {
  return round3(Object.values(item.stock).reduce((a, b) => a + b, 0));
}

export function qtyInScope(item: Item, scope: Scope): number {
  return scope === "ALL" ? itemTotal(item) : round3(item.stock[scope] ?? 0);
}

export function isLowStock(item: Item, scope: Scope): boolean {
  return item.minStockAlert > 0 && qtyInScope(item, scope) <= item.minStockAlert;
}

export function stockValue(items: Item[], scope: Scope): number {
  return round2(items.reduce((sum, it) => sum + qtyInScope(it, scope) * it.purchasePrice, 0));
}

/**
 * Throws if taking `qty` out of a godown that holds `available` would go negative.
 * Used by both the server and the demo so the rule and message are identical.
 */
export function assertCanRemove(available: number, qty: number, itemName: string, godownName: string): void {
  if (round3(available - qty) < 0) {
    throw new StockError(
      `Not enough stock of "${itemName}" in ${godownName}: available ${round3(available)}, requested ${round3(qty)}.`,
      400,
      "INSUFFICIENT_STOCK",
    );
  }
}

export function assertWithinLimit(current: number, max: number | null, what: "items" | "godowns"): void {
  if (max !== null && current >= max) {
    throw new StockError(
      `The Free plan is limited to ${max} ${what}. Get Lifetime Pro for unlimited ${what}.`,
      402,
      "LIMIT",
    );
  }
}

export interface TodaySummary {
  inCount: number;
  outCount: number;
  inValue: number;
  outValue: number;
}

/** Today's purchases vs sales. Transfers and opening stock are not counted. */
export function summarizeToday(entries: LedgerEntry[], today: string, scope: Scope): TodaySummary {
  const s: TodaySummary = { inCount: 0, outCount: 0, inValue: 0, outValue: 0 };
  for (const e of entries) {
    if (e.date !== today) continue;
    if (scope !== "ALL" && e.godownId !== scope) continue;
    if (e.type === "IN") {
      s.inCount++;
      s.inValue += e.qtyIn * e.rate;
    } else if (e.type === "OUT") {
      s.outCount++;
      s.outValue += e.qtyOut * e.rate;
    }
  }
  s.inValue = round2(s.inValue);
  s.outValue = round2(s.outValue);
  return s;
}

export function matchesFilter(e: LedgerEntry, f: LedgerFilter): boolean {
  if (f.itemId && e.itemId !== f.itemId) return false;
  if (f.godownId && f.godownId !== "ALL" && e.godownId !== f.godownId) return false;
  if (f.type && e.type !== f.type) return false;
  if (f.from && e.date < f.from) return false;
  if (f.to && e.date > f.to) return false;
  return true;
}

// ---------- CSV ----------

function csvCell(v: string | number): string {
  const s = String(v);
  // Neutralise spreadsheet formula injection, then quote if needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

// ---------- In-memory register (landing-page demo) ----------

export interface DemoState {
  godowns: Godown[];
  items: Item[];
  ledger: LedgerEntry[];
  seq: number;
}

function nextId(state: DemoState, prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq}`;
}

function findItem(state: DemoState, id: string): Item {
  const it = state.items.find((i) => i.id === id);
  if (!it) throw new StockError("Item not found", 404);
  return it;
}

function findGodown(state: DemoState, id: string): Godown {
  const g = state.godowns.find((x) => x.id === id);
  if (!g) throw new StockError("Godown not found", 404);
  return g;
}

function pushEntry(
  state: DemoState,
  item: Item,
  godown: Godown,
  e: Pick<LedgerEntry, "type" | "qtyIn" | "qtyOut" | "rate" | "party" | "remarks" | "date" | "transferId">,
  now: Date,
): void {
  state.ledger.push({
    id: nextId(state, "ent"),
    itemId: item.id,
    itemName: item.name,
    unit: item.unit,
    godownId: godown.id,
    godownName: godown.name,
    balance: round3(item.stock[godown.id] ?? 0),
    itemBalance: itemTotal(item),
    createdAt: now.toISOString(),
    ...e,
  });
}

/** All demo mutations clone first so React sees a new object. */
export function cloneState(s: DemoState): DemoState {
  return structuredClone(s);
}

export function demoAddGodown(state: DemoState, name: string, maxGodowns: number | null): DemoState {
  const s = cloneState(state);
  const clean = name.trim();
  if (!clean) throw new StockError("Godown name is required");
  if (s.godowns.some((g) => g.name.toLowerCase() === clean.toLowerCase()))
    throw new StockError("A godown with this name already exists", 409);
  assertWithinLimit(s.godowns.length, maxGodowns, "godowns");
  const g = { id: nextId(s, "gdn"), name: clean };
  s.godowns.push(g);
  for (const it of s.items) it.stock[g.id] = 0;
  return s;
}

export function demoSaveItem(
  state: DemoState,
  input: ItemInput,
  id: string | null,
  maxItems: number | null,
  now = new Date(),
): DemoState {
  const s = cloneState(state);
  if (s.items.some((i) => i.sku.toLowerCase() === input.sku.toLowerCase() && i.id !== id))
    throw new StockError(`SKU "${input.sku}" already exists`, 409);
  const fields = {
    name: input.name,
    sku: input.sku,
    category: input.category,
    unit: input.unit,
    purchasePrice: input.purchasePrice,
    salePrice: input.salePrice,
    minStockAlert: input.minStockAlert,
    hsn: input.hsn ?? "",
    gstRate: input.gstRate ?? 0,
  };
  if (id) {
    const it = findItem(s, id);
    Object.assign(it, fields);
    for (const e of s.ledger) if (e.itemId === id) Object.assign(e, { itemName: it.name, unit: it.unit });
    return s;
  }
  assertWithinLimit(s.items.length, maxItems, "items");
  const it: Item = { id: nextId(s, "itm"), ...fields, stock: {} };
  for (const g of s.godowns) it.stock[g.id] = 0;
  s.items.push(it);
  if (input.openingQty && input.openingQty > 0) {
    const g = findGodown(s, input.openingGodownId ?? s.godowns[0]?.id ?? "");
    it.stock[g.id] = round3(input.openingQty);
    pushEntry(
      s,
      it,
      g,
      { type: "OPENING", qtyIn: round3(input.openingQty), qtyOut: 0, rate: input.purchasePrice, party: "Opening stock", remarks: "", date: todayISO(now), transferId: null },
      now,
    );
  }
  return s;
}

export function demoDeleteItem(state: DemoState, id: string): DemoState {
  const s = cloneState(state);
  s.items = s.items.filter((i) => i.id !== id);
  s.ledger = s.ledger.filter((e) => e.itemId !== id);
  return s;
}

export function demoMovement(state: DemoState, input: MovementInput, now = new Date()): DemoState {
  const s = cloneState(state);
  const it = findItem(s, input.itemId);
  const g = findGodown(s, input.godownId);
  const qty = round3(input.qty);
  if (input.type === "OUT") assertCanRemove(it.stock[g.id] ?? 0, qty, it.name, g.name);
  it.stock[g.id] = round3((it.stock[g.id] ?? 0) + (input.type === "IN" ? qty : -qty));
  pushEntry(
    s,
    it,
    g,
    {
      type: input.type,
      qtyIn: input.type === "IN" ? qty : 0,
      qtyOut: input.type === "OUT" ? qty : 0,
      rate: input.rate,
      party: input.party,
      remarks: input.remarks,
      date: input.date,
      transferId: null,
    },
    now,
  );
  return s;
}

export function demoTransfer(state: DemoState, input: TransferInput, now = new Date()): DemoState {
  if (input.fromGodownId === input.toGodownId) throw new StockError("Choose two different godowns");
  const s = cloneState(state);
  const it = findItem(s, input.itemId);
  const from = findGodown(s, input.fromGodownId);
  const to = findGodown(s, input.toGodownId);
  const qty = round3(input.qty);
  assertCanRemove(it.stock[from.id] ?? 0, qty, it.name, from.name);
  const transferId = nextId(s, "trf");
  // Move both sides first so each entry records the item total after the whole transfer.
  it.stock[from.id] = round3((it.stock[from.id] ?? 0) - qty);
  it.stock[to.id] = round3((it.stock[to.id] ?? 0) + qty);
  pushEntry(s, it, from, { type: "TRANSFER_OUT", qtyIn: 0, qtyOut: qty, rate: it.purchasePrice, party: `To ${to.name}`, remarks: input.remarks, date: input.date, transferId }, now);
  pushEntry(s, it, to, { type: "TRANSFER_IN", qtyIn: qty, qtyOut: 0, rate: it.purchasePrice, party: `From ${from.name}`, remarks: input.remarks, date: input.date, transferId }, now);
  return s;
}

/** Sample shop used by the landing-page demo. Leaves room for 1 more item under the 5-item limit. */
export function seedDemo(now = new Date()): DemoState {
  let s: DemoState = { godowns: [], items: [], ledger: [], seq: 0 };
  s = demoAddGodown(s, "Main Shop", null);
  s = demoAddGodown(s, "Godown A", null);
  const [main, gA] = s.godowns;
  const add = (input: ItemInput) => (s = demoSaveItem(s, input, null, null, now));
  add({ name: "Basmati Rice 25kg", sku: "GR-25KG", category: "Grains", unit: "Bag", purchasePrice: 1800, salePrice: 2150, minStockAlert: 10, openingQty: 60, openingGodownId: gA.id });
  add({ name: "Sugar 50kg", sku: "SG-50KG", category: "Grains", unit: "Bag", purchasePrice: 2100, salePrice: 2350, minStockAlert: 5, openingQty: 8, openingGodownId: main.id });
  add({ name: "Sunflower Oil 15L", sku: "OIL-15L", category: "Oils", unit: "Tin", purchasePrice: 1950, salePrice: 2200, minStockAlert: 6, openingQty: 4, openingGodownId: main.id });
  add({ name: "Toor Dal 1kg", sku: "DAL-1KG", category: "Pulses", unit: "pcs", purchasePrice: 135, salePrice: 160, minStockAlert: 40, openingQty: 120, openingGodownId: gA.id });
  const [rice, , oil, dal] = s.items;
  const today = todayISO(now);
  s = demoTransfer(s, { itemId: rice.id, fromGodownId: gA.id, toGodownId: main.id, qty: 20, date: today, remarks: "Shop refill" }, now);
  s = demoMovement(s, { itemId: rice.id, godownId: main.id, type: "OUT", qty: 6, rate: 2150, party: "Sharma Kirana", remarks: "Bill #1042", date: today }, now);
  s = demoMovement(s, { itemId: oil.id, godownId: main.id, type: "IN", qty: 10, rate: 1950, party: "Gupta Oil Traders", remarks: "Inv GT-883", date: today }, now);
  s = demoMovement(s, { itemId: dal.id, godownId: gA.id, type: "OUT", qty: 85, rate: 160, party: "Hotel Annapurna", remarks: "", date: today }, now);
  return s;
}

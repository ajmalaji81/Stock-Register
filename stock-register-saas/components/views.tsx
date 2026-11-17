"use client";

import { useEffect, useMemo, useState } from "react";
import { isLowStock, itemTotal, qtyInScope, stockValue, summarizeToday, toCsv, todayISO, round3 } from "@/lib/engine";
import type { StockStore } from "@/lib/store";
import type { EntryType, Godown, Item, LedgerEntry, LedgerFilter, Scope } from "@/lib/types";
import { Badge, Button, Empty, Field, IconTile, Input, Select, Stat, Tabs, downloadCsv, money, qty } from "./ui";

/** Small isometric crate (matches the GodownBook mark). */
function Crate({ tone = "brand" }: { tone?: "brand" | "low" }) {
  const c = tone === "low" ? ["#fbbf24", "#d97706", "#b45309"] : ["#4ade80", "#15803d", "#0f5c2c"];
  return (
    <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden className="shrink-0 drop-shadow-[0_4px_4px_rgb(0_0_0/0.22)]">
      <path d="M16 3 L29 10 L16 17 L3 10 Z" fill={c[0]} />
      <path d="M3 10 L16 17 L16 30 L3 23 Z" fill={c[1]} />
      <path d="M29 10 L16 17 L16 30 L29 23 Z" fill={c[2]} />
      <path d="M9.5 6.5 L22.5 13.5 L22.5 16.5 L9.5 9.5 Z" fill="#ffffff" opacity="0.5" />
    </svg>
  );
}

export interface ViewProps {
  store: StockStore;
  items: Item[];
  godowns: Godown[];
  scope: Scope;
  version: number;
  scopeName: string;
}

/** Fetch ledger entries for a filter, refetching when data changes. */
function useLedger(store: StockStore, filter: LedgerFilter, version: number) {
  const [rows, setRows] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);
  useEffect(() => {
    let live = true;
    store
      .ledger(JSON.parse(key) as LedgerFilter)
      .then((r) => live && (setRows(r), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [store, key, version]);
  return { rows, error };
}

const TYPE_LABEL: Record<EntryType, string> = {
  OPENING: "Opening",
  IN: "IN",
  OUT: "OUT",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  ADJUSTMENT: "Adjustment",
};

function TypeBadge({ type }: { type: EntryType }) {
  const tone = type === "IN" || type === "OPENING" ? "in" : type === "OUT" ? "out" : "ink";
  return <Badge tone={tone}>{TYPE_LABEL[type]}</Badge>;
}

function PrintHeader({ title, scopeName }: { title: string; scopeName: string }) {
  return (
    <div className="mb-4 hidden print:block">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="text-sm">Location: {scopeName} · Printed {new Date().toLocaleString("en-IN")}</p>
    </div>
  );
}

function ExportBar({ onCsv, disabled }: { onCsv: () => void; disabled?: boolean }) {
  return (
    <div className="flex gap-2 print:hidden">
      <Button variant="ghost" onClick={onCsv} disabled={disabled}>⬇ Export CSV</Button>
      <Button variant="ghost" onClick={() => window.print()}>🖨 Print / Save as PDF</Button>
    </div>
  );
}

// ---------------- Dashboard ----------------

export function Dashboard({
  store, items, godowns, scope, version, scopeName, onStock, onTransfer, onGoLedger, showValue = true,
}: ViewProps & {
  /** Omitted when the actor's role can't record stock IN/OUT. */
  onStock?: (t: "IN" | "OUT", itemId?: string) => void;
  /** Omitted when the actor's role can't transfer. */
  onTransfer?: () => void;
  onGoLedger: () => void;
  /** False hides stock value and money totals (roles without costs.view). */
  showValue?: boolean;
}) {
  const today = todayISO();
  const { rows } = useLedger(store, { from: today, to: today }, version);
  const low = items.filter((i) => isLowStock(i, scope));
  const t = summarizeToday(rows ?? [], today, scope);
  const recent = (rows ?? []).filter((e) => scope === "ALL" || e.godownId === scope).slice(-8).reverse();

  return (
    <div className="space-y-5">
      {(onStock || onTransfer) && (
        <div className="grid grid-cols-2 gap-2 @lg:flex @lg:flex-wrap @lg:gap-3">
          {onStock && <>
          <Button variant="in" onClick={() => onStock("IN")} className="py-3 text-base @lg:px-6">+ Stock IN</Button>
          <Button variant="out" onClick={() => onStock("OUT")} className="py-3 text-base @lg:px-6">− Stock OUT</Button>
          </>}
          {onTransfer && <Button variant="ghost" onClick={onTransfer} disabled={godowns.length < 2} className="col-span-2 py-3 text-base @lg:px-6">⇄ Transfer</Button>}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @4xl:grid-cols-4">
        {showValue && <Stat icon="₹" tone="in" label="Total stock value" value={money(stockValue(items, scope))} sub={`at purchase price · ${scopeName}`} />}
        <Stat icon="📦" label="Total SKUs" value={items.length} sub={`${items.filter((i) => qtyInScope(i, scope) > 0).length} in stock`} />
        <Stat icon="⚠" label="Low stock alerts" tone={low.length ? "low" : "ink"} value={<span className={low.length ? "text-low" : ""}>{low.length}</span>} sub={low.length ? "at or below minimum" : "all good"} />
        <Stat
          icon="⇅"
          label="Today IN vs OUT"
          value={
            <span>
              <span className="text-in">{t.inCount}</span>
              <span className="text-ink/40"> / </span>
              <span className="text-out">{t.outCount}</span>
            </span>
          }
          sub={<><span className="text-in">{money(t.inValue)}</span> in · <span className="text-out">{money(t.outValue)}</span> out</>}
        />
      </div>

      <div className="grid gap-5 @4xl:grid-cols-2">
        <section>
          <h3 className="mb-2 flex items-center gap-2 font-bold"><IconTile size="sm" tone="low">⚠</IconTile> Low stock</h3>
          {low.length === 0 ? (
            <Empty>No items below their minimum stock level.</Empty>
          ) : (
            <div className="card-3d relative overflow-hidden border-low/40 pt-1.5">
              <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-low to-[#fbbf24]" />
              <ul className="divide-y divide-ink/10">
              {low.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{i.name}</div>
                    <div className="text-xs text-ink/60">{i.sku} · min {qty(i.minStockAlert)} {i.unit}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold tabular-nums text-low">{qty(qtyInScope(i, scope))} {i.unit}</span>
                    {onStock && <Button variant="in" className="px-2 py-1 text-xs" onClick={() => onStock("IN", i.id)}>+ IN</Button>}
                  </div>
                </li>
              ))}
              </ul>
            </div>
          )}
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-bold"><IconTile size="sm" tone="in">📒</IconTile> Today&apos;s entries</h3>
            <button className="rounded-md text-sm font-semibold underline focus-visible:outline-3 focus-visible:outline-brand" onClick={onGoLedger}>Full ledger →</button>
          </div>
          {rows === null ? (
            <Empty>Loading…</Empty>
          ) : recent.length === 0 ? (
            <Empty>No stock moved today yet.</Empty>
          ) : (
            <ul className="card-3d divide-y divide-ink/10 overflow-hidden">
              {recent.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{e.itemName}</div>
                    <div className="truncate text-xs text-ink/60">{e.godownName}{e.party ? ` · ${e.party}` : ""}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <TypeBadge type={e.type} />
                    <span className={`font-bold tabular-nums ${e.qtyIn ? "text-in" : "text-out"}`}>
                      {e.qtyIn ? `+${qty(e.qtyIn)}` : `−${qty(e.qtyOut)}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------- Items ----------------

export function ItemsView({
  items, godowns, scope, onNew, onEdit, onDelete, onStock, onLedger, showCosts = true,
}: Pick<ViewProps, "items" | "godowns" | "scope"> & {
  /** Each action is omitted when the actor's role can't do it; its button is then hidden. */
  onNew?: () => void;
  onEdit?: (i: Item) => void;
  onDelete?: (i: Item) => void;
  onStock?: (t: "IN" | "OUT", itemId: string) => void;
  onLedger: (itemId: string) => void;
  /** False hides the purchase price (roles without costs.view). */
  showCosts?: boolean;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const cats = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(), [items]);
  const needle = q.trim().toLowerCase();
  const shown = items.filter(
    (i) => (!cat || i.category === cat) && (!needle || i.name.toLowerCase().includes(needle) || i.sku.toLowerCase().includes(needle)),
  );

  return (
    <div className="space-y-3">
      <div className="card-3d flex flex-wrap items-center gap-2 p-2.5">
        <Input className="min-w-0 flex-1 @lg:max-w-xs" placeholder="🔍 Search name or SKU / barcode" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-auto" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        {onNew && <Button onClick={onNew} className="ml-auto">+ New item</Button>}
      </div>
      {shown.length === 0 ? (
        <Empty>{items.length ? "No items match your search." : "No items yet. Add your first item to start the register."}</Empty>
      ) : (
        <div className="grid gap-4 @xl:grid-cols-2 @5xl:grid-cols-3">
          {shown.map((i) => {
            const low = isLowStock(i, scope);
            return (
              <article key={i.id} className={`card-3d tilt relative overflow-hidden p-4 ${low ? "border-low/50" : ""}`}>
                {low && <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-low to-[#fbbf24]" />}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-bold">{i.name}</h3>
                    <p className="text-xs text-ink/60">{i.sku}{i.category ? ` · ${i.category}` : ""}</p>
                  </div>
                  {low && <Badge tone="low">LOW</Badge>}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className={`text-2xl font-bold tabular-nums ${low ? "text-low" : ""}`}>{qty(qtyInScope(i, scope))}</span>
                  <span className="text-sm text-ink/60">{i.unit}{scope === "ALL" ? " total" : ""}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {godowns.map((g) => (
                    <span key={g.id} className={`rounded-lg px-2 py-0.5 text-xs ${g.id === scope ? "bg-ink text-paper shadow-[0_2px_0_#000]" : "well"}`}>
                      {g.name}: <b className="tabular-nums">{qty(i.stock[g.id] ?? 0)}</b>
                    </span>
                  ))}
                </div>
                <dl className="well mt-3 grid grid-cols-3 gap-1 rounded-xl px-3 py-2 text-xs">
                  {showCosts && <div><dt className="text-ink/60">Buy</dt><dd className="font-semibold">{money(i.purchasePrice)}</dd></div>}
                  <div><dt className="text-ink/60">Sell</dt><dd className="font-semibold">{money(i.salePrice)}</dd></div>
                  <div><dt className="text-ink/60">Min</dt><dd className="font-semibold">{qty(i.minStockAlert)}</dd></div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {onStock && <Button variant="in" className="px-2.5 py-1.5 text-xs" onClick={() => onStock("IN", i.id)}>+ IN</Button>}
                  {onStock && <Button variant="out" className="px-2.5 py-1.5 text-xs" onClick={() => onStock("OUT", i.id)}>− OUT</Button>}
                  <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => onLedger(i.id)}>Ledger</Button>
                  {onEdit && <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => onEdit(i)}>Edit</Button>}
                  {onDelete && <Button variant="danger" className="px-2.5 py-1.5 text-xs" onClick={() => onDelete(i)}>Delete</Button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------- Ledger (Khata) ----------------

function LedgerTable({ rows, scope }: { rows: LedgerEntry[]; scope: Scope }) {
  if (rows.length === 0) return <Empty>No entries for these filters.</Empty>;
  return (
    <div className="table-3d">
      <table className="w-full min-w-[760px] text-sm print:min-w-0 print:text-xs">
        <thead className="text-left text-xs uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Godown</th>
            <th className="px-3 py-2">Party / Particulars</th>
            <th className="px-3 py-2 text-right text-in">Qty IN</th>
            <th className="px-3 py-2 text-right text-out">Qty OUT</th>
            <th className="px-3 py-2 text-right">Balance</th>
            <th className="px-3 py-2 text-right">Rate</th>
            <th className="px-3 py-2">Remarks</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/[0.07]">
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">{e.date}</td>
              <td className="px-3 py-2 font-semibold">{e.itemName}</td>
              <td className="px-3 py-2">{e.godownName}</td>
              <td className="px-3 py-2">
                <span className="mr-1.5"><TypeBadge type={e.type} /></span>
                {e.party}
              </td>
              <td className="px-3 py-2 text-right font-bold tabular-nums text-in">{e.qtyIn ? qty(e.qtyIn) : ""}</td>
              <td className="px-3 py-2 text-right font-bold tabular-nums text-out">{e.qtyOut ? qty(e.qtyOut) : ""}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums">
                {qty(scope === "ALL" ? e.itemBalance : e.balance)} <span className="font-normal text-ink/60">{e.unit}</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{e.rate ? money(e.rate) : ""}</td>
              <td className="px-3 py-2 text-ink/70">{e.remarks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ledgerCsv(rows: LedgerEntry[], scope: Scope): string {
  return toCsv([
    ["Date", "Item", "Unit", "Godown", "Type", "Party", "Qty IN", "Qty OUT", scope === "ALL" ? "Balance (all godowns)" : "Balance (godown)", "Rate", "Remarks"],
    ...rows.map((e) => [e.date, e.itemName, e.unit, e.godownName, TYPE_LABEL[e.type], e.party, e.qtyIn || "", e.qtyOut || "", scope === "ALL" ? e.itemBalance : e.balance, e.rate || "", e.remarks]),
  ]);
}

export function LedgerView({ store, items, scope, version, scopeName, itemId, setItemId }: ViewProps & { itemId: string; setItemId: (id: string) => void }) {
  const [type, setType] = useState<"" | EntryType>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filter: LedgerFilter = { itemId: itemId || undefined, godownId: scope, type: type || undefined, from: from || undefined, to: to || undefined };
  const { rows, error } = useLedger(store, filter, version);
  const totals = (rows ?? []).reduce((a, e) => ({ in: a.in + e.qtyIn, out: a.out + e.qtyOut }), { in: 0, out: 0 });
  const oneItem = itemId ? items.find((i) => i.id === itemId) : undefined;

  return (
    <div className="space-y-3">
      <PrintHeader title={`Stock Ledger${oneItem ? ` — ${oneItem.name}` : ""}`} scopeName={scopeName} />
      <div className="card-3d grid grid-cols-2 gap-3 p-3 @2xl:grid-cols-4 print:hidden">
        <Field label="Item">
          <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">All items</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as "" | EntryType)}>
            <option value="">All types</option>
            {(Object.keys(TYPE_LABEL) as EntryType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink/80">
          <b className="text-ink">{rows?.length ?? 0}</b> entries
          {oneItem && (
            <> · <span className="text-in">IN {qty(round3(totals.in))}</span> · <span className="text-out">OUT {qty(round3(totals.out))}</span> {oneItem.unit}</>
          )}
          {scope === "ALL" ? " · balance shown across all godowns" : ` · balance shown for ${scopeName}`}
        </p>
        <ExportBar disabled={!rows?.length} onCsv={() => rows && downloadCsv(`stock-ledger-${todayISO()}.csv`, ledgerCsv(rows, scope))} />
      </div>
      {error ? <Empty>{error}</Empty> : rows === null ? <Empty>Loading…</Empty> : <LedgerTable rows={rows} scope={scope} />}
    </div>
  );
}

// ---------------- Reports ----------------

type ReportKind = "summary" | "low" | "itemLedger";

export function ReportsView(props: ViewProps) {
  const { items, godowns, scope, scopeName } = props;
  const [kind, setKind] = useState<ReportKind>("summary");
  const [cat, setCat] = useState("");
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const cats = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(), [items]);
  const scoped = items.filter((i) => !cat || i.category === cat);
  const cols = scope === "ALL" ? godowns : godowns.filter((g) => g.id === scope);

  const tabs: [ReportKind, string][] = [["summary", "Stock Summary"], ["low", "Low Stock"], ["itemLedger", "Item-wise Ledger"]];

  return (
    <div className="space-y-4">
      <Tabs tabs={tabs} value={kind} onChange={setKind} label="Report" />

      {kind === "itemLedger" ? (
        items.length === 0 ? <Empty>No items yet.</Empty> : <LedgerView {...props} itemId={itemId} setItemId={setItemId} />
      ) : (
        <>
          <PrintHeader title={kind === "summary" ? "Stock Summary" : "Low Stock Report"} scopeName={scopeName} />
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="print:hidden">
              <Field label="Category">
                <Select value={cat} onChange={(e) => setCat(e.target.value)}>
                  <option value="">All categories</option>
                  {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
            </div>
            <ExportBar
              onCsv={() =>
                downloadCsv(
                  `${kind === "summary" ? "stock-summary" : "low-stock"}-${todayISO()}.csv`,
                  kind === "summary" ? summaryCsv(scoped, cols, scope) : lowCsv(scoped.filter((i) => isLowStock(i, scope)), scope),
                )
              }
            />
          </div>
          {kind === "summary" ? <SummaryTable items={scoped} cols={cols} scope={scope} /> : <LowTable items={scoped.filter((i) => isLowStock(i, scope))} scope={scope} />}
        </>
      )}
    </div>
  );
}

function summaryCsv(items: Item[], cols: Godown[], scope: Scope): string {
  return toCsv([
    ["SKU", "Item", "Category", "Unit", ...cols.map((g) => g.name), ...(scope === "ALL" ? ["Total"] : []), "Purchase price", "Sale price", "Stock value", "Status"],
    ...items.map((i) => [
      i.sku, i.name, i.category, i.unit,
      ...cols.map((g) => i.stock[g.id] ?? 0),
      ...(scope === "ALL" ? [itemTotal(i)] : []),
      i.purchasePrice, i.salePrice,
      Math.round(qtyInScope(i, scope) * i.purchasePrice * 100) / 100,
      isLowStock(i, scope) ? "LOW" : "OK",
    ]),
    ["", "TOTAL", "", "", ...cols.map(() => ""), ...(scope === "ALL" ? [""] : []), "", "", stockValue(items, scope), ""],
  ]);
}

function SummaryTable({ items, cols, scope }: { items: Item[]; cols: Godown[]; scope: Scope }) {
  if (items.length === 0) return <Empty>No items.</Empty>;
  return (
    <div className="table-3d">
      <table className="w-full min-w-[640px] text-sm print:min-w-0 print:text-xs">
        <thead className="text-left text-xs uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2">Item</th>
            {cols.map((g) => <th key={g.id} className="px-3 py-2 text-right">{g.name}</th>)}
            {scope === "ALL" && <th className="px-3 py-2 text-right">Total</th>}
            <th className="px-3 py-2 text-right">Buy rate</th>
            <th className="px-3 py-2 text-right">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/[0.07]">
          {items.map((i) => {
            const low = isLowStock(i, scope);
            return (
              <tr key={i.id}>
                <td className="px-3 py-2">
                  <div className="font-semibold">{i.name} {low && <Badge tone="low">LOW</Badge>}</div>
                  <div className="text-xs text-ink/60">{i.sku}{i.category ? ` · ${i.category}` : ""} · {i.unit}</div>
                </td>
                {cols.map((g) => <td key={g.id} className="px-3 py-2 text-right tabular-nums">{qty(i.stock[g.id] ?? 0)}</td>)}
                {scope === "ALL" && <td className={`px-3 py-2 text-right font-bold tabular-nums ${low ? "text-low" : ""}`}>{qty(itemTotal(i))}</td>}
                <td className="px-3 py-2 text-right tabular-nums">{money(i.purchasePrice)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(qtyInScope(i, scope) * i.purchasePrice)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t-2 border-ink/60 font-bold">
          <tr>
            <td className="px-3 py-2" colSpan={cols.length + (scope === "ALL" ? 3 : 2)}>Total stock value</td>
            <td className="px-3 py-2 text-right tabular-nums">{money(stockValue(items, scope))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function lowCsv(items: Item[], scope: Scope): string {
  return toCsv([
    ["SKU", "Item", "Category", "Unit", "In stock", "Minimum", "Shortfall"],
    ...items.map((i) => [i.sku, i.name, i.category, i.unit, qtyInScope(i, scope), i.minStockAlert, round3(i.minStockAlert - qtyInScope(i, scope))]),
  ]);
}

function LowTable({ items, scope }: { items: Item[]; scope: Scope }) {
  if (items.length === 0) return <Empty>Nothing is below its minimum stock level.</Empty>;
  return (
    <div className="table-3d table-3d-low">
      <table className="w-full min-w-[520px] text-sm print:min-w-0">
        <thead className="text-left text-xs uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2 text-right">In stock</th>
            <th className="px-3 py-2 text-right">Minimum</th>
            <th className="px-3 py-2 text-right">Shortfall</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/[0.07]">
          {items.map((i) => (
            <tr key={i.id}>
              <td className="px-3 py-2"><div className="font-semibold">{i.name}</div><div className="text-xs text-ink/60">{i.sku}</div></td>
              <td className="px-3 py-2 text-right font-bold tabular-nums text-low">{qty(qtyInScope(i, scope))} {i.unit}</td>
              <td className="px-3 py-2 text-right tabular-nums">{qty(i.minStockAlert)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-out">{qty(Math.max(0, round3(i.minStockAlert - qtyInScope(i, scope))))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- Godowns ----------------

export function GodownsView({
  items, godowns, limitText, onAdd, onRename, onDelete,
}: Pick<ViewProps, "items" | "godowns"> & {
  limitText: string | null;
  onAdd: (name: string) => Promise<boolean>;
  onRename: (g: Godown) => void;
  onDelete: (g: Godown) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="space-y-4">
      <form
        className="card-3d flex flex-wrap items-center gap-2 p-2.5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onAdd(name)) setName("");
        }}
      >
        <Input className="min-w-0 flex-1 @lg:max-w-xs" placeholder="New godown / store name, e.g. Godown B" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" disabled={!name.trim()}>+ Add godown</Button>
      </form>
      {limitText && <p className="text-sm text-ink/70">{limitText}</p>}
      <div className="grid gap-4 @xl:grid-cols-2 @5xl:grid-cols-3">
        {godowns.map((g) => {
          const value = stockValue(items, g.id);
          const skus = items.filter((i) => (i.stock[g.id] ?? 0) > 0).length;
          return (
            <article key={g.id} className="card-3d tilt p-4">
              <div className="flex items-center gap-3">
                <Crate />
                <div className="min-w-0">
                  <h3 className="truncate font-bold">{g.name}</h3>
                  <p className="text-sm text-ink/70">{skus} items in stock · {money(value)}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-1.5">
                <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => onRename(g)}>Rename</Button>
                <Button variant="danger" className="px-2.5 py-1.5 text-xs" onClick={() => onDelete(g)}>Delete</Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

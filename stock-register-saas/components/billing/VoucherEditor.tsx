"use client";

import { useMemo, useState, type FormEvent } from "react";
import { todayISO } from "@/lib/engine";
import { calcTotals, GST_RATES, INDIAN_STATES, isInterState, isPurchaseSide, KIND_LABEL, stockEffect, type VoucherKind } from "@/lib/gst";
import type { Item, Scope, Workspace } from "@/lib/types";
import type { VoucherDTO } from "@/lib/voucher-service";
import { Button, Field, Input, Modal, Select, money, qty as fmtQty } from "../ui";
import { api, quickAddParty, useProfile, type PartyLite } from "./api";

interface Row {
  key: number;
  itemId: string;
  qty: string;
  rate: string;
  discountPct: string;
  taxRate: string;
}

let rowKey = 0;

export default function VoucherEditor({
  kind,
  ws,
  scope,
  parties,
  onPartyAdded,
  onClose,
  onSaved,
}: {
  kind: VoucherKind;
  ws: Workspace;
  scope: Scope;
  parties: PartyLite[];
  onPartyAdded: () => void;
  onClose: () => void;
  onSaved: (v: VoucherDTO) => void;
}) {
  const profile = useProfile();
  const purchaseSide = isPurchaseSide(kind);
  const effect = stockEffect(kind);
  const items = ws.items;
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const [date, setDate] = useState(todayISO());
  const [godownId, setGodownId] = useState(scope !== "ALL" && ws.godowns.some((g) => g.id === scope) ? scope : ws.godowns[0]?.id ?? "");
  const [partyId, setPartyId] = useState("");
  const [partySearch, setPartySearch] = useState("");
  const [extraParties, setExtraParties] = useState<PartyLite[]>([]);
  const [adding, setAdding] = useState(false);
  const [newParty, setNewParty] = useState({ name: "", phone: "", state: "" });
  const [gstEnabled, setGstEnabled] = useState(true);
  const [pos, setPos] = useState("");
  const [notes, setNotes] = useState("");
  const [paidNow, setPaidNow] = useState("");
  const [mode, setMode] = useState<"CASH" | "BANK" | "UPI" | "CHEQUE">("CASH");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allParties = useMemo(() => {
    const seen = new Set<string>();
    return [...extraParties, ...parties].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }, [parties, extraParties]);
  const wanted = purchaseSide ? ["SUPPLIER", "BOTH"] : ["CUSTOMER", "BOTH"];
  const needle = partySearch.trim().toLowerCase();
  const partyOptions = allParties
    .filter((p) => wanted.includes(p.type) || p.id === partyId)
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.phone.includes(needle));
  const party = allParties.find((p) => p.id === partyId);

  const placeOfSupply = pos || party?.state || profile?.state || "";
  const interState = gstEnabled && isInterState(profile?.state, placeOfSupply);

  const defaultRate = (it: Item) => (purchaseSide ? it.purchasePrice : it.salePrice);
  const addRow = (itemId = "") => {
    const it = itemById.get(itemId);
    setRows((r) => [
      ...r,
      { key: ++rowKey, itemId, qty: "1", rate: it ? String(defaultRate(it)) : "", discountPct: "", taxRate: it ? String(it.gstRate) : "0" },
    ]);
  };
  const setRow = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const pickItem = (key: number, itemId: string) => {
    const it = itemById.get(itemId);
    setRow(key, { itemId, rate: it ? String(defaultRate(it)) : "", taxRate: it ? String(it.gstRate) : "0" });
  };

  const valid = rows.filter((r) => r.itemId && Number(r.qty) > 0);
  const totals = calcTotals(
    valid.map((r) => ({ qty: Number(r.qty), rate: Number(r.rate || 0), discountPct: Number(r.discountPct || 0), taxRate: Number(r.taxRate || 0) })),
    { gstEnabled, interState },
  );

  const canPayNow = kind === "SALE" || kind === "PURCHASE";
  const needsParty = purchaseSide || kind === "SALE_RETURN";

  async function addParty() {
    setError(null);
    try {
      const p = await quickAddParty({ name: newParty.name.trim(), phone: newParty.phone.trim(), state: newParty.state, type: purchaseSide ? "SUPPLIER" : "CUSTOMER" });
      setExtraParties((x) => [p, ...x]);
      setPartyId(p.id);
      setAdding(false);
      setNewParty({ name: "", phone: "", state: "" });
      onPartyAdded();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (valid.length === 0) return setError("Add at least one item with a quantity");
    if (needsParty && !partyId) return setError(purchaseSide ? "Choose the supplier" : "Choose the customer");
    setBusy(true);
    try {
      const v = await api<VoucherDTO>("POST", "/api/vouchers", {
        kind,
        date,
        partyId: partyId || null,
        godownId,
        gstEnabled,
        placeOfSupply: pos,
        notes,
        paidNow: canPayNow && partyId ? Number(paidNow || 0) : 0,
        paymentMode: mode,
        lines: valid.map((r) => ({
          itemId: r.itemId,
          description: "",
          qty: Number(r.qty),
          rate: Number(r.rate || 0),
          discountPct: Number(r.discountPct || 0),
          taxRate: gstEnabled ? Number(r.taxRate || 0) : 0,
        })),
      });
      onSaved(v);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`New ${KIND_LABEL[kind].toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Godown" hint={effect ? `Stock ${effect === "OUT" ? "leaves" : "enters"} this godown` : "No stock moves for this document"}>
            <Select value={godownId} onChange={(e) => setGodownId(e.target.value)}>
              {ws.godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
        </div>

        {/* Party */}
        <div className="well space-y-2 rounded-xl p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-ink/70">{purchaseSide ? "Supplier" : "Customer"}</span>
            <button type="button" className="text-xs font-semibold underline" onClick={() => setAdding((a) => !a)}>
              {adding ? "Cancel" : "+ New party"}
            </button>
          </div>
          {adding ? (
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Name" value={newParty.name} onChange={(e) => setNewParty({ ...newParty, name: e.target.value })} className="col-span-2" />
              <Input placeholder="Phone" inputMode="tel" value={newParty.phone} onChange={(e) => setNewParty({ ...newParty, phone: e.target.value })} />
              <Select value={newParty.state} onChange={(e) => setNewParty({ ...newParty, state: e.target.value })} aria-label="State">
                <option value="">State</option>
                {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
              <Button type="button" variant="ghost" className="col-span-2" disabled={!newParty.name.trim()} onClick={addParty}>Save party</Button>
            </div>
          ) : (
            <>
              {allParties.length > 8 && <Input placeholder="Search name or phone" value={partySearch} onChange={(e) => setPartySearch(e.target.value)} />}
              <Select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Party">
                <option value="">{needsParty ? "— Choose —" : "Cash / walk-in (no party)"}</option>
                {partyOptions.map((p) => <option key={p.id} value={p.id}>{p.name}{p.phone ? ` · ${p.phone}` : ""}</option>)}
              </Select>
              {party?.gstin && <p className="text-xs text-ink/60">GSTIN {party.gstin}</p>}
            </>
          )}
        </div>

        {/* Lines */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-ink/70">Items</span>
            <label className="flex items-center gap-2 text-xs font-semibold">
              <input type="checkbox" checked={gstEnabled} onChange={(e) => setGstEnabled(e.target.checked)} className="h-4 w-4 accent-[var(--color-in)]" />
              GST bill
            </label>
          </div>
          {rows.length === 0 && <p className="text-sm text-ink/60">No items yet.</p>}
          {rows.map((r, idx) => {
            const it = itemById.get(r.itemId);
            const avail = it ? it.stock[godownId] ?? 0 : 0;
            const short = effect === "OUT" && it && Number(r.qty) > avail;
            const line = calcTotals([{ qty: Number(r.qty) || 0, rate: Number(r.rate || 0), discountPct: Number(r.discountPct || 0), taxRate: Number(r.taxRate || 0) }], { gstEnabled, interState, roundOff: false });
            return (
              <div key={r.key} className="card-3d space-y-2 p-3">
                <div className="flex gap-2">
                  <Select value={r.itemId} onChange={(e) => pickItem(r.key, e.target.value)} aria-label={`Item ${idx + 1}`} className="min-w-0 flex-1">
                    <option value="">Choose item…</option>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
                  </Select>
                  <button type="button" aria-label="Remove item" className="rounded-lg px-2 text-xl text-out hover:bg-out/10" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>×</button>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <Field label={`Qty${it ? ` (${it.unit})` : ""}`}>
                    <Input type="number" min="0" step="any" inputMode="decimal" value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} />
                  </Field>
                  <Field label="Rate ₹">
                    <Input type="number" min="0" step="any" inputMode="decimal" value={r.rate} onChange={(e) => setRow(r.key, { rate: e.target.value })} />
                  </Field>
                  <Field label="Disc %">
                    <Input type="number" min="0" max="100" step="any" inputMode="decimal" value={r.discountPct} onChange={(e) => setRow(r.key, { discountPct: e.target.value })} placeholder="0" />
                  </Field>
                  <Field label="GST %">
                    <Select value={r.taxRate} onChange={(e) => setRow(r.key, { taxRate: e.target.value })} disabled={!gstEnabled}>
                      {[...new Set([...GST_RATES, Number(r.taxRate || 0)])].sort((a, b) => a - b).map((g) => <option key={g} value={String(g)}>{g}%</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="flex justify-between text-xs">
                  <span className={short ? "font-bold text-out" : "text-ink/60"}>
                    {it ? `${short ? "Only " : "In stock: "}${fmtQty(avail)} ${it.unit}${it.hsn ? ` · HSN ${it.hsn}` : ""}` : ""}
                  </span>
                  <span className="font-semibold tabular-nums">{money(line.total)}</span>
                </div>
              </div>
            );
          })}
          <Button type="button" variant="ghost" className="w-full" onClick={() => addRow()} disabled={items.length === 0}>
            {items.length === 0 ? "Add items in the Items tab first" : "+ Add item"}
          </Button>
        </div>

        {gstEnabled && (
          <Field label="Place of supply" hint={interState ? "Different state: IGST applies" : "Same state: CGST + SGST"}>
            <Select value={pos} onChange={(e) => setPos(e.target.value)}>
              <option value="">{placeOfSupply ? `Default (${placeOfSupply})` : "Not set"}</option>
              {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
        )}

        {/* Totals */}
        <dl className="card-3d space-y-1 p-3 text-sm tabular-nums">
          <Row label="Taxable value" value={money(totals.subtotal)} />
          {totals.discount > 0 && <Row label="Discount given" value={`− ${money(totals.discount)}`} />}
          {gstEnabled && (interState ? <Row label="IGST" value={money(totals.igst)} /> : <><Row label="CGST" value={money(totals.cgst)} /><Row label="SGST" value={money(totals.sgst)} /></>)}
          {totals.roundOff !== 0 && <Row label="Round off" value={money(totals.roundOff)} />}
          <div className="flex justify-between border-t-2 border-ink/10 pt-1.5 text-base font-bold">
            <dt>Total</dt>
            <dd>{money(totals.total)}</dd>
          </div>
        </dl>

        {canPayNow && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={kind === "SALE" ? "Received now ₹" : "Paid now ₹"} hint={partyId ? "Rest stays as balance due" : "Choose a party to record part payment"}>
              <Input type="number" min="0" step="any" inputMode="decimal" value={paidNow} disabled={!partyId} onChange={(e) => setPaidNow(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Mode">
              <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} disabled={!partyId}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="BANK">Bank</option>
                <option value="CHEQUE">Cheque</option>
              </Select>
            </Field>
            {partyId && <button type="button" className="col-span-2 -mt-1 text-left text-xs font-semibold underline" onClick={() => setPaidNow(String(totals.total))}>Mark fully paid ({money(totals.total)})</button>}
          </div>
        )}

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Vehicle no., delivery terms, reference" />
        </Field>

        {error && <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}
        <Button type="submit" variant={effect === "IN" ? "in" : effect === "OUT" ? "out" : "primary"} disabled={busy} className="w-full py-3">
          {busy ? "Saving…" : `Save ${KIND_LABEL[kind].toLowerCase()} · ${money(totals.total)}`}
        </Button>
      </form>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink/70">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

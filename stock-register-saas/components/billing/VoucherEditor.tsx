"use client";

import { useMemo, useState, type FormEvent } from "react";
import { todayISO } from "@/lib/engine";
import {
  calcTotals,
  GST_RATES,
  INDIAN_STATES,
  isInterState,
  isPurchaseSide,
  KIND_LABEL,
  lineDiscount,
  paymentError,
  r2,
  stockEffect,
  type LineInput,
  type VoucherKind,
} from "@/lib/gst";
import type { Item, Scope, Workspace } from "@/lib/types";
import type { VoucherDTO } from "@/lib/voucher-service";
import { Button, Field, Input, Modal, Select, money, qty as fmtQty } from "../ui";
import { api, quickAddParty, useProfile, type PartyLite } from "./api";
import PartyPicker from "./PartyPicker";
import PaymentsPanel, { payRowsFrom, toPayments, type PayRow } from "./PaymentsPanel";

interface Row {
  key: number;
  itemId: string;
  qty: string;
  rate: string;
  discountPct: string;
  discountAmt: string;
  /** Which discount box the user typed in last; the other one is worked out from it. */
  discSource: "pct" | "amt";
  taxRate: string;
}

let rowKey = 0;

const num = (s: string) => Number(s || 0);
/** Show a number in an input without float noise or trailing zeros. */
const show = (n: number, dp: number) => (n ? String(Number(n.toFixed(dp))) : "");

/** The row's discount as the API / GST maths want it (₹ when typed as ₹, else %). */
function rowLine(r: Row): LineInput {
  return {
    qty: num(r.qty),
    rate: num(r.rate),
    discountPct: r.discSource === "pct" ? num(r.discountPct) : 0,
    discountAmt: r.discSource === "amt" ? num(r.discountAmt) : 0,
    taxRate: num(r.taxRate),
  };
}

/** Keep the other discount box in step with the one the user typed in. */
function syncDiscount(r: Row): Row {
  const qty = num(r.qty);
  const rate = num(r.rate);
  if (r.discSource === "amt") {
    const d = lineDiscount(qty, rate, 0, num(r.discountAmt));
    return { ...r, discountPct: r.discountAmt ? show(d.pct, 4) : "" };
  }
  const d = lineDiscount(qty, rate, num(r.discountPct), 0);
  return { ...r, discountAmt: r.discountPct ? show(d.amount, 2) : "" };
}

export default function VoucherEditor({
  kind,
  ws,
  scope,
  parties,
  onPartyAdded,
  onClose,
  onSaved,
  editing,
}: {
  kind: VoucherKind;
  ws: Workspace;
  scope: Scope;
  parties: PartyLite[];
  onPartyAdded: () => void;
  onClose: () => void;
  onSaved: (v: VoucherDTO) => void;
  /** Edit mode (owner only): the saved bill, with its lines. Saves with PATCH and keeps the same number. */
  editing?: VoucherDTO;
}) {
  const profile = useProfile();
  const purchaseSide = isPurchaseSide(kind);
  const effect = stockEffect(kind);
  const items = ws.items;
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const isSale = kind === "SALE";

  const [date, setDate] = useState(editing?.date ?? todayISO());
  const [godownId, setGodownId] = useState(
    editing?.godownId ?? (scope !== "ALL" && ws.godowns.some((g) => g.id === scope) ? scope : ws.godowns[0]?.id ?? ""),
  );
  const [partyId, setPartyId] = useState(editing?.partyId ?? "");
  const [extraParties, setExtraParties] = useState<PartyLite[]>([]);
  const [adding, setAdding] = useState(false);
  const [newParty, setNewParty] = useState({ name: "", phone: "", state: "" });
  const [gstEnabled, setGstEnabled] = useState(editing?.gstEnabled ?? true);
  const [pos, setPos] = useState(editing && editing.placeOfSupply !== editing.partyState ? editing.placeOfSupply : "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  // Purchase bills: single "paid now" to the supplier.
  const [paidNow, setPaidNow] = useState("");
  const [mode, setMode] = useState<"CASH" | "BANK" | "UPI" | "CHEQUE">("CASH");
  // Sales invoices: split payment at the counter (incl. FINANCE).
  const [payRows, setPayRows] = useState<PayRow[]>(() => (editing ? payRowsFrom(editing.payments) : []));
  /** Payments recorded later from the Parties screen; editing the bill doesn't touch them. */
  const laterPaid = editing && editing.partyId ? Math.max(0, r2(editing.paid - editing.paidAtBilling)) : 0;
  const [rows, setRows] = useState<Row[]>(() =>
    (editing?.lines ?? []).map((l) => {
      // Re-open a ₹ discount as ₹ when its % isn't a round number.
      const amtSource = l.discountAmt > 0 && Math.abs(l.discountPct * 100 - Math.round(l.discountPct * 100)) > 1e-6;
      return {
        key: ++rowKey,
        itemId: l.itemId,
        qty: String(l.qty),
        rate: String(l.rate),
        discountPct: l.discountPct ? show(l.discountPct, 4) : "",
        discountAmt: l.discountAmt ? show(l.discountAmt, 2) : "",
        discSource: amtSource ? "amt" : "pct",
        taxRate: String(l.taxRate),
      };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allParties = useMemo(() => {
    const seen = new Set<string>();
    return [...extraParties, ...parties].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }, [parties, extraParties]);
  const wanted = purchaseSide ? ["SUPPLIER", "BOTH"] : ["CUSTOMER", "BOTH"];
  const party = allParties.find((p) => p.id === partyId);

  const placeOfSupply = pos || party?.state || profile?.state || "";
  const interState = gstEnabled && isInterState(profile?.state, placeOfSupply);

  const defaultRate = (it: Item) => (purchaseSide ? it.purchasePrice : it.salePrice);
  const addRow = (itemId = "") => {
    const it = itemById.get(itemId);
    setRows((r) => [
      ...r,
      { key: ++rowKey, itemId, qty: "1", rate: it ? String(defaultRate(it)) : "", discountPct: "", discountAmt: "", discSource: "pct", taxRate: it ? String(it.gstRate) : "0" },
    ]);
  };
  /** Update a row; when qty / rate / a discount box changes, refresh the other discount box. */
  const setRow = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? syncDiscount({ ...x, ...patch }) : x)));
  const pickItem = (key: number, itemId: string) => {
    const it = itemById.get(itemId);
    setRow(key, { itemId, rate: it ? String(defaultRate(it)) : "", taxRate: it ? String(it.gstRate) : "0" });
  };

  const valid = rows.filter((r) => r.itemId && num(r.qty) > 0);
  const totals = calcTotals(valid.map(rowLine), { gstEnabled, interState });

  const canPayNowPurchase = !editing && kind === "PURCHASE";
  const needsParty = purchaseSide || kind === "SALE_RETURN";
  const roleLabel = purchaseSide ? "supplier" : "customer";

  async function quickAdd(p: { name: string; phone: string }): Promise<PartyLite> {
    const added = await quickAddParty({ name: p.name, phone: p.phone, state: profile?.state ?? "", type: purchaseSide ? "SUPPLIER" : "CUSTOMER" });
    setExtraParties((x) => [added, ...x]);
    onPartyAdded();
    return added;
  }

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
    for (const r of valid) {
      const gross = r2(num(r.qty) * num(r.rate));
      if (r.discSource === "amt" && num(r.discountAmt) > gross + 0.005)
        return setError(`Discount on ${itemById.get(r.itemId)?.name ?? "an item"} (${money(num(r.discountAmt))}) is more than the line value (${money(gross)})`);
    }
    const payments = isSale ? toPayments(payRows) : [];
    if (isSale) {
      const err = paymentError(payments, { total: totals.total, hasParty: !!partyId, otherPaid: laterPaid });
      if (err) return setError(err);
    }
    setBusy(true);
    try {
      const lines = valid.map((r) => {
        const l = rowLine(r);
        return {
          itemId: r.itemId,
          description: "",
          qty: l.qty,
          rate: l.rate,
          discountPct: l.discountPct ?? 0,
          discountAmt: l.discountAmt ?? 0,
          taxRate: gstEnabled ? l.taxRate ?? 0 : 0,
        };
      });
      if (editing) {
        const v = await api<VoucherDTO>("PATCH", `/api/vouchers/${editing.id}`, {
          date,
          partyId: partyId || null,
          godownId,
          gstEnabled,
          placeOfSupply: pos,
          notes,
          lines,
          ...(isSale ? { payments } : {}),
        });
        onSaved(v);
        return;
      }
      const v = await api<VoucherDTO>("POST", "/api/vouchers", {
        kind,
        date,
        partyId: partyId || null,
        godownId,
        gstEnabled,
        placeOfSupply: pos,
        notes,
        payments,
        paidNow: canPayNowPurchase && partyId ? num(paidNow) : 0,
        paymentMode: mode,
        lines,
      });
      onSaved(v);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Edit ${KIND_LABEL[kind].toLowerCase()} ${editing.number}` : `New ${KIND_LABEL[kind].toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {editing && (
          <p className="rounded-xl border-2 border-low/40 bg-low/10 px-3 py-2 text-xs font-medium text-ink/80">
            Owner edit. Saving puts back the stock this bill took out and takes out the new quantities, recalculates GST and keeps
            number <b>{editing.number}</b>. The change is recorded as edited by you.
          </p>
        )}
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

        {/* Party: search by name or phone; unknown mobile number → add the customer */}
        <div className="well space-y-2 rounded-xl p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-ink/70">{purchaseSide ? "Supplier" : "Customer / dealer"}</span>
            <button type="button" className="text-xs font-semibold underline" onClick={() => setAdding((a) => !a)}>
              {adding ? "Cancel" : "+ New party with details"}
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
              <PartyPicker
                parties={allParties}
                wantedTypes={wanted}
                value={partyId}
                onChange={setPartyId}
                walkInLabel={needsParty ? undefined : "Walk-in / cash sale (no party)"}
                roleLabel={roleLabel}
                onQuickAdd={quickAdd}
              />
              {party ? (
                <p className="text-xs text-ink/60">
                  {[party.phone && `Ph ${party.phone}`, party.gstin && `GSTIN ${party.gstin}`, party.state].filter(Boolean).join(" · ") || "Selected"}
                </p>
              ) : (
                !needsParty && <p className="text-xs text-ink/60">Walk-in / cash sale. Type a name or mobile number to bill a customer.</p>
              )}
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
            const short = effect === "OUT" && it && num(r.qty) > avail;
            const line = calcTotals([rowLine(r)], { gstEnabled, interState, roundOff: false });
            return (
              <div key={r.key} className="card-3d space-y-2 p-3">
                <div className="flex gap-2">
                  <Select value={r.itemId} onChange={(e) => pickItem(r.key, e.target.value)} aria-label={`Item ${idx + 1}`} className="min-w-0 flex-1">
                    <option value="">Choose item…</option>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
                  </Select>
                  <button type="button" aria-label="Remove item" className="rounded-lg px-2 text-xl text-out hover:bg-out/10" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>×</button>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <Field label={`Qty${it ? ` (${it.unit})` : ""}`}>
                    <Input type="number" min="0" step="any" inputMode="decimal" value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} />
                  </Field>
                  <Field label="Rate ₹">
                    <Input type="number" min="0" step="any" inputMode="decimal" value={r.rate} onChange={(e) => setRow(r.key, { rate: e.target.value })} />
                  </Field>
                  <Field label="Disc %">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="any"
                      inputMode="decimal"
                      value={r.discountPct}
                      onChange={(e) => setRow(r.key, { discountPct: e.target.value, discSource: "pct" })}
                      placeholder="0"
                      aria-label={`Discount percent, item ${idx + 1}`}
                    />
                  </Field>
                  <Field label="Disc ₹">
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={r.discountAmt}
                      onChange={(e) => setRow(r.key, { discountAmt: e.target.value, discSource: "amt" })}
                      placeholder="0"
                      aria-label={`Discount in rupees, item ${idx + 1}`}
                    />
                  </Field>
                  <Field label="GST %">
                    <Select value={r.taxRate} onChange={(e) => setRow(r.key, { taxRate: e.target.value })} disabled={!gstEnabled}>
                      {[...new Set([...GST_RATES, num(r.taxRate)])].sort((a, b) => a - b).map((g) => <option key={g} value={String(g)}>{g}%</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="flex justify-between gap-2 text-xs">
                  <span className={short ? "font-bold text-out" : "text-ink/60"}>
                    {it ? `${short ? "Only " : "In stock: "}${fmtQty(avail)} ${it.unit}${it.hsn ? ` · HSN ${it.hsn}` : ""}` : ""}
                  </span>
                  <span className="text-right tabular-nums">
                    {line.discount > 0 && <span className="mr-2 text-in">−{money(line.discount)}</span>}
                    <b>{money(line.total)}</b>
                  </span>
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
          <SumRow label="Taxable value" value={money(totals.subtotal)} />
          {totals.discount > 0 && <SumRow label="Discount given" value={`− ${money(totals.discount)}`} />}
          {gstEnabled && (interState ? <SumRow label="IGST" value={money(totals.igst)} /> : <><SumRow label="CGST" value={money(totals.cgst)} /><SumRow label="SGST" value={money(totals.sgst)} /></>)}
          {totals.roundOff !== 0 && <SumRow label="Round off" value={money(totals.roundOff)} />}
          <div className="flex justify-between border-t-2 border-ink/10 pt-1.5 text-base font-bold">
            <dt>Total</dt>
            <dd>{money(totals.total)}</dd>
          </div>
        </dl>

        {isSale && <PaymentsPanel rows={payRows} setRows={setPayRows} total={totals.total} hasParty={!!partyId} laterPaid={laterPaid} />}

        {canPayNowPurchase && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Paid now ₹" hint={partyId ? "Rest stays as balance due" : "Choose a supplier to record part payment"}>
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
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Vehicle no., delivery terms, IMEI / serial no." />
        </Field>

        {error && <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}
        <Button type="submit" variant={effect === "IN" ? "in" : effect === "OUT" ? "out" : "primary"} disabled={busy} className="w-full py-3">
          {busy ? "Saving…" : editing ? `Save changes · ${money(totals.total)}` : `Save ${KIND_LABEL[kind].toLowerCase()} · ${money(totals.total)}`}
        </Button>
      </form>
    </Modal>
  );
}

function SumRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink/70">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

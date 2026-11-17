"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { round3, todayISO } from "@/lib/engine";
import { api } from "../staff/api";
import { Badge, Button, Card, Empty, Field, Input, SectionHeader, Select, qty } from "../ui";
import type { SectionProps } from "./types";

interface AdjustmentRow {
  id: string;
  date: string;
  itemName: string;
  unit: string;
  godownName: string;
  delta: number;
  balance: number;
  reason: string;
  actorName: string;
}

const REASONS = ["Physical count correction", "Damaged", "Expired", "Lost / theft", "Free sample", "Found extra stock"];

export default function AdjustmentsSection({ ws, scope, refresh, notify, version }: SectionProps) {
  const { items, godowns } = ws;
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [godownId, setGodownId] = useState(scope !== "ALL" ? scope : godowns[0]?.id ?? "");
  const [mode, setMode] = useState<"count" | "delta">("count");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<AdjustmentRow[] | null>(null);

  const load = useCallback(() => {
    api<AdjustmentRow[]>("GET", "/api/adjustments").then(setRows).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load, version]);

  const item = items.find((i) => i.id === itemId);
  const current = item ? item.stock[godownId] ?? 0 : 0;
  const n = value === "" ? null : Number(value);
  const delta = n === null || Number.isNaN(n) ? null : round3(mode === "count" ? n - current : n);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (delta === null) return;
    setBusy(true);
    setError(null);
    const fullReason = note.trim() ? `${reason}: ${note.trim()}` : reason;
    try {
      await api("POST", "/api/adjustments", {
        itemId, godownId, date, reason: fullReason,
        ...(mode === "count" ? { newQty: n } : { delta: n }),
      });
      notify(`Stock adjusted by ${delta > 0 ? "+" : ""}${qty(delta)} ${item?.unit ?? ""}`);
      setValue("");
      setNote("");
      await refresh();
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) return <Empty>Add items first, then you can adjust their stock.</Empty>;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_1fr]">
      <div>
        <SectionHeader title="Stock adjustment" subtitle="Fix stock after a physical count, damage or expiry. Every adjustment is kept in the ledger with its reason." />
        <Card className="p-4">
          <form onSubmit={submit} className="space-y-3">
            <Field label="Item">
              <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Godown">
                <Select value={godownId} onChange={(e) => setGodownId(e.target.value)}>
                  {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              </Field>
              <Field label="Date">
                <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>
            <div className="rounded-lg bg-muted px-3 py-2 text-sm">
              In books now: <b className="tabular-nums">{qty(current)} {item?.unit}</b>
            </div>
            <div className="flex gap-2 text-sm" role="radiogroup" aria-label="Adjustment type">
              {([["count", "Enter physical count"], ["delta", "Enter + / − change"]] as const).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={mode === k}
                  onClick={() => { setMode(k); setValue(""); }}
                  className={`flex-1 rounded-lg border-2 px-2 py-1.5 font-semibold ${mode === k ? "border-ink bg-ink text-paper" : "border-ink/20"}`}
                >
                  {l}
                </button>
              ))}
            </div>
            <Field
              label={mode === "count" ? `Counted quantity (${item?.unit ?? ""})` : `Change (${item?.unit ?? ""}), e.g. -3 or 5`}
              hint={delta !== null ? `Will post ${delta > 0 ? "+" : ""}${qty(delta)} → new balance ${qty(round3(current + delta))}` : undefined}
            >
              <Input type="number" step="any" required inputMode="decimal" min={mode === "count" ? 0 : undefined} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field label="Reason">
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => <option key={r}>{r}</option>)}
              </Select>
            </Field>
            <Field label="Note (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Batch no., who counted, etc." />
            </Field>
            {error && <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}
            <Button type="submit" disabled={busy || delta === null || delta === 0} className="w-full">
              {busy ? "Saving…" : delta === 0 ? "No change" : "Post adjustment"}
            </Button>
          </form>
        </Card>
      </div>
      <div>
        <h3 className="mb-2 mt-1 font-bold">Recent adjustments</h3>
        {rows === null ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>No adjustments yet.</Empty>
        ) : (
          <Card className="divide-y divide-ink/10">
            {rows.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="font-semibold">{r.itemName}</div>
                  <div className="text-xs text-ink/60">{r.date} · {r.godownName}{r.actorName ? ` · ${r.actorName}` : ""}</div>
                  <div className="mt-0.5 text-xs text-ink/75">{r.reason}</div>
                </div>
                <div className="text-right">
                  <Badge tone={r.delta > 0 ? "in" : "out"}>{r.delta > 0 ? "+" : "−"}{qty(Math.abs(r.delta))} {r.unit}</Badge>
                  <div className="mt-1 text-xs tabular-nums text-ink/60">bal {qty(r.balance)}</div>
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

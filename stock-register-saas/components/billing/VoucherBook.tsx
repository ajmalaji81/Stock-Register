"use client";

import { useEffect, useMemo, useState } from "react";
import { CONVERSIONS, KIND_LABEL, PAYMENT_MODE_LABEL, paymentSummary, stockEffect, type VoucherKind } from "@/lib/gst";
import type { VoucherDTO } from "@/lib/voucher-service";
import type { SectionProps } from "../sections/types";
import { Badge, Button, Empty, Input, Modal, SectionHeader, Select, Tabs, money, qty } from "../ui";
import { api, useParties } from "./api";
import VoucherEditor from "./VoucherEditor";

export interface BookTab {
  kind: VoucherKind;
  label: string;
}

const STATUS_TONE = { OPEN: "in", CONVERTED: "ink", CLOSED: "ink", CANCELLED: "out" } as const;

function statusText(v: VoucherDTO): string {
  if (v.status === "CANCELLED") return "Cancelled";
  if (v.status === "CONVERTED") return "Converted";
  if (v.kind === "SALE" || v.kind === "PURCHASE") {
    if (!v.partyId) return v.paidAtBilling > 0 ? "Paid" : "Cash";
    return v.balanceDue <= 0.005 ? "Paid" : v.paid > 0 ? "Part paid" : "Unpaid";
  }
  return v.kind === "SALE_RETURN" || v.kind === "PURCHASE_RETURN" ? "Recorded" : "Open";
}

export function shareUrl(v: VoucherDTO): string | null {
  if (!v.shareToken || typeof window === "undefined") return null;
  return `${window.location.origin}/print/voucher/${v.id}?t=${v.shareToken}`;
}

export function whatsappLink(v: VoucherDTO, phone: string | undefined, businessName: string): string {
  const url = shareUrl(v);
  const text = [
    `${KIND_LABEL[v.kind]} ${v.number}${businessName ? ` from ${businessName}` : ""}`,
    `Date: ${v.date}`,
    `Amount: ${money(v.total)}`,
    v.kind === "SALE" && v.payments.length > 0 ? `Paid: ${paymentSummary(v.payments)}` : "",
    v.kind === "SALE" && v.balanceDue > 0.005 ? `Balance due: ${money(v.balanceDue)}` : "",
    url ? `View / download: ${url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const digits = (phone ?? "").replace(/\D/g, "");
  const to = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

/** A tabbed list of one family of vouchers (sales, purchases or documents) with create / view / actions. */
const when = (iso: string): string => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/** "Created by … · when" and, if edited, "Edited by … · when (n edits)". */
function AuditTrail({ v, compact = false }: { v: VoucherDTO; compact?: boolean }) {
  return (
    <div className={`space-y-0.5 text-xs ${compact ? "text-ink/55" : "text-ink/60"}`}>
      <div>
        <span aria-hidden>👤 </span>Created by <b className="font-semibold text-ink/80">{v.createdBy || "—"}</b> · {when(v.createdAt)}
      </div>
      {v.updatedAt && (
        <div className="text-low">
          <span aria-hidden>✎ </span>Edited by <b className="font-semibold">{v.updatedBy || "—"}</b> · {when(v.updatedAt)}
          {v.editCount > 1 ? ` (${v.editCount} edits)` : ""}
        </div>
      )}
    </div>
  );
}

export default function VoucherBook({ props, title, subtitle, tabs }: { props: SectionProps; title: string; subtitle: string; tabs: BookTab[] }) {
  const { ws, scope, version, refresh, notify, can } = props;
  const [kind, setKind] = useState<VoucherKind>(tabs[0].kind);
  const [rows, setRows] = useState<VoucherDTO[] | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<VoucherDTO | null>(null);
  const [editing, setEditing] = useState<VoucherDTO | null>(null);
  /** Only the owner (super admin) may edit saved bills; the server enforces it too. */
  const isOwner = ws.actor.isOwner;
  const [tick, setTick] = useState(0);
  const { parties, reload } = useParties(version);
  const [businessName, setBusinessName] = useState("");

  useEffect(() => {
    api<{ businessName: string }>("GET", "/api/settings").then((p) => setBusinessName(p.businessName)).catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ kind, ...(q ? { q } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
    setRows(null);
    const t = setTimeout(() => {
      api<VoucherDTO[]>("GET", `/api/vouchers?${qs}`)
        .then((r) => live && setRows(r))
        .catch((e: Error) => {
          if (live) {
            setRows([]);
            notify(e.message, true);
          }
        });
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, q, status, from, to, version, tick, notify]);

  const shown = useMemo(() => (scope === "ALL" || !rows ? rows : rows.filter((r) => r.godownId === scope)), [rows, scope]);
  const live = (shown ?? []).filter((r) => r.status !== "CANCELLED");
  const sum = live.reduce((a, r) => a + r.total, 0);
  const due = live.reduce((a, r) => a + r.balanceDue, 0);
  const profit = live.some((r) => r.profit !== null) ? live.reduce((a, r) => a + (r.profit ?? 0), 0) : null;
  const phoneOf = (v: VoucherDTO) => v.partyPhone || parties.find((p) => p.id === v.partyId)?.phone;

  async function cancel(v: VoucherDTO) {
    const moves = stockEffect(v.kind);
    if (!confirm(`Cancel ${KIND_LABEL[v.kind].toLowerCase()} ${v.number}?${moves ? " Its stock will be reversed." : ""} This can't be undone.`)) return;
    try {
      const updated = await api<VoucherDTO>("POST", `/api/vouchers/${v.id}/cancel`);
      notify(`${v.number} cancelled`);
      if (viewing?.id === v.id) setViewing(updated);
      setTick((t) => t + 1);
      if (moves) await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function convert(v: VoucherDTO, target: VoucherKind) {
    if (!confirm(`Create a ${KIND_LABEL[target].toLowerCase()} from ${v.number}?`)) return;
    try {
      const created = await api<VoucherDTO>("POST", `/api/vouchers/${v.id}/convert`, { to: target });
      notify(`${KIND_LABEL[target]} ${created.number} created`);
      setViewing(created);
      setTick((t) => t + 1);
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function open(v: VoucherDTO) {
    try {
      setViewing(await api<VoucherDTO>("GET", `/api/vouchers/${v.id}`));
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function edit(v: VoucherDTO) {
    try {
      const full = v.lines ? v : await api<VoucherDTO>("GET", `/api/vouchers/${v.id}`);
      setViewing(null);
      setEditing(full);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  const canCreate = ws.godowns.length > 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        title={title}
        subtitle={subtitle}
        actions={<Button variant={stockEffect(kind) === "IN" ? "in" : stockEffect(kind) === "OUT" ? "out" : "primary"} disabled={!canCreate} onClick={() => setCreating(true)}>+ New {KIND_LABEL[kind].toLowerCase()}</Button>}
      />
      {tabs.length > 1 && <Tabs tabs={tabs.map((t) => [t.kind, t.label] as [VoucherKind, string])} value={kind} onChange={(k) => setKind(k)} label={title} />}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Input className="col-span-2 sm:col-span-1" placeholder="Search no., party, notes" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="OPEN">Open / active</option>
          <option value="CONVERTED">Converted</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
        <Input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} className="col-span-2 sm:col-span-1" />
      </div>

      {shown && shown.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span><b className="tabular-nums">{live.length}</b> {live.length === 1 ? "entry" : "entries"}</span>
          <span>Total <b className="tabular-nums">{money(sum)}</b></span>
          {due > 0 && <span className="text-low">Due <b className="tabular-nums">{money(due)}</b></span>}
          {profit !== null && <span className={profit >= 0 ? "text-in" : "text-out"}>Profit <b className="tabular-nums">{money(profit)}</b></span>}
        </div>
      )}

      {shown === null ? (
        <Empty>Loading…</Empty>
      ) : shown.length === 0 ? (
        <Empty>No {KIND_LABEL[kind].toLowerCase()}s yet{q || status || from || to ? " for these filters" : ""}.</Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((v) => (
            <li key={v.id} className={`card-3d tilt p-4 ${v.status === "CANCELLED" ? "opacity-60" : ""}`}>
              <button className="block w-full text-left" onClick={() => open(v)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold">{v.number}</div>
                    <div className="truncate text-sm text-ink/70">{v.partyName}</div>
                  </div>
                  <Badge tone={STATUS_TONE[v.status]}>{statusText(v)}</Badge>
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <span className="text-xs text-ink/60">{v.date} · {v.godownName}</span>
                  <span className="text-lg font-bold tabular-nums">{money(v.total)}</span>
                </div>
                {(v.profit !== null || v.balanceDue > 0.005) && (
                  <div className="mt-1 flex justify-between text-xs">
                    <span className="text-low">{v.balanceDue > 0.005 ? `Due ${money(v.balanceDue)}` : ""}</span>
                    {v.profit !== null && <span className={v.profit >= 0 ? "text-in" : "text-out"}>Profit {money(v.profit)}</span>}
                  </div>
                )}
                {v.payments.length > 0 && <div className="mt-1 truncate text-xs font-medium text-ink/70" title={paymentSummary(v.payments)}>💳 {paymentSummary(v.payments)}</div>}
                {v.sourceNumber && <div className="mt-1 text-xs text-ink/60">From {v.sourceNumber}</div>}
                {v.convertedTo.length > 0 && <div className="mt-1 text-xs text-ink/60">→ {v.convertedTo.map((c) => c.number).join(", ")}</div>}
                <div className="mt-2 border-t border-ink/10 pt-2">
                  <AuditTrail v={v} compact />
                </div>
              </button>
              <Actions
                v={v}
                onPrint={() => window.open(`/print/voucher/${v.id}`, "_blank")}
                whatsapp={whatsappLink(v, phoneOf(v), businessName)}
                onConvert={convert}
                onCancel={cancel}
                onEdit={isOwner && v.editable ? edit : undefined}
              />
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <VoucherEditor
          kind={kind}
          ws={ws}
          scope={scope}
          parties={parties}
          onPartyAdded={reload}
          onClose={() => setCreating(false)}
          onSaved={async (v) => {
            setCreating(false);
            notify(`${KIND_LABEL[v.kind]} ${v.number} saved · ${money(v.total)}`);
            setTick((t) => t + 1);
            setViewing(v);
            if (stockEffect(v.kind)) await refresh();
          }}
        />
      )}
      {editing && (
        <VoucherEditor
          kind={editing.kind}
          ws={ws}
          scope={scope}
          parties={parties}
          onPartyAdded={reload}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async (v) => {
            setEditing(null);
            notify(`${KIND_LABEL[v.kind]} ${v.number} updated · ${money(v.total)}`);
            setTick((t) => t + 1);
            setViewing(v);
            if (stockEffect(v.kind)) await refresh();
          }}
        />
      )}
      {viewing && (
        <VoucherDetail
          v={viewing}
          canSeeCosts={can("costs.view")}
          whatsapp={whatsappLink(viewing, phoneOf(viewing), businessName)}
          onClose={() => setViewing(null)}
          onConvert={convert}
          onCancel={cancel}
          onEdit={isOwner && viewing.editable ? edit : undefined}
        />
      )}
    </div>
  );
}

function Actions({
  v,
  onPrint,
  whatsapp,
  onConvert,
  onCancel,
  onEdit,
}: {
  v: VoucherDTO;
  onPrint: () => void;
  whatsapp: string;
  onConvert: (v: VoucherDTO, to: VoucherKind) => void;
  onCancel: (v: VoucherDTO) => void;
  /** Present only for the owner on editable bills. */
  onEdit?: (v: VoucherDTO) => void;
}) {
  const targets = v.status === "OPEN" ? CONVERSIONS[v.kind] ?? [] : [];
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={onPrint}>🖨 Print</Button>
      {onEdit && <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => onEdit(v)}>✎ Edit</Button>}
      {v.shareToken && v.status !== "CANCELLED" && (
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="btn-3d btn-edge-in inline-flex items-center rounded-lg bg-in px-2.5 py-1.5 text-xs font-semibold text-white">
          WhatsApp
        </a>
      )}
      {targets.map((t) => (
        <Button key={t} variant="primary" className="px-2.5 py-1.5 text-xs" onClick={() => onConvert(v, t)}>→ {KIND_LABEL[t]}</Button>
      ))}
      {v.status === "OPEN" && <Button variant="danger" className="px-2.5 py-1.5 text-xs" onClick={() => onCancel(v)}>Cancel</Button>}
    </div>
  );
}

function VoucherDetail({
  v,
  canSeeCosts,
  whatsapp,
  onClose,
  onConvert,
  onCancel,
  onEdit,
}: {
  v: VoucherDTO;
  canSeeCosts: boolean;
  whatsapp: string;
  onClose: () => void;
  onConvert: (v: VoucherDTO, to: VoucherKind) => void;
  onCancel: (v: VoucherDTO) => void;
  onEdit?: (v: VoucherDTO) => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = shareUrl(v);
  return (
    <Modal title={`${KIND_LABEL[v.kind]} ${v.number}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-bold">{v.partyName}</div>
            <div className="text-xs text-ink/60">{v.date} · {v.godownName}{v.partyGstin ? ` · GSTIN ${v.partyGstin}` : ""}</div>
          </div>
          <Badge tone={STATUS_TONE[v.status]}>{statusText(v)}</Badge>
        </div>
        <ul className="divide-y divide-ink/10 rounded-xl border-2 border-ink/10">
          {(v.lines ?? []).map((l) => (
            <li key={l.id} className="flex justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-semibold">{l.itemName}</div>
                <div className="text-xs text-ink/60">
                  {qty(l.qty)} {l.unit} × {money(l.rate)}{l.discountAmt > 0 ? ` − ${money(l.discountAmt)} (${Number(l.discountPct.toFixed(2))}%)` : ""}{v.gstEnabled ? ` + ${l.taxRate}% GST` : ""}
                  {canSeeCosts && l.costRate !== null ? ` · cost ${money(l.costRate)}` : ""}
                </div>
              </div>
              <span className="font-semibold tabular-nums">{money(l.amount)}</span>
            </li>
          ))}
        </ul>
        <dl className="space-y-1 tabular-nums">
          <Line label="Taxable value" value={money(v.subtotal)} />
          {v.gstEnabled && (v.interState ? <Line label="IGST" value={money(v.igst)} /> : <><Line label="CGST" value={money(v.cgst)} /><Line label="SGST" value={money(v.sgst)} /></>)}
          {v.roundOff !== 0 && <Line label="Round off" value={money(v.roundOff)} />}
          <div className="flex justify-between border-t-2 border-ink/10 pt-1 text-base font-bold"><dt>Total</dt><dd>{money(v.total)}</dd></div>
          {v.kind === "PURCHASE" && v.partyId && <Line label="Paid with bill" value={money(v.paid)} />}
          {v.kind === "SALE" && (v.partyId || v.paidAtBilling > 0) && <Line label="Received" value={money(v.paid)} />}
          {v.balanceDue > 0.005 && <Line label="Balance due" value={money(v.balanceDue)} tone="text-low font-semibold" />}
          {v.profit !== null && <Line label="Profit on this bill" value={money(v.profit)} tone={v.profit >= 0 ? "text-in" : "text-out"} />}
        </dl>
        {v.payments.length > 0 && (
          <div className="rounded-xl border-2 border-ink/10 px-3 py-2">
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-ink/60">Payment details</div>
            <ul className="space-y-1.5">
              {v.payments.map((p) => (
                <li key={p.id} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold">
                      {PAYMENT_MODE_LABEL[p.mode] ?? p.mode}
                      {p.mode === "FINANCE" && p.financier ? ` · ${p.financier}` : ""}
                      {p.mode !== "FINANCE" && p.reference ? <span className="font-normal text-ink/60"> · {p.reference}</span> : null}
                    </span>
                    <span className="tabular-nums">{money(p.amount)}</span>
                  </div>
                  {p.mode === "FINANCE" && (
                    <div className="text-xs text-ink/70">
                      Disbursement {money(p.amount)} · Ref {p.paymentInfo || "—"} · Scheme {p.scheme || "—"}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.notes && <p className="rounded-lg bg-muted px-3 py-2 text-xs">{v.notes}</p>}
        <div className="rounded-lg bg-muted px-3 py-2">
          <AuditTrail v={v} />
          {v.sourceNumber && <div className="mt-0.5 text-xs text-ink/60">Made from {v.sourceNumber}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => window.open(`/print/voucher/${v.id}`, "_blank")}>🖨 Print A4</Button>
          <Button variant="ghost" onClick={() => window.open(`/print/voucher/${v.id}?format=t80`, "_blank")}>🧾 Thermal</Button>
          {url && v.status !== "CANCELLED" && (
            <>
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="btn-3d btn-edge-in inline-flex items-center rounded-lg bg-in px-3.5 py-2 text-sm font-semibold text-white">Share on WhatsApp</a>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url);
                    setCopied(true);
                  } catch {
                    window.prompt("Copy this link", url);
                  }
                }}
              >
                {copied ? "Link copied ✓" : "Copy link"}
              </Button>
            </>
          )}
        </div>
        {v.status === "OPEN" && (
          <div className="flex flex-wrap gap-2 border-t-2 border-ink/10 pt-3">
            {(CONVERSIONS[v.kind] ?? []).map((t) => <Button key={t} onClick={() => onConvert(v, t)}>→ Convert to {KIND_LABEL[t].toLowerCase()}</Button>)}
            {onEdit && <Button variant="ghost" onClick={() => onEdit(v)}>✎ Edit {KIND_LABEL[v.kind].toLowerCase()}</Button>}
            <Button variant="danger" onClick={() => onCancel(v)}>Cancel {KIND_LABEL[v.kind].toLowerCase()}</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Line({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`flex justify-between ${tone}`}>
      <dt className="text-ink/70">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

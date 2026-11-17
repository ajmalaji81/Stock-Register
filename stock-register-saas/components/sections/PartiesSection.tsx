"use client";

import { useCallback, useEffect, useState } from "react";
import { toCsv, todayISO } from "@/lib/engine";
import type { PartyRow, PaymentRow } from "@/lib/party-service";
import { api, MODE_LABEL, qs } from "../parties/api";
import { PartyModal, PaymentModal, type PartyFormValues, type PaymentFormValues } from "../parties/forms";
import PartyDetail from "../parties/PartyDetail";
import { Badge, Button, Empty, Field, Input, Select, SectionHeader, Stat, Tabs, downloadCsv, money } from "../ui";
import type { SectionProps } from "./types";

type View = "parties" | "payments";
type TypeFilter = "ALL" | "CUSTOMER" | "SUPPLIER";
type ModalState = { kind: "party"; party: PartyRow | null } | { kind: "payment"; partyId?: string; direction?: "IN" | "OUT" };

interface PartyList {
  parties: PartyRow[];
  totals: { receivable: number; payable: number };
}

export default function PartiesSection({ version, can, notify }: SectionProps) {
  const canEdit = can("parties.manage");
  const canPay = can("payments.manage");
  const [view, setView] = useState<View>("parties");
  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("ALL");
  const [sort, setSort] = useState("name");
  const [list, setList] = useState<PartyList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<PartyList>("GET", `/api/parties${qs({ q: q.trim(), type, sort })}`)
        .then((d) => live && (setList(d), setError(null)))
        .catch((e: Error) => live && setError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, type, sort, version, tick]);

  // Unfiltered list for the payment form, so a party opened from a filtered search is always selectable.
  const [allParties, setAllParties] = useState<PartyRow[]>([]);
  useEffect(() => {
    let live = true;
    api<PartyList>("GET", "/api/parties")
      .then((d) => live && setAllParties(d.parties))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version, tick]);

  const reload = () => setTick((t) => t + 1);
  const close = useCallback(() => {
    setModal(null);
    setFormError(null);
  }, []);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setFormError(null);
    try {
      await fn();
      close();
      reload();
      notify(done);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveParty = (v: PartyFormValues) =>
    modal?.kind === "party" && modal.party
      ? run(() => api("PATCH", `/api/parties/${modal.party!.id}`, v), "Party updated")
      : run(() => api("POST", "/api/parties", v), "Party added");

  const savePayment = (v: PaymentFormValues) =>
    run(() => api("POST", "/api/payments", v), v.direction === "IN" ? "Payment received recorded" : "Payment made recorded");

  const removeParty = async (p: PartyRow) => {
    if (!confirm(`Delete "${p.name}"? Only parties without bills or payments can be deleted.`)) return;
    try {
      await api("DELETE", `/api/parties/${p.id}`);
      setOpenId(null);
      reload();
      notify("Party deleted");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const parties = list?.parties ?? [];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Parties"
        subtitle="Customers, suppliers, what they owe and what you owe."
        actions={
          <div className="flex flex-wrap gap-2">
            {canPay && (
              <Button variant="in" onClick={() => setModal({ kind: "payment" })}>
                ₹ Record payment
              </Button>
            )}
            {canEdit && <Button onClick={() => setModal({ kind: "party", party: null })}>+ New party</Button>}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3">
        <Stat label="To receive" tone="in" value={<span className="text-in">{money(list?.totals.receivable ?? 0)}</span>} sub="customers owe you" />
        <Stat label="To pay" tone="out" value={<span className="text-out">{money(list?.totals.payable ?? 0)}</span>} sub="you owe suppliers" />
      </div>

      {canPay && (
        <Tabs<View>
          tabs={[
            ["parties", "Parties"],
            ["payments", "Payments"],
          ]}
          value={view}
          onChange={setView}
          label="Parties view"
        />
      )}

      {view === "payments" && canPay ? (
        <PaymentsList version={version + tick} parties={allParties} notify={notify} onChanged={reload} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-0 flex-1 sm:max-w-xs" placeholder="Search name, phone or GSTIN" value={q} onChange={(e) => setQ(e.target.value)} />
            <Select className="w-auto" value={type} onChange={(e) => setType(e.target.value as TypeFilter)} aria-label="Party type">
              <option value="ALL">All parties</option>
              <option value="CUSTOMER">Customers</option>
              <option value="SUPPLIER">Suppliers</option>
            </Select>
            <Select className="w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              <option value="name">Sort: name</option>
              <option value="balance_desc">Sort: most receivable</option>
              <option value="balance_asc">Sort: most payable</option>
            </Select>
          </div>

          {error ? (
            <Empty>{error}</Empty>
          ) : list === null ? (
            <Empty>Loading parties…</Empty>
          ) : parties.length === 0 ? (
            <Empty>{q || type !== "ALL" ? "No parties match." : "No parties yet. Add your customers and suppliers to track dues."}</Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {parties.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setOpenId(p.id)}
                  className="card-3d tilt p-4 text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-bold">{p.name}</div>
                      <div className="truncate text-xs text-ink/60">{p.phone || p.gstin || "—"}</div>
                    </div>
                    <Badge tone="ink">{p.type === "BOTH" ? "Both" : p.type === "SUPPLIER" ? "Supplier" : "Customer"}</Badge>
                  </div>
                  <div className="mt-3 flex items-baseline justify-between">
                    <span className="text-xs font-bold uppercase tracking-wide text-ink/55">
                      {p.balance > 0 ? "They owe" : p.balance < 0 ? "You owe" : "Settled"}
                    </span>
                    <span className={`text-xl font-bold tabular-nums ${p.balance > 0 ? "text-in" : p.balance < 0 ? "text-out" : "text-ink/50"}`}>
                      {money(Math.abs(p.balance))}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {openId && (
        <PartyDetail
          partyId={openId}
          version={version + tick}
          canPay={canPay}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onPay={(direction) => setModal({ kind: "payment", partyId: openId, direction })}
          onEdit={(party) => setModal({ kind: "party", party })}
          onDelete={removeParty}
        />
      )}

      {modal?.kind === "party" && <PartyModal party={modal.party} busy={busy} error={formError} onClose={close} onSave={saveParty} />}
      {modal?.kind === "payment" && (
        <div className="relative z-[55]">
          <PaymentModal
            parties={allParties.length ? allParties : parties}
            initialPartyId={modal.partyId}
            initialDirection={modal.direction}
            busy={busy}
            error={formError}
            onClose={close}
            onSave={savePayment}
          />
        </div>
      )}
    </div>
  );
}

function PaymentsList({
  version,
  parties,
  notify,
  onChanged,
}: {
  version: number;
  parties: PartyRow[];
  notify: (text: string, bad?: boolean) => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [partyId, setPartyId] = useState("");
  const [direction, setDirection] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<PaymentRow[]>("GET", `/api/payments${qs({ partyId, direction, from, to })}`)
      .then((r) => live && (setRows(r), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [partyId, direction, from, to, version]);

  const totalIn = (rows ?? []).filter((r) => r.direction === "IN").reduce((s, r) => s + r.amount, 0);
  const totalOut = (rows ?? []).filter((r) => r.direction === "OUT").reduce((s, r) => s + r.amount, 0);

  const reverse = async (r: PaymentRow) => {
    if (!confirm(`Reverse this ${money(r.amount)} payment? An equal opposite entry will be recorded today.`)) return;
    try {
      await api("POST", `/api/payments/${r.id}/reverse`);
      onChanged();
      notify("Payment reversed");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 print:hidden">
        <Field label="Party">
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">All parties</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Direction">
          <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="">Received & paid</option>
            <option value="IN">Received</option>
            <option value="OUT">Paid</option>
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold text-in">Received {money(totalIn)}</span> · <span className="font-semibold text-out">Paid {money(totalOut)}</span>
        </p>
        <div className="flex gap-2 print:hidden">
          <Button
            variant="ghost"
            disabled={!rows?.length}
            onClick={() =>
              rows &&
              downloadCsv(
                `payments-${todayISO()}.csv`,
                toCsv([
                  ["Date", "Party", "Direction", "Amount", "Mode", "Reference", "Notes", "By"],
                  ...rows.map((r) => [r.date, r.partyName, r.direction === "IN" ? "Received" : "Paid", r.amount, MODE_LABEL[r.mode] ?? r.mode, r.reference, r.notes, r.createdBy]),
                ]),
              )
            }
          >
            ⬇ Export CSV
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>
            🖨 Print / PDF
          </Button>
        </div>
      </div>
      {error ? (
        <Empty>{error}</Empty>
      ) : rows === null ? (
        <Empty>Loading payments…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No payments for these filters.</Empty>
      ) : (
        <div className="card-3d overflow-x-auto print:overflow-visible print:border-0 print:shadow-none">
          <table className="w-full min-w-[640px] text-sm print:min-w-0 print:text-xs">
            <thead className="bg-muted text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Party</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2">Ref / notes</th>
                <th className="px-3 py-2 print:hidden" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.date}</td>
                  <td className="px-3 py-2 font-semibold">{r.partyName}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums ${r.direction === "IN" ? "text-in" : "text-out"}`}>
                    {r.direction === "IN" ? "↓ " : "↑ "}
                    {money(r.amount)}
                  </td>
                  <td className="px-3 py-2">{MODE_LABEL[r.mode] ?? r.mode}</td>
                  <td className="px-3 py-2 text-ink/70">{[r.reference, r.notes].filter(Boolean).join(" · ")}</td>
                  <td className="px-3 py-2 text-right print:hidden">
                    {!r.notes.startsWith("Reversal of ") && (
                      <button className="text-xs font-semibold underline" onClick={() => reverse(r)}>
                        Reverse
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

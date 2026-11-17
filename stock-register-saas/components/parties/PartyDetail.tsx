"use client";

import { useEffect, useState } from "react";
import { toCsv, todayISO } from "@/lib/engine";
import type { PartyLedgerRow } from "@/lib/money";
import type { PartyRow } from "@/lib/party-service";
import { Badge, Button, Empty, Field, Input, downloadCsv, money } from "../ui";
import { api, qs } from "./api";

type Detail = PartyRow & { reminderLink: string | null };

const KIND_TONE: Record<string, "in" | "out" | "ink" | "low"> = {
  SALE: "ink",
  SALE_RETURN: "low",
  PURCHASE: "ink",
  PURCHASE_RETURN: "low",
  PAYMENT_IN: "in",
  PAYMENT_OUT: "out",
  OPENING: "ink",
};

function balanceText(b: number): string {
  return b > 0 ? `${money(b)} Dr` : b < 0 ? `${money(-b)} Cr` : money(0);
}

/** Full-screen party view: balance, WhatsApp reminder, ledger with running balance, CSV / print. */
export default function PartyDetail({
  partyId,
  version,
  canPay,
  canEdit,
  onClose,
  onPay,
  onEdit,
  onDelete,
}: {
  partyId: string;
  version: number;
  canPay: boolean;
  canEdit: boolean;
  onClose: () => void;
  onPay: (direction: "IN" | "OUT") => void;
  onEdit: (p: PartyRow) => void;
  onDelete: (p: PartyRow) => void;
}) {
  const [party, setParty] = useState<Detail | null>(null);
  const [rows, setRows] = useState<PartyLedgerRow[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      api<Detail>("GET", `/api/parties/${partyId}`),
      api<{ rows: PartyLedgerRow[] }>("GET", `/api/parties/${partyId}/ledger${qs({ from, to })}`),
    ])
      .then(([p, l]) => {
        if (!live) return;
        setParty(p);
        setRows(l.rows);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [partyId, from, to, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const exportCsv = () => {
    if (!party || !rows) return;
    downloadCsv(
      `ledger-${party.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${todayISO()}.csv`,
      toCsv([
        ["Date", "Particulars", "Debit (they owe)", "Credit (paid / we owe)", "Balance", "Notes"],
        ...rows.map((r) => [r.date, r.ref, r.debit || "", r.credit || "", balanceText(r.balance), r.notes]),
      ]),
    );
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-surface print:static print:bg-paper" role="dialog" aria-modal="true" aria-label="Party details">
      <div className="mx-auto max-w-4xl px-4 py-4">
        <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
          <Button variant="ghost" onClick={onClose}>
            ← Back to parties
          </Button>
          {party && canEdit && (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onEdit(party)}>
                Edit
              </Button>
              <Button variant="danger" onClick={() => onDelete(party)}>
                Delete
              </Button>
            </div>
          )}
        </div>

        {error && <Empty>{error}</Empty>}
        {!party && !error && <Empty>Loading…</Empty>}

        {party && (
          <>
            <div className="card-3d mb-4 p-5 print:border-0 print:shadow-none">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-2xl font-bold">{party.name}</h2>
                  <p className="text-sm text-ink/65">
                    {party.type === "BOTH" ? "Customer & supplier" : party.type === "SUPPLIER" ? "Supplier" : "Customer"}
                    {party.phone ? ` · ${party.phone}` : ""}
                    {party.gstin ? ` · GSTIN ${party.gstin}` : ""}
                  </p>
                  {(party.address || party.state) && (
                    <p className="text-sm text-ink/65">{[party.address, party.state].filter(Boolean).join(", ")}</p>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-xs font-bold uppercase tracking-wide text-ink/60">
                    {party.balance > 0 ? "They owe you" : party.balance < 0 ? "You owe them" : "Balance"}
                  </div>
                  <div className={`text-3xl font-bold tabular-nums ${party.balance > 0 ? "text-in" : party.balance < 0 ? "text-out" : ""}`}>
                    {money(Math.abs(party.balance))}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 print:hidden">
                {canPay && (
                  <>
                    <Button variant="in" onClick={() => onPay("IN")}>
                      ↓ Payment received
                    </Button>
                    <Button variant="out" onClick={() => onPay("OUT")}>
                      ↑ Payment made
                    </Button>
                  </>
                )}
                {party.reminderLink && (
                  <a
                    href={party.reminderLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-3d btn-edge-in inline-flex items-center gap-1.5 rounded-xl bg-[#25D366] px-3.5 py-2 text-sm font-semibold text-ink"
                  >
                    💬 Send WhatsApp reminder
                  </a>
                )}
              </div>
              {party.balance > 0 && !party.phone && <p className="mt-2 text-xs text-ink/60 print:hidden">Add a phone number to send WhatsApp reminders.</p>}
            </div>

            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div className="grid grid-cols-2 gap-2 print:hidden">
                <Field label="From">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="To">
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </div>
              <div className="flex gap-2 print:hidden">
                <Button variant="ghost" onClick={exportCsv} disabled={!rows?.length}>
                  ⬇ Export CSV
                </Button>
                <Button variant="ghost" onClick={() => window.print()}>
                  🖨 Print / PDF
                </Button>
              </div>
            </div>
            <p className="mb-3 hidden text-sm print:block">
              Party ledger{from || to ? ` · ${from || "start"} to ${to || "today"}` : ""} · Printed {new Date().toLocaleString("en-IN")}
            </p>

            {rows === null ? (
              <Empty>Loading ledger…</Empty>
            ) : rows.length === 0 ? (
              <Empty>No bills or payments with this party yet.</Empty>
            ) : (
              <div className="card-3d overflow-x-auto print:overflow-visible print:border-0 print:shadow-none">
                <table className="w-full min-w-[620px] text-sm print:min-w-0 print:text-xs">
                  <thead className="bg-muted text-left text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Particulars</th>
                      <th className="px-3 py-2 text-right">Debit</th>
                      <th className="px-3 py-2 text-right">Credit</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/10">
                    {rows.map((r, i) => (
                      <tr key={`${r.id}-${i}`}>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.date}</td>
                        <td className="px-3 py-2">
                          <Badge tone={KIND_TONE[r.kind] ?? "ink"}>{r.ref}</Badge>
                          {r.notes && <div className="mt-0.5 text-xs text-ink/60">{r.notes}</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.debit ? money(r.debit) : ""}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.credit ? money(r.credit) : ""}</td>
                        <td className={`whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums ${r.balance > 0 ? "text-in" : r.balance < 0 ? "text-out" : ""}`}>
                          {balanceText(r.balance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-ink/60">Dr = they owe you · Cr = you owe them.</p>
          </>
        )}
      </div>
    </div>
  );
}

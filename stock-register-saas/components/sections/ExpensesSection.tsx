"use client";

import { useCallback, useEffect, useState } from "react";
import { toCsv, todayISO } from "@/lib/engine";
import type { CashSummary } from "@/lib/money";
import type { ExpenseRow } from "@/lib/party-service";
import { api, MODE_LABEL, qs } from "../parties/api";
import { ExpenseModal, type ExpenseFormValues } from "../parties/forms";
import { Button, Empty, Field, Input, Select, SectionHeader, Stat, Tabs, downloadCsv, money } from "../ui";
import type { SectionProps } from "./types";

type View = "expenses" | "cashbook";

interface ExpenseList {
  expenses: ExpenseRow[];
  byCategory: { category: string; total: number }[];
  byMonth: { month: string; total: number }[];
  total: number;
}

const monthStart = () => todayISO().slice(0, 8) + "01";

function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function PrintTitle({ title, from, to }: { title: string; from: string; to: string }) {
  return (
    <p className="mb-3 hidden text-sm print:block">
      <b>{title}</b>
      {from || to ? ` · ${from || "start"} to ${to || "today"}` : ""} · Printed {new Date().toLocaleString("en-IN")}
    </p>
  );
}

export default function ExpensesSection({ version, can, notify }: SectionProps) {
  const canExpenses = can("expenses.manage");
  const canCash = can("reports.view") || can("payments.manage");
  const [view, setView] = useState<View>(canExpenses ? "expenses" : "cashbook");
  const tabs: [View, string][] = [
    ...(canExpenses ? ([["expenses", "Expenses"]] as [View, string][]) : []),
    ...(canCash ? ([["cashbook", "Cash book"]] as [View, string][]) : []),
  ];

  return (
    <div className="space-y-4">
      <SectionHeader title="Expenses & cash book" subtitle="Shop running costs, and cash in hand vs bank." />
      {tabs.length > 1 && <Tabs<View> tabs={tabs} value={view} onChange={setView} label="Expenses view" />}
      {view === "expenses" && canExpenses && <Expenses version={version} notify={notify} />}
      {view === "cashbook" && canCash && <CashBook version={version} />}
    </div>
  );
}

function Expenses({ version, notify }: { version: number; notify: (t: string, bad?: boolean) => void }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState("");
  const [category, setCategory] = useState("");
  const [data, setData] = useState<ExpenseList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ExpenseList>("GET", `/api/expenses${qs({ from, to, category })}`)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, category, version, tick]);

  const close = useCallback(() => {
    setOpen(false);
    setFormError(null);
  }, []);

  const save = async (v: ExpenseFormValues) => {
    setBusy(true);
    setFormError(null);
    try {
      await api("POST", "/api/expenses", v);
      close();
      setTick((t) => t + 1);
      notify("Expense added");
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: ExpenseRow) => {
    if (!confirm(`Delete this ${money(e.amount)} ${e.category} expense?`)) return;
    try {
      await api("DELETE", `/api/expenses/${e.id}`);
      setTick((t) => t + 1);
      notify("Expense deleted");
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  const rows = data?.expenses ?? [];
  const cats = data ? [...new Set([...data.byCategory.map((c) => c.category)])] : [];

  return (
    <div className="space-y-4">
      <PrintTitle title="Expenses" from={from} to={to} />
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv(
                `expenses-${todayISO()}.csv`,
                toCsv([["Date", "Category", "Amount", "Paid by", "Notes", "By"], ...rows.map((r) => [r.date, r.category, r.amount, MODE_LABEL[r.mode] ?? r.mode, r.notes, r.createdBy])]),
              )
            }
          >
            ⬇ CSV
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>
            🖨 Print
          </Button>
          <Button variant="out" onClick={() => setOpen(true)}>
            + Add expense
          </Button>
        </div>
      </div>

      {error ? (
        <Empty>{error}</Empty>
      ) : data === null ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Total spent" tone="out" value={<span className="text-out">{money(data.total)}</span>} sub={`${rows.length} entries`} />
            {data.byCategory.slice(0, 3).map((c) => (
              <Stat key={c.category} label={c.category} value={money(c.total)} sub={data.total ? `${Math.round((c.total / data.total) * 100)}% of spend` : undefined} />
            ))}
          </div>

          {data.byMonth.length > 1 && (
            <div className="card-3d p-4">
              <h3 className="mb-2 text-sm font-bold">Monthly totals</h3>
              <ul className="space-y-1.5">
                {data.byMonth.map((m) => {
                  const max = Math.max(...data.byMonth.map((x) => x.total)) || 1;
                  return (
                    <li key={m.month} className="flex items-center gap-2 text-sm">
                      <span className="w-20 shrink-0 tabular-nums">{monthLabel(m.month)}</span>
                      <span className="h-3 rounded-full bg-out/70" style={{ width: `${Math.max(4, (m.total / max) * 60)}%` }} aria-hidden />
                      <span className="ml-auto font-semibold tabular-nums">{money(m.total)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {rows.length === 0 ? (
            <Empty>No expenses in this period.</Empty>
          ) : (
            <div className="card-3d overflow-x-auto print:overflow-visible print:border-0 print:shadow-none">
              <table className="w-full min-w-[560px] text-sm print:min-w-0 print:text-xs">
                <thead className="bg-muted text-left text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2">Paid by</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2 print:hidden" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/10">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.date}</td>
                      <td className="px-3 py-2 font-semibold">{r.category}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-out">{money(r.amount)}</td>
                      <td className="px-3 py-2">{MODE_LABEL[r.mode] ?? r.mode}</td>
                      <td className="px-3 py-2 text-ink/70">{r.notes}</td>
                      <td className="px-3 py-2 text-right print:hidden">
                        {r.canDelete && (
                          <button className="text-xs font-semibold text-out underline" onClick={() => remove(r)}>
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {open && <ExpenseModal categories={cats} busy={busy} error={formError} onClose={close} onSave={save} />}
    </div>
  );
}

function CashBook({ version }: { version: number }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState("");
  const [data, setData] = useState<CashSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<CashSummary>("GET", `/api/cashbook${qs({ from, to })}`)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, version]);

  return (
    <div className="space-y-4">
      <PrintTitle title="Cash book" from={from} to={to} />
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            disabled={!data?.days.length}
            onClick={() =>
              data &&
              downloadCsv(
                `cash-book-${todayISO()}.csv`,
                toCsv([["Date", "Cash in", "Cash out", "Bank in", "Bank out"], ...data.days.map((d) => [d.date, d.cashIn, d.cashOut, d.bankIn, d.bankOut])]),
              )
            }
          >
            ⬇ CSV
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>
            🖨 Print
          </Button>
        </div>
      </div>
      {error ? (
        <Empty>{error}</Empty>
      ) : data === null ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Cash in hand" tone={data.closingCash < 0 ? "out" : "in"} value={money(data.closingCash)} sub={`Opening ${money(data.openingCash)}`} />
            <Stat label="Bank / UPI" tone={data.closingBank < 0 ? "out" : "in"} value={money(data.closingBank)} sub={`Opening ${money(data.openingBank)}`} />
          </div>
          <p className="text-xs text-ink/60">From payments received and made (Cash vs Bank / UPI / Cheque) minus expenses. Bills not yet paid don&apos;t count until a payment is recorded.</p>
          {data.days.length === 0 ? (
            <Empty>No money movement in this period.</Empty>
          ) : (
            <div className="card-3d overflow-x-auto print:overflow-visible print:border-0 print:shadow-none">
              <table className="w-full min-w-[520px] text-sm print:min-w-0 print:text-xs">
                <thead className="bg-muted text-left text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2 text-right text-in">Cash in</th>
                    <th className="px-3 py-2 text-right text-out">Cash out</th>
                    <th className="px-3 py-2 text-right text-in">Bank in</th>
                    <th className="px-3 py-2 text-right text-out">Bank out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/10">
                  {data.days.map((d) => (
                    <tr key={d.date}>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{d.date}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-in">{d.cashIn ? money(d.cashIn) : ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-out">{d.cashOut ? money(d.cashOut) : ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-in">{d.bankIn ? money(d.bankIn) : ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-out">{d.bankOut ? money(d.bankOut) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

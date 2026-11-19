"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toCsv, todayISO } from "@/lib/engine";
import { compactInr, monthLabel, monthLabelLong, type MonthPreset } from "@/lib/report-months";
import type { BillPaymentMode, MonthlyReport as Report, MonthRow } from "@/lib/report-service";
import { api } from "../billing/api";
import { Button, Empty, Field, Select, Stat, Tabs, downloadCsv, money } from "../ui";
import BarChart from "./BarChart";

type Metric = "net" | "bills" | "gst" | "profit";
const MODES: BillPaymentMode[] = ["CASH", "CARD", "UPI", "BANK", "CHEQUE", "FINANCE"];
const MODE_LABEL: Record<BillPaymentMode, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", BANK: "Bank", CHEQUE: "Cheque", FINANCE: "Finance" };

export default function MonthlyReport({ scope, scopeName, version, notify }: { scope: string; scopeName: string; version: number; notify: (t: string, bad?: boolean) => void }) {
  const thisYear = new Date().getFullYear();
  const [preset, setPreset] = useState<MonthPreset>("last12");
  const [year, setYear] = useState(thisYear);
  const [metric, setMetric] = useState<Metric>("net");
  const [data, setData] = useState<Report | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    const qs = new URLSearchParams({ preset, ...(preset === "year" ? { year: String(year) } : {}), ...(scope !== "ALL" ? { godownId: scope } : {}) });
    api<Report>("GET", `/api/reports/monthly?${qs}`)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && notify(e.message, true));
    return () => {
      live = false;
    };
  }, [preset, year, scope, version, notify]);

  const metrics: [Metric, string][] = [
    ["net", "Net sales"],
    ["bills", "Bills"],
    ["gst", "GST"],
    ...(data?.showProfit ? ([["profit", "Profit"]] as [Metric, string][]) : []),
  ];
  const activeMetric = metrics.some(([k]) => k === metric) ? metric : "net";
  const metricName = metrics.find(([k]) => k === activeMetric)?.[1] ?? "Net sales";
  const valueOf = (r: MonthRow) => (activeMetric === "bills" ? r.bills : activeMetric === "gst" ? r.gst : activeMetric === "profit" ? r.profit ?? 0 : r.net);
  const fmt = (v: number) => (activeMetric === "bills" ? String(v) : compactInr(v));

  const rangeName = data ? `${monthLabelLong(data.from)} – ${monthLabelLong(data.to)}` : "";

  function exportCsv() {
    if (!data) return;
    const head = ["Month", "Bills", "Returns", "Gross sales", "Returns value", "Net sales", "Taxable", "GST", ...(data.showProfit ? ["Cost", "Profit"] : []), ...MODES.map((m) => `Paid ${MODE_LABEL[m]}`)];
    const row = (label: string, r: Omit<MonthRow, "month">) => [
      label, r.bills, r.returns, r.gross, r.returnsValue, r.net, r.taxable, r.gst,
      ...(data.showProfit ? [r.cost ?? 0, r.profit ?? 0] : []),
      ...MODES.map((m) => r.payments[m]),
    ];
    downloadCsv(`monthly-sales-${data.from}-to-${data.to}.csv`, toCsv([head, ...data.months.map((r) => row(monthLabelLong(r.month), r)), row("TOTAL", data.totals)]));
  }

  const best = data ? data.months.reduce<MonthRow | null>((b, r) => (!b || r.net > b.net ? r : b), null) : null;
  const active = data ? data.months.filter((r) => r.bills > 0).length : 0;

  return (
    <div className="space-y-4">
      <div className="mb-2 hidden print:block">
        <h1 className="text-xl font-bold">Monthly sales — {metricName}</h1>
        <p className="text-sm">{rangeName} · {scopeName} · printed {todayISO()}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <Field label="Period">
          <Select value={preset} onChange={(e) => setPreset(e.target.value as MonthPreset)}>
            <option value="last12">Last 12 months</option>
            <option value="thisFY">This financial year (Apr–Mar)</option>
            <option value="lastFY">Last financial year</option>
            <option value="year">Calendar year…</option>
          </Select>
        </Field>
        {preset === "year" && (
          <Field label="Year">
            <Select value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
              {Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </Field>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={exportCsv} disabled={!data}>⬇ CSV</Button>
          <Button variant="ghost" onClick={() => window.print()}>🖨 Print / PDF</Button>
        </div>
      </div>

      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
            <Stat label="Net sales" tone="in" value={money(data.totals.net)} sub={`${data.totals.bills} bills · ${data.totals.returns} returns`} />
            <Stat label="GST collected" value={money(data.totals.gst)} sub={`taxable ${money(data.totals.taxable)}`} />
            <Stat label="Best month" value={best && best.net > 0 ? monthLabel(best.month) : "—"} sub={best && best.net > 0 ? money(best.net) : "no sales yet"} />
            {data.showProfit ? (
              <Stat label="Gross profit" tone={(data.totals.profit ?? 0) >= 0 ? "in" : "out"} value={money(data.totals.profit ?? 0)} sub="taxable sales − purchase cost" />
            ) : (
              <Stat label="Months with sales" value={`${active} / ${data.months.length}`} sub={rangeName} />
            )}
          </div>

          <div className="card-3d p-4 print:shadow-none">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-bold">{metricName} by month</h3>
                <p className="text-xs text-ink/60">{rangeName} · {scopeName}{activeMetric === "net" ? " · after returns, incl. GST" : ""}</p>
              </div>
              <div className="print:hidden"><Tabs tabs={metrics} value={activeMetric} onChange={setMetric} label="Measure" /></div>
            </div>
            <BarChart
              formatAxis={(v) => (activeMetric === "bills" ? String(Math.round(v)) : compactInr(v))}
              summary={`${metricName} by month, ${rangeName}. ${data.months.map((r) => `${monthLabelLong(r.month)} ${fmt(valueOf(r))}`).join("; ")}.`}
              bars={data.months.map((r) => ({
                key: r.month,
                label: monthLabel(r.month),
                value: valueOf(r),
                valueLabel: fmt(valueOf(r)),
                tooltip: {
                  title: monthLabelLong(r.month),
                  lines: [
                    ["Net sales", money(r.net)],
                    ["Bills", `${r.bills}${r.returns ? ` (+${r.returns} returns)` : ""}`],
                    ["GST", money(r.gst)],
                    ...(data.showProfit ? ([["Profit", money(r.profit ?? 0)]] as [string, string][]) : []),
                  ],
                },
              }))}
            />
          </div>

          <MonthTable data={data} />

          <div className="grid gap-4 @4xl:grid-cols-2">
            <div>
              <h3 className="mb-2 font-bold">How customers paid</h3>
              <SimpleTable
                head={["Mode", "Amount", "Share"]}
                right={[1, 2]}
                rows={MODES.filter((m) => data.totals.payments[m] > 0).map((m) => {
                  const all = MODES.reduce((s, k) => s + data.totals.payments[k], 0);
                  return [MODE_LABEL[m], money(data.totals.payments[m]), `${all ? Math.round((data.totals.payments[m] / all) * 100) : 0}%`];
                })}
                empty="No payments were recorded on bills in this period."
              />
            </div>
            <div>
              <h3 className="mb-2 font-bold">Finance by financier</h3>
              <SimpleTable
                head={["Financier", "Bills", "Disbursed"]}
                right={[1, 2]}
                rows={data.financiers.map((f) => [f.financier, String(f.bills), money(f.amount)])}
                empty="No finance sales in this period."
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MonthTable({ data }: { data: Report }) {
  const head = ["Month", "Bills", "Gross", "Returns", "Net sales", "Taxable", "GST", ...(data.showProfit ? ["Profit"] : [])];
  const cells = (label: ReactNode, r: Omit<MonthRow, "month">) => [
    label, String(r.bills), money(r.gross), r.returnsValue ? `−${money(r.returnsValue)}` : "—", <b key="n">{money(r.net)}</b>, money(r.taxable), money(r.gst),
    ...(data.showProfit ? [<b key="p" className={(r.profit ?? 0) >= 0 ? "text-in" : "text-out"}>{money(r.profit ?? 0)}</b>] : []),
  ];
  return (
    <div className="card-3d overflow-x-auto print:overflow-visible print:shadow-none">
      <table className="w-full min-w-[640px] text-sm print:min-w-0 print:text-xs">
        <thead className="bg-muted text-left text-xs uppercase tracking-wide">
          <tr>{head.map((h, i) => <th key={h} className={`px-3 py-2 ${i ? "text-right" : ""}`}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-ink/10">
          {data.months.map((r) => (
            <tr key={r.month} className={r.bills === 0 && r.returns === 0 ? "text-ink/45" : ""}>
              {cells(monthLabelLong(r.month), r).map((c, i) => <td key={i} className={`px-3 py-2 ${i ? "text-right tabular-nums" : ""}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-ink font-bold">
          <tr>{cells("Total", data.totals).map((c, i) => <td key={i} className={`px-3 py-2 ${i ? "text-right tabular-nums" : ""}`}>{c}</td>)}</tr>
        </tfoot>
      </table>
    </div>
  );
}

function SimpleTable({ head, rows, right, empty }: { head: string[]; rows: ReactNode[][]; right: number[]; empty: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="card-3d overflow-x-auto print:shadow-none">
      <table className="w-full text-sm">
        <thead className="bg-muted text-left text-xs uppercase tracking-wide">
          <tr>{head.map((h, i) => <th key={h} className={`px-3 py-2 ${right.includes(i) ? "text-right" : ""}`}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-ink/10">
          {rows.map((r, ri) => (
            <tr key={ri}>{r.map((c, i) => <td key={i} className={`px-3 py-2 ${right.includes(i) ? "text-right tabular-nums" : ""}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toCsv, todayISO } from "@/lib/engine";
import { KIND_LABEL } from "@/lib/gst";
import type { SalesReport } from "@/lib/voucher-service";
import { api } from "../billing/api";
import { Button, Empty, Field, Input, SectionHeader, Stat, Tabs, downloadCsv, money, qty } from "../ui";
import MonthlyReport from "../charts/MonthlyReport";
import type { SectionProps } from "./types";

type View = "register" | "gst" | "hsn" | "profit";

function monthStart(): string {
  const d = new Date();
  return todayISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

export default function BillingReportsSection(props: SectionProps) {
  const [mode, setMode] = useState<"period" | "monthly">("monthly");
  const tabs = (
    <div className="print:hidden">
      <Tabs tabs={[["monthly", "📊 Monthly analysis"], ["period", "Bills & GST by date"]]} value={mode} onChange={setMode} label="Report type" />
    </div>
  );
  if (mode === "monthly")
    return (
      <div className="space-y-4">
        <SectionHeader title="Sales analysis" subtitle="Month-wise sales after returns. Cancelled bills are excluded." />
        {tabs}
        <MonthlyReport scope={props.scope} scopeName={props.scopeName} version={props.version} notify={props.notify} />
      </div>
    );
  return <PeriodReport {...props} tabs={tabs} />;
}

function PeriodReport({ can, version, notify, tabs }: SectionProps & { tabs: ReactNode }) {
  const [side, setSide] = useState<"sales" | "purchases">("sales");
  const [view, setView] = useState<View>("register");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayISO());
  const [data, setData] = useState<SalesReport | null>(null);
  const canPurchases = can("costs.view");

  useEffect(() => {
    let live = true;
    setData(null);
    const qs = new URLSearchParams({ side, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    api<SalesReport>("GET", `/api/reports/sales?${qs}`)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && notify(e.message, true));
    return () => {
      live = false;
    };
  }, [side, from, to, version, notify]);

  const views: [View, string][] = [
    ["register", side === "sales" ? "Sales register" : "Purchase register"],
    ["gst", "GST by rate"],
    ["hsn", "HSN summary"],
    ...(side === "sales" && data?.profit ? ([["profit", "Profit"]] as [View, string][]) : []),
  ];
  const activeView = views.some(([k]) => k === view) ? view : "register";

  function exportCsv() {
    if (!data) return;
    const name = `${side}-${activeView}-${from || "start"}-to-${to || todayISO()}.csv`;
    if (activeView === "register")
      downloadCsv(name, toCsv([
        ["Date", "Number", "Type", "Party", "GSTIN", "Taxable", "CGST", "SGST", "IGST", "Total"],
        ...data.register.map((r) => [r.date, r.number, KIND_LABEL[r.kind], r.party, r.gstin, r.taxable, r.cgst, r.sgst, r.igst, r.total]),
        ["", "", "", "TOTAL", "", data.totals.taxable, data.totals.cgst, data.totals.sgst, data.totals.igst, data.totals.total],
      ]));
    else if (activeView === "gst")
      downloadCsv(name, toCsv([["GST rate %", "Taxable", "CGST", "SGST", "IGST"], ...data.byRate.map((r) => [r.rate, r.taxable, r.cgst, r.sgst, r.igst])]));
    else if (activeView === "hsn")
      downloadCsv(name, toCsv([["HSN", "Description", "Qty", "Taxable", "Tax"], ...data.byHsn.map((r) => [r.hsn, r.description, r.qty, r.taxable, r.tax])]));
    else if (data.profit)
      downloadCsv(name, toCsv([["Item", "Qty", "Sales (taxable)", "Cost", "Profit"], ...data.profit.byItem.map((r) => [r.name, r.qty, r.sales, r.cost, r.profit])]));
  }

  return (
    <div className="space-y-4">
      <div className="mb-4 hidden print:block">
        <h1 className="text-xl font-bold">{views.find(([k]) => k === activeView)?.[1]}</h1>
        <p className="text-sm">{from || "Start"} to {to || todayISO()}</p>
      </div>
      <SectionHeader
        title="Sales, GST & profit"
        subtitle="Cancelled bills are excluded; returns are subtracted."
        actions={
          <div className="flex gap-2 print:hidden">
            <Button variant="ghost" onClick={exportCsv} disabled={!data}>⬇ CSV</Button>
            <Button variant="ghost" onClick={() => window.print()}>🖨 Print / PDF</Button>
          </div>
        }
      />
      {tabs}
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        {canPurchases && <Tabs tabs={[["sales", "Sales"], ["purchases", "Purchases"]]} value={side} onChange={setSide} label="Side" />}
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Taxable value" value={money(data.totals.taxable)} sub={`${data.register.length} bills`} />
            <Stat label="GST" tone="in" value={money(data.totals.cgst + data.totals.sgst + data.totals.igst)} sub={`CGST ${money(data.totals.cgst)} · SGST ${money(data.totals.sgst)} · IGST ${money(data.totals.igst)}`} />
            <Stat label="B2B (with GSTIN)" value={money(data.b2b.total)} sub={`${data.b2b.count} bills`} />
            {data.profit ? (
              <Stat label="Gross profit" tone={data.profit.total >= 0 ? "in" : "out"} value={money(data.profit.total)} sub="taxable sales − purchase cost" />
            ) : (
              <Stat label="B2C (no GSTIN)" value={money(data.b2c.total)} sub={`${data.b2c.count} bills`} />
            )}
          </div>

          <div className="print:hidden"><Tabs tabs={views} value={activeView} onChange={setView} label="Report" /></div>

          {activeView === "register" && (
            <Table
              head={["Date", "Number", "Party", "Taxable", "CGST", "SGST", "IGST", "Total"]}
              right={[3, 4, 5, 6, 7]}
              rows={data.register.map((r) => [r.date, `${r.number}${r.kind.endsWith("RETURN") ? " (return)" : ""}`, <span key="p">{r.party}{r.gstin && <span className="block text-xs text-ink/60">{r.gstin}</span>}</span>, money(r.taxable), money(r.cgst), money(r.sgst), money(r.igst), <b key="t">{money(r.total)}</b>])}
              foot={["", "", "Total", money(data.totals.taxable), money(data.totals.cgst), money(data.totals.sgst), money(data.totals.igst), money(data.totals.total)]}
            />
          )}
          {activeView === "gst" && (
            <>
              <Table
                head={["GST rate", "Taxable", "CGST", "SGST", "IGST", "Total tax"]}
                right={[1, 2, 3, 4, 5]}
                rows={data.byRate.map((r) => [`${r.rate}%`, money(r.taxable), money(r.cgst), money(r.sgst), money(r.igst), <b key="t">{money(r.cgst + r.sgst + r.igst)}</b>])}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="B2B — registered buyers" value={money(data.b2b.taxable)} sub={`tax ${money(data.b2b.tax)} · ${data.b2b.count} bills`} />
                <Stat label="B2C — unregistered / cash" value={money(data.b2c.taxable)} sub={`tax ${money(data.b2c.tax)} · ${data.b2c.count} bills`} />
              </div>
              <p className="text-xs text-ink/60">A summary to help you or your accountant prepare {side === "sales" ? "GSTR-1" : "input tax credit"} figures. Check them before filing.</p>
            </>
          )}
          {activeView === "hsn" && (
            <Table
              head={["HSN", "Description", "Qty", "Taxable", "Tax"]}
              right={[2, 3, 4]}
              rows={data.byHsn.map((r) => [r.hsn, r.description, qty(r.qty), money(r.taxable), money(r.tax)])}
            />
          )}
          {activeView === "profit" && data.profit && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 font-bold">By item</h3>
                <Table head={["Item", "Qty", "Sales", "Profit"]} right={[1, 2, 3]} rows={data.profit.byItem.map((r) => [r.name, qty(r.qty), money(r.sales), <Profit key="p" v={r.profit} />])} />
              </div>
              <div>
                <h3 className="mb-2 font-bold">By party</h3>
                <Table head={["Party", "Sales", "Profit"]} right={[1, 2]} rows={data.profit.byParty.map((r) => [r.party, money(r.sales), <Profit key="p" v={r.profit} />])} />
              </div>
              <div className="lg:col-span-2">
                <h3 className="mb-2 font-bold">By bill</h3>
                <Table head={["Date", "Bill", "Party", "Sales", "Cost", "Profit"]} right={[3, 4, 5]} rows={data.profit.byBill.map((r) => [r.date, r.number, r.party, money(r.sales), money(r.cost), <Profit key="p" v={r.profit} />])} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Profit({ v }: { v: number }) {
  return <b className={v >= 0 ? "text-in" : "text-out"}>{money(v)}</b>;
}

function Table({ head, rows, right, foot }: { head: string[]; rows: ReactNode[][]; right: number[]; foot?: ReactNode[] }) {
  if (rows.length === 0) return <Empty>Nothing in this period.</Empty>;
  const al = (i: number) => (right.includes(i) ? "text-right tabular-nums" : "");
  return (
    <div className="card-3d overflow-x-auto print:overflow-visible print:shadow-none">
      <table className="w-full min-w-[560px] text-sm print:min-w-0 print:text-xs">
        <thead className="bg-muted text-left text-xs uppercase tracking-wide">
          <tr>{head.map((h, i) => <th key={h} className={`px-3 py-2 ${al(i)}`}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-ink/10">
          {rows.map((r, ri) => (
            <tr key={ri}>{r.map((c, i) => <td key={i} className={`px-3 py-2 ${al(i)}`}>{c}</td>)}</tr>
          ))}
        </tbody>
        {foot && (
          <tfoot className="border-t-2 border-ink font-bold">
            <tr>{foot.map((c, i) => <td key={i} className={`px-3 py-2 ${al(i)}`}>{c}</td>)}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// Month-wise sales analysis: one row per month (empty months included as zeros),
// plus how sales were paid (from the bill's split payments) and finance totals by financier.
import { z } from "zod";
import { assertCan, assertGodownAccess, type Actor } from "./actor";
import { prisma } from "./db";
import { StockError } from "./engine";
import { MAX_MONTHS, isMonth, monthEndDate, monthsBetween, presetRange, type MonthPreset } from "./report-months";

export const BILL_PAYMENT_MODES = ["CASH", "CARD", "UPI", "BANK", "CHEQUE", "FINANCE"] as const;
export type BillPaymentMode = (typeof BILL_PAYMENT_MODES)[number];

export const monthlyQuerySchema = z.object({
  preset: z.enum(["last12", "thisFY", "lastFY", "year"]).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  from: z.string().refine(isMonth, "from must be YYYY-MM").optional(),
  to: z.string().refine(isMonth, "to must be YYYY-MM").optional(),
  godownId: z.string().optional(),
});
export type MonthlyQuery = z.infer<typeof monthlyQuerySchema>;

export interface MonthRow {
  month: string; // YYYY-MM
  bills: number; // sales bills (returns not counted)
  returns: number; // number of sales returns
  gross: number; // SALE totals (incl. GST)
  returnsValue: number; // SALE_RETURN totals (incl. GST)
  net: number; // gross - returnsValue
  taxable: number; // net taxable value
  gst: number; // net GST (CGST + SGST + IGST)
  cost?: number; // only with costs.view
  profit?: number; // taxable - cost, only with costs.view
  payments: Record<BillPaymentMode, number>; // collected at billing, by mode
}

export interface MonthlyReport {
  from: string;
  to: string;
  showProfit: boolean;
  months: MonthRow[];
  totals: Omit<MonthRow, "month">;
  financiers: { financier: string; bills: number; amount: number }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const zeroPayments = (): Record<BillPaymentMode, number> => ({ CASH: 0, CARD: 0, UPI: 0, BANK: 0, CHEQUE: 0, FINANCE: 0 });

function emptyRow(month: string, showProfit: boolean): MonthRow {
  return {
    month, bills: 0, returns: 0, gross: 0, returnsValue: 0, net: 0, taxable: 0, gst: 0,
    ...(showProfit ? { cost: 0, profit: 0 } : {}),
    payments: zeroPayments(),
  };
}

export async function monthlySalesReport(actor: Actor, q: MonthlyQuery, now = new Date()): Promise<MonthlyReport> {
  assertCan(actor, "reports.view");
  const range = q.from && q.to ? { from: q.from, to: q.to } : presetRange((q.preset ?? "last12") as MonthPreset, now, q.year);
  if (range.from > range.to) throw new StockError("'From' month must be before 'To' month");
  const months = monthsBetween(range.from, range.to);
  if (months.length > MAX_MONTHS) throw new StockError(`Pick at most ${MAX_MONTHS} months`);

  if (q.godownId && q.godownId !== "ALL") assertGodownAccess(actor, q.godownId);
  const godownFilter = q.godownId && q.godownId !== "ALL" ? q.godownId : actor.godownIds ? { in: actor.godownIds } : undefined;
  const showProfit = actor.can("costs.view");

  const vouchers = await prisma.voucher.findMany({
    where: {
      userId: actor.accountId,
      kind: { in: ["SALE", "SALE_RETURN"] },
      status: { not: "CANCELLED" },
      date: { gte: `${range.from}-01`, lte: monthEndDate(range.to) },
      godownId: godownFilter,
    },
    select: { id: true, kind: true, date: true, subtotal: true, cgst: true, sgst: true, igst: true, total: true, costTotal: true },
  });

  const rows = new Map(months.map((m) => [m, emptyRow(m, showProfit)]));
  const monthOfSale = new Map<string, string>();
  for (const v of vouchers) {
    const month = v.date.slice(0, 7);
    const row = rows.get(month);
    if (!row) continue;
    const s = v.kind === "SALE_RETURN" ? -1 : 1;
    if (s > 0) {
      row.bills += 1;
      row.gross += v.total;
      monthOfSale.set(v.id, month);
    } else {
      row.returns += 1;
      row.returnsValue += v.total;
    }
    row.taxable += s * v.subtotal;
    row.gst += s * (v.cgst + v.sgst + v.igst);
    if (showProfit) {
      row.cost = (row.cost ?? 0) + s * v.costTotal;
    }
  }

  // How sales bills were paid at the counter (split payments). Returns are not refunds-by-mode, so they're left out.
  const fin = new Map<string, { financier: string; bills: Set<string>; amount: number }>();
  const saleIds = [...monthOfSale.keys()];
  for (let i = 0; i < saleIds.length; i += 500) {
    const splits = await prisma.voucherPayment.findMany({
      where: { voucherId: { in: saleIds.slice(i, i + 500) } },
      select: { voucherId: true, mode: true, amount: true, financier: true },
    });
    for (const p of splits) {
      const row = rows.get(monthOfSale.get(p.voucherId) ?? "");
      if (!row) continue;
      const mode = (BILL_PAYMENT_MODES as readonly string[]).includes(p.mode) ? (p.mode as BillPaymentMode) : "BANK";
      row.payments[mode] += p.amount;
      if (mode === "FINANCE") {
        const name = p.financier.trim() || "Unspecified";
        const f = fin.get(name.toLowerCase()) ?? { financier: name, bills: new Set<string>(), amount: 0 };
        f.bills.add(p.voucherId);
        f.amount += p.amount;
        fin.set(name.toLowerCase(), f);
      }
    }
  }

  const out = months.map((m) => {
    const r = rows.get(m)!;
    r.gross = r2(r.gross);
    r.returnsValue = r2(r.returnsValue);
    r.net = r2(r.gross - r.returnsValue);
    r.taxable = r2(r.taxable);
    r.gst = r2(r.gst);
    if (showProfit) {
      r.cost = r2(r.cost ?? 0);
      r.profit = r2(r.taxable - r.cost);
    }
    for (const k of BILL_PAYMENT_MODES) r.payments[k] = r2(r.payments[k]);
    return r;
  });

  const totals = emptyRow("", showProfit) as MonthRow;
  for (const r of out) {
    totals.bills += r.bills;
    totals.returns += r.returns;
    totals.gross += r.gross;
    totals.returnsValue += r.returnsValue;
    totals.net += r.net;
    totals.taxable += r.taxable;
    totals.gst += r.gst;
    if (showProfit) {
      totals.cost = (totals.cost ?? 0) + (r.cost ?? 0);
      totals.profit = (totals.profit ?? 0) + (r.profit ?? 0);
    }
    for (const k of BILL_PAYMENT_MODES) totals.payments[k] += r.payments[k];
  }
  const { month: _m, ...rest } = totals;
  const roundedTotals = {
    ...rest,
    gross: r2(rest.gross), returnsValue: r2(rest.returnsValue), net: r2(rest.net), taxable: r2(rest.taxable), gst: r2(rest.gst),
    ...(showProfit ? { cost: r2(rest.cost ?? 0), profit: r2(rest.profit ?? 0) } : {}),
    payments: Object.fromEntries(BILL_PAYMENT_MODES.map((k) => [k, r2(rest.payments[k])])) as Record<BillPaymentMode, number>,
  };

  return {
    from: range.from,
    to: range.to,
    showProfit,
    months: out,
    totals: roundedTotals,
    financiers: [...fin.values()]
      .map((f) => ({ financier: f.financier, bills: f.bills.size, amount: r2(f.amount) }))
      .sort((a, b) => b.amount - a.amount),
  };
}

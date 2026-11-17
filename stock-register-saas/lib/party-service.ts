// Parties (customers / suppliers), payments, expenses and the cash book.
// Every query is scoped by actor.accountId (the owner's User.id).
import type { Party } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "./db";
import { assertCan, type Actor } from "./actor";
import { logActivity } from "./activity";
import { StockError, todayISO } from "./engine";
import {
  BALANCE_SIGN,
  buildPartyLedger,
  partyBalance,
  reminderMessage,
  round2,
  summarizeCash,
  whatsappLink,
  type BalanceParts,
  type CashFlow,
  type CashSummary,
  type LedgerSource,
  type PartyLedgerRow,
} from "./money";
import type { expenseSchema, partySchema, paymentSchema } from "./party-schemas";
import { partySchema as partySchemaValue } from "./party-schemas";

export type PartyInput = z.infer<typeof partySchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;

export interface PartyRow {
  id: string;
  name: string;
  type: "CUSTOMER" | "SUPPLIER" | "BOTH";
  phone: string;
  email: string;
  gstin: string;
  state: string;
  address: string;
  openingBalance: number;
  /** + receivable (they owe us), − payable (we owe them) */
  balance: number;
  sales: number;
  purchases: number;
}

export interface PaymentRow {
  id: string;
  partyId: string;
  partyName: string;
  direction: "IN" | "OUT";
  amount: number;
  mode: string;
  date: string;
  reference: string;
  notes: string;
  voucherId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ExpenseRow {
  id: string;
  category: string;
  amount: number;
  mode: string;
  date: string;
  notes: string;
  createdBy: string;
  createdAt: string;
  /** Deletable only on the day it was recorded. */
  canDelete: boolean;
}

const BALANCE_KINDS = Object.keys(BALANCE_SIGN);
const KIND_LABEL: Record<string, string> = {
  SALE: "Sale",
  SALE_RETURN: "Sales return",
  PURCHASE: "Purchase",
  PURCHASE_RETURN: "Purchase return",
};

function emptyParts(openingBalance = 0): BalanceParts {
  return { openingBalance, sale: 0, saleReturn: 0, purchase: 0, purchaseReturn: 0, paidIn: 0, paidOut: 0 };
}

/** Balance parts for many parties with two grouped queries (no N+1). */
async function balanceParts(accountId: string, parties: { id: string; openingBalance: number }[]): Promise<Map<string, BalanceParts>> {
  const map = new Map(parties.map((p) => [p.id, emptyParts(p.openingBalance)]));
  if (parties.length === 0) return map;
  const ids = parties.map((p) => p.id);
  const [vouchers, payments] = await Promise.all([
    prisma.voucher.groupBy({
      by: ["partyId", "kind"],
      where: { userId: accountId, partyId: { in: ids }, kind: { in: BALANCE_KINDS }, status: { not: "CANCELLED" } },
      _sum: { total: true },
    }),
    prisma.partyPayment.groupBy({
      by: ["partyId", "direction"],
      where: { userId: accountId, partyId: { in: ids } },
      _sum: { amount: true },
    }),
  ]);
  for (const v of vouchers) {
    const parts = v.partyId ? map.get(v.partyId) : undefined;
    if (!parts) continue;
    const t = v._sum.total ?? 0;
    if (v.kind === "SALE") parts.sale += t;
    else if (v.kind === "SALE_RETURN") parts.saleReturn += t;
    else if (v.kind === "PURCHASE") parts.purchase += t;
    else if (v.kind === "PURCHASE_RETURN") parts.purchaseReturn += t;
  }
  for (const p of payments) {
    const parts = map.get(p.partyId);
    if (!parts) continue;
    if (p.direction === "IN") parts.paidIn += p._sum.amount ?? 0;
    else parts.paidOut += p._sum.amount ?? 0;
  }
  return map;
}

function toRow(p: Party, parts: BalanceParts): PartyRow {
  return {
    id: p.id,
    name: p.name,
    type: (p.type as PartyRow["type"]) ?? "CUSTOMER",
    phone: p.phone,
    email: p.email,
    gstin: p.gstin,
    state: p.state,
    address: p.address,
    openingBalance: p.openingBalance,
    balance: partyBalance(parts),
    sales: round2(parts.sale - parts.saleReturn),
    purchases: round2(parts.purchase - parts.purchaseReturn),
  };
}

export function assertCanViewParties(actor: Actor): void {
  if (!actor.can("parties.manage") && !actor.can("payments.manage")) assertCan(actor, "parties.manage");
}

async function getParty(accountId: string, id: string) {
  const p = await prisma.party.findFirst({ where: { id, userId: accountId } });
  if (!p) throw new StockError("Party not found", 404);
  return p;
}

// ---------------- Parties ----------------

export async function listParties(
  actor: Actor,
  q: { q?: string; type?: string; sort?: string },
): Promise<{ parties: PartyRow[]; totals: { receivable: number; payable: number } }> {
  assertCanViewParties(actor);
  const typeFilter =
    q.type === "CUSTOMER" ? { in: ["CUSTOMER", "BOTH"] } : q.type === "SUPPLIER" ? { in: ["SUPPLIER", "BOTH"] } : q.type === "BOTH" ? { in: ["BOTH"] } : undefined;
  const parties = await prisma.party.findMany({
    where: {
      userId: actor.accountId,
      type: typeFilter,
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { phone: { contains: q.q } }, { gstin: { contains: q.q.toUpperCase() } }] } : {}),
    },
    orderBy: { name: "asc" },
    take: 2000,
  });
  const parts = await balanceParts(actor.accountId, parties);
  const rows = parties.map((p) => toRow(p, parts.get(p.id) ?? emptyParts(p.openingBalance)));
  if (q.sort === "balance_desc") rows.sort((a, b) => b.balance - a.balance);
  if (q.sort === "balance_asc") rows.sort((a, b) => a.balance - b.balance);
  // Totals over every party of the account, not just the filtered page.
  let receivable = 0;
  let payable = 0;
  const all = q.q || typeFilter ? await prisma.party.findMany({ where: { userId: actor.accountId }, select: { id: true, openingBalance: true } }) : parties;
  const allParts = all === parties ? parts : await balanceParts(actor.accountId, all);
  for (const p of all) {
    const b = partyBalance(allParts.get(p.id) ?? emptyParts(p.openingBalance));
    if (b > 0) receivable += b;
    else payable -= b;
  }
  return { parties: rows, totals: { receivable: round2(receivable), payable: round2(payable) } };
}

export async function getPartyRow(actor: Actor, id: string): Promise<PartyRow & { reminderLink: string | null }> {
  assertCanViewParties(actor);
  const p = await getParty(actor.accountId, id);
  const parts = (await balanceParts(actor.accountId, [p])).get(p.id) ?? emptyParts(p.openingBalance);
  const row = toRow(p, parts);
  const business = actor.owner.businessName || actor.owner.name;
  return {
    ...row,
    reminderLink: row.balance > 0 && p.phone ? whatsappLink(p.phone, reminderMessage(p.name, row.balance, business)) : null,
  };
}

export async function createParty(actor: Actor, input: PartyInput): Promise<{ id: string }> {
  assertCan(actor, "parties.manage");
  if (await prisma.party.findFirst({ where: { userId: actor.accountId, name: input.name } }))
    throw new StockError(`A party named "${input.name}" already exists`, 409);
  const p = await prisma.party.create({ data: { userId: actor.accountId, ...input } });
  await logActivity(prisma, actor, "party.create", `${p.name} (${p.type.toLowerCase()})`);
  return { id: p.id };
}

export async function updateParty(actor: Actor, id: string, input: PartyInput): Promise<void> {
  assertCan(actor, "parties.manage");
  await getParty(actor.accountId, id);
  const clash = await prisma.party.findFirst({ where: { userId: actor.accountId, name: input.name, NOT: { id } } });
  if (clash) throw new StockError(`A party named "${input.name}" already exists`, 409);
  await prisma.party.update({ where: { id }, data: input });
  await logActivity(prisma, actor, "party.update", input.name);
}

export async function deleteParty(actor: Actor, id: string): Promise<void> {
  assertCan(actor, "parties.manage");
  const p = await getParty(actor.accountId, id);
  const [v, pay] = await Promise.all([
    prisma.voucher.count({ where: { userId: actor.accountId, partyId: id } }),
    prisma.partyPayment.count({ where: { userId: actor.accountId, partyId: id } }),
  ]);
  if (v || pay) throw new StockError("This party has bills or payments, so it can't be deleted.", 409);
  await prisma.party.delete({ where: { id } });
  await logActivity(prisma, actor, "party.delete", p.name);
}

export interface ImportResult {
  created: number;
  failed: number;
  errors: { row: number; error: string }[];
  /** One entry per input row; `line` is the row's own `line` field (file line) when sent, else its 1-based index. */
  results: { line: number; ok: boolean; error?: string }[];
}

/** Lenient column lookup: "Opening Balance", "opening_balance", "openingBalance" all match. */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const wanted = names.map(norm);
  for (const [k, v] of Object.entries(row)) if (wanted.includes(norm(k))) return v;
  return undefined;
}

function normType(v: unknown): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (s.startsWith("SUP") || s === "VENDOR") return "SUPPLIER";
  if (s === "BOTH") return "BOTH";
  return "CUSTOMER";
}

export async function importParties(actor: Actor, rows: Record<string, unknown>[]): Promise<ImportResult> {
  assertCan(actor, "parties.manage");
  const existing = new Set(
    (await prisma.party.findMany({ where: { userId: actor.accountId }, select: { name: true } })).map((p) => p.name.toLowerCase()),
  );
  const errors: ImportResult["errors"] = [];
  const results: ImportResult["results"] = [];
  const lineOf = (raw: Record<string, unknown>, i: number) => (typeof raw.line === "number" ? raw.line : i + 1);
  const data: (PartyInput & { userId: string })[] = [];
  rows.forEach((raw, i) => {
    const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
    const parsed = partySchemaValue.safeParse({
      name: str(pick(raw, "name", "party", "partyname")),
      type: normType(pick(raw, "type", "partytype")),
      phone: str(pick(raw, "phone", "mobile", "phoneno", "contact")),
      email: str(pick(raw, "email", "mail")),
      gstin: str(pick(raw, "gstin", "gst", "gstno")),
      state: str(pick(raw, "state")),
      address: str(pick(raw, "address")),
      openingBalance: pick(raw, "openingbalance", "opening", "balance") ?? 0,
    });
    if (!parsed.success) {
      const error = parsed.error.issues[0]?.message ?? "Invalid row";
      errors.push({ row: i + 1, error });
      results.push({ line: lineOf(raw, i), ok: false, error });
      return;
    }
    const key = parsed.data.name.toLowerCase();
    if (existing.has(key)) {
      const error = `"${parsed.data.name}" already exists`;
      errors.push({ row: i + 1, error });
      results.push({ line: lineOf(raw, i), ok: false, error });
      return;
    }
    existing.add(key);
    data.push({ userId: actor.accountId, ...parsed.data });
    results.push({ line: lineOf(raw, i), ok: true });
  });
  if (data.length) {
    await prisma.$transaction(async (tx) => {
      await tx.party.createMany({ data });
      await logActivity(tx, actor, "party.import", `${data.length} parties imported`);
    });
  }
  return { created: data.length, failed: errors.length, errors, results };
}

export async function partyLedger(
  actor: Actor,
  id: string,
  from?: string,
  to?: string,
): Promise<{ party: { id: string; name: string }; rows: PartyLedgerRow[]; closing: number }> {
  assertCanViewParties(actor);
  const p = await getParty(actor.accountId, id);
  const [vouchers, payments] = await Promise.all([
    prisma.voucher.findMany({
      where: { userId: actor.accountId, partyId: id, kind: { in: BALANCE_KINDS }, status: { not: "CANCELLED" } },
      select: { id: true, kind: true, number: true, date: true, total: true, notes: true, createdAt: true },
    }),
    prisma.partyPayment.findMany({
      where: { userId: actor.accountId, partyId: id },
      select: { id: true, direction: true, amount: true, mode: true, date: true, reference: true, notes: true, createdAt: true },
    }),
  ]);
  const sources: LedgerSource[] = [
    ...vouchers.map(
      (v): LedgerSource => ({
        id: v.id,
        date: v.date,
        createdAt: v.createdAt.toISOString(),
        kind: v.kind as LedgerSource["kind"],
        ref: `${KIND_LABEL[v.kind] ?? v.kind} #${v.number}`,
        amount: v.total,
        notes: v.notes,
      }),
    ),
    ...payments.map(
      (x): LedgerSource => ({
        id: x.id,
        date: x.date,
        createdAt: x.createdAt.toISOString(),
        kind: x.direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
        ref: `${x.direction === "IN" ? "Payment received" : "Payment made"} (${x.mode}${x.reference ? ` · ${x.reference}` : ""})`,
        amount: x.amount,
        notes: x.notes,
      }),
    ),
  ];
  const rows = buildPartyLedger(p.openingBalance, sources, from, to);
  const closing = rows.length ? rows[rows.length - 1].balance : round2(p.openingBalance);
  return { party: { id: p.id, name: p.name }, rows, closing };
}

// ---------------- Payments ----------------

export async function listPayments(
  actor: Actor,
  f: { partyId?: string; direction?: "IN" | "OUT"; mode?: string; from?: string; to?: string },
): Promise<PaymentRow[]> {
  assertCan(actor, "payments.manage");
  const rows = await prisma.partyPayment.findMany({
    where: {
      userId: actor.accountId,
      partyId: f.partyId || undefined,
      direction: f.direction || undefined,
      mode: f.mode || undefined,
      date: { gte: f.from || undefined, lte: f.to || undefined },
    },
    include: { party: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 1000,
  });
  return rows.map((r) => ({
    id: r.id,
    partyId: r.partyId,
    partyName: r.party.name,
    direction: r.direction as "IN" | "OUT",
    amount: r.amount,
    mode: r.mode,
    date: r.date,
    reference: r.reference,
    notes: r.notes,
    voucherId: r.voucherId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createPayment(actor: Actor, input: PaymentInput): Promise<{ id: string }> {
  assertCan(actor, "payments.manage");
  const party = await getParty(actor.accountId, input.partyId);
  if (input.voucherId) {
    const v = await prisma.voucher.findFirst({ where: { id: input.voucherId, userId: actor.accountId } });
    if (!v) throw new StockError("Bill not found", 404);
    if (v.partyId !== party.id) throw new StockError("That bill belongs to a different party", 400);
  }
  return prisma.$transaction(async (tx) => {
    const p = await tx.partyPayment.create({
      data: {
        userId: actor.accountId,
        partyId: party.id,
        direction: input.direction,
        amount: round2(input.amount),
        mode: input.mode,
        date: input.date,
        reference: input.reference,
        notes: input.notes,
        voucherId: input.voucherId || null,
        createdBy: actor.name,
      },
    });
    await logActivity(
      tx,
      actor,
      "payment.create",
      `${input.direction === "IN" ? "Received from" : "Paid to"} ${party.name}: ₹${round2(input.amount)} (${input.mode})`,
    );
    return { id: p.id };
  });
}

/** Payments are never deleted; a mistake is undone by an equal opposite entry. */
export async function reversePayment(actor: Actor, id: string): Promise<{ id: string }> {
  assertCan(actor, "payments.manage");
  const orig = await prisma.partyPayment.findFirst({ where: { id, userId: actor.accountId }, include: { party: true } });
  if (!orig) throw new StockError("Payment not found", 404);
  if (orig.notes.startsWith("Reversal of ")) throw new StockError("A reversal can't be reversed again", 400);
  if (await prisma.partyPayment.findFirst({ where: { userId: actor.accountId, notes: { startsWith: `Reversal of ${orig.id}` } } }))
    throw new StockError("This payment has already been reversed", 409);
  return prisma.$transaction(async (tx) => {
    const p = await tx.partyPayment.create({
      data: {
        userId: actor.accountId,
        partyId: orig.partyId,
        direction: orig.direction === "IN" ? "OUT" : "IN",
        amount: orig.amount,
        mode: orig.mode,
        date: todayISO(),
        reference: orig.reference,
        notes: `Reversal of ${orig.id} (${orig.date}, ₹${orig.amount})`,
        voucherId: orig.voucherId,
        createdBy: actor.name,
      },
    });
    await logActivity(tx, actor, "payment.reverse", `${orig.party.name}: ₹${orig.amount} (${orig.date})`);
    return { id: p.id };
  });
}

// ---------------- Expenses ----------------

export async function listExpenses(
  actor: Actor,
  f: { category?: string; from?: string; to?: string },
): Promise<{ expenses: ExpenseRow[]; byCategory: { category: string; total: number }[]; byMonth: { month: string; total: number }[]; total: number }> {
  assertCan(actor, "expenses.manage");
  const rows = await prisma.expense.findMany({
    where: { userId: actor.accountId, category: f.category || undefined, date: { gte: f.from || undefined, lte: f.to || undefined } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 2000,
  });
  const today = todayISO();
  const byCat = new Map<string, number>();
  const byMonth = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.amount);
    byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + r.amount);
    total += r.amount;
  }
  return {
    expenses: rows.map((r) => ({
      id: r.id,
      category: r.category,
      amount: r.amount,
      mode: r.mode,
      date: r.date,
      notes: r.notes,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      canDelete: todayISO(r.createdAt) === today,
    })),
    byCategory: [...byCat].map(([category, t]) => ({ category, total: round2(t) })).sort((a, b) => b.total - a.total),
    byMonth: [...byMonth].map(([month, t]) => ({ month, total: round2(t) })).sort((a, b) => b.month.localeCompare(a.month)),
    total: round2(total),
  };
}

export async function createExpense(actor: Actor, input: ExpenseInput): Promise<{ id: string }> {
  assertCan(actor, "expenses.manage");
  return prisma.$transaction(async (tx) => {
    const e = await tx.expense.create({
      data: { userId: actor.accountId, ...input, amount: round2(input.amount), createdBy: actor.name },
    });
    await logActivity(tx, actor, "expense.create", `${input.category}: ₹${round2(input.amount)} (${input.mode})`);
    return { id: e.id };
  });
}

/** Only on the day it was recorded, so past cash books don't silently change. */
export async function deleteExpense(actor: Actor, id: string): Promise<void> {
  assertCan(actor, "expenses.manage");
  const e = await prisma.expense.findFirst({ where: { id, userId: actor.accountId } });
  if (!e) throw new StockError("Expense not found", 404);
  if (todayISO(e.createdAt) !== todayISO())
    throw new StockError("Expenses can only be deleted on the day they were recorded.", 409);
  await prisma.expense.delete({ where: { id } });
  await logActivity(prisma, actor, "expense.delete", `${e.category}: ₹${e.amount} (${e.date})`);
}

// ---------------- Cash book ----------------

export async function cashbook(actor: Actor, from?: string, to?: string): Promise<CashSummary> {
  if (!actor.can("reports.view") && !actor.can("payments.manage")) assertCan(actor, "reports.view");
  const [payments, expenses] = await Promise.all([
    prisma.partyPayment.findMany({
      where: { userId: actor.accountId, date: { lte: to || undefined } },
      select: { date: true, mode: true, amount: true, direction: true },
    }),
    prisma.expense.findMany({ where: { userId: actor.accountId, date: { lte: to || undefined } }, select: { date: true, mode: true, amount: true } }),
  ]);
  const flows: CashFlow[] = [
    ...payments.map((p) => ({ date: p.date, mode: p.mode, amount: p.direction === "IN" ? p.amount : -p.amount })),
    ...expenses.map((e) => ({ date: e.date, mode: e.mode, amount: -e.amount })),
  ];
  return summarizeCash(flows, from, to);
}

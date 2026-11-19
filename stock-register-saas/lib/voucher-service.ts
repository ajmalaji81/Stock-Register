// Bills and trading documents (vouchers). Bills can be cancelled (which reverses their stock),
// never deleted. Only the OWNER may edit a saved bill of an EDITABLE_KINDS kind (sales invoices):
// the edit reverses the bill's net stock and applies the new lines, so the ledger stays append-only.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { assertCan, assertGodownAccess, canUseGodown, type Actor } from "./actor";
import { logActivity } from "./activity";
import { prisma } from "./db";
import { round3, StockError, todayISO } from "./engine";
import {
  calcTotals,
  CONVERSIONS,
  editBlockReason,
  EDITABLE_KINDS,
  formatNumber,
  netStockEffect,
  isInterState,
  isPurchaseSide,
  KIND_LABEL,
  KIND_PREFIX,
  lineDiscount,
  paymentError,
  r2,
  stockEffect,
  type BillPaymentInput,
  type BillPaymentMode,
  type VoucherKind,
} from "./gst";
import type { Permission } from "./permissions";
import { applyStockEntry, getGodown, type Tx } from "./stock-service";

// ---------- DTOs (also imported as types by the browser) ----------

export interface VoucherLineDTO {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  hsn: string;
  description: string;
  qty: number;
  rate: number;
  discountPct: number;
  /** ₹ discount on the line (before tax). */
  discountAmt: number;
  taxRate: number;
  taxable: number;
  tax: number;
  amount: number;
  /** Only for actors who can see costs. */
  costRate: number | null;
}

/** One payment taken at the counter with a sales invoice. */
export interface VoucherPaymentDTO {
  id: string;
  mode: BillPaymentMode;
  amount: number;
  reference: string;
  /** FINANCE only. */
  financier: string;
  paymentInfo: string;
  scheme: string;
}

export interface VoucherDTO {
  id: string;
  kind: VoucherKind;
  number: string;
  date: string;
  status: "OPEN" | "CONVERTED" | "CLOSED" | "CANCELLED";
  partyId: string | null;
  partyName: string;
  partyPhone: string;
  partyGstin: string;
  partyState: string;
  partyAddress: string;
  godownId: string;
  godownName: string;
  gstEnabled: boolean;
  interState: boolean;
  placeOfSupply: string;
  subtotal: number;
  discount: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
  /** Payments linked to this bill (received for sales, paid for purchases), incl. those taken at billing. */
  paid: number;
  /** How it was paid at the counter (split payment / finance). SALE only; [] otherwise. */
  payments: VoucherPaymentDTO[];
  /** Sum of `payments`. */
  paidAtBilling: number;
  /** What's still owed on a SALE / PURCHASE (0 for walk-in bills without recorded payments and other kinds). */
  balanceDue: number;
  notes: string;
  sourceId: string | null;
  sourceNumber: string | null;
  convertedTo: { id: string; kind: VoucherKind; number: string }[];
  createdBy: string;
  createdAt: string;
  /** Name of whoever last edited it (owner), or "" if never edited. */
  updatedBy: string;
  updatedAt: string | null;
  editCount: number;
  /** True when this bill's kind/status allows the owner to edit it. */
  editable: boolean;
  /** Only for actors who can see costs (else null). */
  costTotal: number | null;
  profit: number | null;
  /** Lets a customer open this sale-side document without logging in (null for purchase-side). */
  shareToken: string | null;
  lines?: VoucherLineDTO[];
}

export interface BusinessProfile {
  businessName: string;
  gstin: string;
  address: string;
  state: string;
  phone: string;
  invoicePrefix: string;
  invoiceTerms: string;
  bankDetails: string;
}

export interface VoucherCreateInput {
  kind: string;
  date: string;
  partyId?: string | null;
  godownId: string;
  gstEnabled: boolean;
  placeOfSupply: string;
  notes: string;
  lines: { itemId: string; description: string; qty: number; rate: number; discountPct: number; discountAmt?: number; taxRate: number }[];
  /** SALE only: payments taken at the counter (split / finance). */
  payments?: BillPaymentInput[];
  /** Legacy single payment. SALE: becomes one payments row. PURCHASE: paid to the supplier. */
  paidNow: number;
  paymentMode: BillPaymentMode;
}

// ---------- Permissions ----------

export function permissionFor(kind: VoucherKind): Permission {
  if (kind === "SALE" || kind === "SALE_RETURN") return "sales.create";
  if (kind === "PURCHASE" || kind === "PURCHASE_RETURN") return "purchases.create";
  return "documents.manage";
}

/** Can this actor see vouchers of this kind? Purchase-side documents reveal costs. */
export function canSeeKind(actor: Actor, kind: VoucherKind): boolean {
  if (isPurchaseSide(kind) && !actor.can("costs.view")) return false;
  return actor.can(permissionFor(kind)) || actor.can("reports.view");
}

// ---------- Public share links ----------

/** Unguessable token for a public, read-only view of one sale-side document. */
export function shareToken(voucherId: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set");
  return createHmac("sha256", secret).update(`voucher-share:${voucherId}`).digest("base64url").slice(0, 32);
}

function validShareToken(voucherId: string, token: string): boolean {
  const a = Buffer.from(shareToken(voucherId));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The document for a public share link, viewed with no access to costs. Null if the token is wrong. */
export async function getSharedVoucher(id: string, token: string): Promise<{ voucher: VoucherDTO; profile: BusinessProfile } | null> {
  if (!token || !validShareToken(id, token)) return null;
  const v = await prisma.voucher.findUnique({ where: { id }, include: { user: true } });
  if (!v || isPurchaseSide(v.kind as VoucherKind)) return null;
  const viewer: Actor = {
    accountId: v.userId,
    owner: v.user,
    actorId: "share-link",
    name: "Shared link",
    email: "",
    avatar: null,
    role: "SALES",
    isOwner: false,
    godownIds: null,
    can: (p): boolean => p !== "costs.view",
  };
  return { voucher: await getVoucher(viewer, id), profile: profileOf(v.user) };
}

// ---------- Helpers ----------

const voucherInclude = {
  party: true,
  godown: { select: { name: true } },
  payments: { select: { amount: true, mode: true, reference: true, notes: true, direction: true, createdAt: true } },
  splits: { orderBy: { createdAt: "asc" } },
  lines: { include: { item: { select: { name: true, unit: true, hsn: true } } } },
} satisfies Prisma.VoucherInclude;

/** Notes prefix that marks a PartyPayment as the party-ledger copy of a payment taken at billing. */
export const BILLING_NOTE = "[billing]";

/**
 * Was this PartyPayment created together with the bill (so it belongs to the bill's payments,
 * not to a later payment recorded from the Parties screen)? Older bills used "With <kind> <number>".
 */
export function isBillingMirror(p: { notes: string }, v: { kind: string; number: string }): boolean {
  return p.notes.startsWith(BILLING_NOTE) || p.notes === `With ${KIND_LABEL[v.kind as VoucherKind].toLowerCase()} ${v.number}`;
}

type VoucherRow = Prisma.VoucherGetPayload<{ include: typeof voucherInclude }>;

function toDTO(
  v: VoucherRow,
  actor: Actor,
  extra: { sourceNumber: string | null; sourceKind: VoucherKind | null; convertedTo: VoucherDTO["convertedTo"] },
  withLines: boolean,
): VoucherDTO {
  const showCosts = actor.can("costs.view");
  const kind = v.kind as VoucherKind;
  const sign = kind === "SALE_RETURN" || kind === "PURCHASE_RETURN" ? -1 : 1;
  const profit = kind === "SALE" || kind === "SALE_RETURN" ? r2(sign * (v.subtotal - v.costTotal)) : null;
  return {
    id: v.id,
    kind,
    number: v.number,
    date: v.date,
    status: v.status as VoucherDTO["status"],
    partyId: v.partyId,
    partyName: v.party?.name ?? "Cash",
    partyPhone: v.party?.phone ?? "",
    partyGstin: v.party?.gstin ?? "",
    partyState: v.party?.state ?? "",
    partyAddress: v.party?.address ?? "",
    godownId: v.godownId,
    godownName: v.godown.name,
    gstEnabled: v.gstEnabled,
    interState: v.interState,
    placeOfSupply: v.placeOfSupply,
    subtotal: v.subtotal,
    discount: v.discount,
    cgst: v.cgst,
    sgst: v.sgst,
    igst: v.igst,
    roundOff: v.roundOff,
    total: v.total,
    ...paymentFields(v, kind),
    notes: v.notes,
    sourceId: v.sourceId,
    sourceNumber: extra.sourceNumber,
    convertedTo: extra.convertedTo,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    updatedBy: v.updatedBy,
    updatedAt: v.updatedAt ? v.updatedAt.toISOString() : null,
    editCount: v.editCount,
    editable: editBlockReason(kind, v.status, extra.sourceKind) === null,
    costTotal: showCosts ? v.costTotal : null,
    profit: showCosts ? profit : null,
    shareToken: isPurchaseSide(kind) ? null : shareToken(v.id),
    lines: withLines
      ? v.lines.map((l) => ({
          id: l.id,
          itemId: l.itemId,
          itemName: l.item.name,
          unit: l.item.unit,
          hsn: l.item.hsn,
          description: l.description,
          qty: l.qty,
          rate: l.rate,
          discountPct: l.discountPct,
          discountAmt: l.discountAmt,
          taxRate: l.taxRate,
          taxable: l.taxable,
          tax: l.tax,
          amount: l.amount,
          costRate: showCosts ? l.costRate : null,
        }))
      : undefined,
  };
}

/** paid / payments / paidAtBilling / balanceDue for the DTO. */
function paymentFields(v: VoucherRow, kind: VoucherKind): Pick<VoucherDTO, "paid" | "payments" | "paidAtBilling" | "balanceDue"> {
  let payments: VoucherPaymentDTO[] = v.splits.map((p) => ({
    id: p.id,
    mode: p.mode as BillPaymentMode,
    amount: p.amount,
    reference: p.reference,
    financier: p.financier,
    paymentInfo: p.paymentInfo,
    scheme: p.scheme,
  }));
  // Bills saved before split payments existed: show the single payment taken at billing.
  if (payments.length === 0 && kind === "SALE") {
    payments = v.payments
      .filter((p) => isBillingMirror(p, v))
      .map((p, i) => ({ id: `legacy-${i}`, mode: p.mode as BillPaymentMode, amount: p.amount, reference: "", financier: "", paymentInfo: "", scheme: "" }));
  }
  const paidAtBilling = r2(payments.reduce((a, p) => a + p.amount, 0));
  const paid = v.partyId ? r2(v.payments.reduce((a, p) => a + p.amount, 0)) : paidAtBilling;
  const tracksBalance = (kind === "SALE" || kind === "PURCHASE") && v.status !== "CANCELLED" && (!!v.partyId || paidAtBilling > 0);
  return { paid, payments, paidAtBilling, balanceDue: tracksBalance ? Math.max(0, r2(v.total - paid)) : 0 };
}

async function nextNumber(tx: Tx, accountId: string, kind: VoucherKind, prefix: string): Promise<string> {
  const all = await tx.voucher.findMany({ where: { userId: accountId, kind, number: { startsWith: `${prefix}-` } }, select: { number: true } });
  const max = all.reduce((m, v) => {
    const n = Number(v.number.slice(prefix.length + 1));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return formatNumber(prefix, max + 1);
}

function prefixFor(kind: VoucherKind, invoicePrefix: string): string {
  return kind === "SALE" ? invoicePrefix.trim() || "INV" : KIND_PREFIX[kind];
}

interface CreateOptions {
  sourceId?: string;
  /** Challan -> sale: the goods already left with the challan. */
  skipStock?: boolean;
}

type LinesIn = VoucherCreateInput["lines"];

/** Validate party / items and compute all totals server-side. Shared by create and edit. */
async function prepare(tx: Tx, actor: Actor, kind: VoucherKind, input: Omit<VoucherCreateInput, "kind" | "paidNow" | "paymentMode" | "payments">) {
  const accountId = actor.accountId;
  const owner = await tx.user.findUniqueOrThrow({ where: { id: accountId } });
  await getGodown(tx, accountId, input.godownId);

  const party = input.partyId ? await tx.party.findFirst({ where: { id: input.partyId, userId: accountId } }) : null;
  if (input.partyId && !party) throw new StockError("Party not found", 404);
  if ((kind === "PURCHASE" || kind === "PURCHASE_RETURN" || kind === "PURCHASE_ORDER") && !party)
    throw new StockError("Choose the supplier for this bill");
  if (kind === "SALE_RETURN" && !party) throw new StockError("Choose the customer returning the goods");

  const ids = [...new Set(input.lines.map((l) => l.itemId))];
  const items = await tx.item.findMany({ where: { id: { in: ids }, userId: accountId } });
  if (items.length !== ids.length) throw new StockError("One of the items was not found", 404);
  const byId = new Map(items.map((i) => [i.id, i]));

  const placeOfSupply = input.placeOfSupply || party?.state || owner.state;
  const interState = input.gstEnabled && isInterState(owner.state, placeOfSupply);
  const lines = input.lines.map((l) => ({ ...l, qty: round3(l.qty), discountAmt: r2(l.discountAmt ?? 0) }));
  for (const l of lines) {
    const gross = r2(l.qty * l.rate);
    if (l.discountAmt > gross + 0.005)
      throw new StockError(`Discount on ${byId.get(l.itemId)?.name ?? "an item"} (₹${l.discountAmt}) is more than the line value (₹${gross})`);
  }
  const t = calcTotals(lines, { gstEnabled: input.gstEnabled, interState });
  const costTotal = r2(lines.reduce((a, l) => a + l.qty * (byId.get(l.itemId)?.purchasePrice ?? 0), 0));
  return { owner, party, byId, placeOfSupply, interState, lines, t, costTotal };
}

function lineRows(input: { gstEnabled: boolean }, lines: LinesIn, t: ReturnType<typeof calcTotals>, byId: Map<string, { purchasePrice: number }>) {
  return lines.map((l, i) => ({
    itemId: l.itemId,
    description: l.description,
    qty: l.qty,
    rate: l.rate,
    discountPct: t.lines[i].discountPct,
    discountAmt: t.lines[i].discount,
    taxRate: input.gstEnabled ? l.taxRate : 0,
    taxable: t.lines[i].taxable,
    tax: t.lines[i].tax,
    amount: t.lines[i].amount,
    costRate: byId.get(l.itemId)?.purchasePrice ?? 0,
  }));
}

async function createInTx(tx: Tx, actor: Actor, input: VoucherCreateInput, opts: CreateOptions = {}): Promise<string> {
  const kind = input.kind as VoucherKind;
  assertCan(actor, permissionFor(kind));
  assertGodownAccess(actor, input.godownId);
  const accountId = actor.accountId;
  const { owner, party, byId, placeOfSupply, interState, lines, t, costTotal } = await prepare(tx, actor, kind, input);

  // Payments taken at the counter (SALE): split across modes, incl. FINANCE. The old single
  // paidNow/paymentMode is accepted as one row.
  let billPayments = (input.payments ?? []).map(cleanPayment);
  const legacyPaid = r2(input.paidNow || 0);
  if (billPayments.length === 0 && kind === "SALE" && legacyPaid > 0) billPayments = [cleanPayment({ mode: input.paymentMode, amount: legacyPaid })];
  if (billPayments.length > 0) {
    if (kind !== "SALE") throw new StockError("Payments at billing can only be taken on sales invoices");
    const err = paymentError(billPayments, { total: t.total, hasParty: !!party });
    if (err) throw new StockError(err);
  }
  // Purchases keep the single "paid now" to the supplier.
  const paidNow = kind === "PURCHASE" ? legacyPaid : 0;
  if (legacyPaid > 0 && kind !== "SALE" && kind !== "PURCHASE") throw new StockError("Payments can only be recorded with sales or purchase bills");
  if (paidNow > 0) {
    if (!party) throw new StockError("Choose a party to record a payment against");
    if (paidNow > t.total + 0.005) throw new StockError("Amount paid can't be more than the bill total");
  }

  const number = await nextNumber(tx, accountId, kind, prefixFor(kind, owner.invoicePrefix));
  const v = await tx.voucher.create({
    data: {
      userId: accountId,
      kind,
      number,
      date: input.date,
      partyId: party?.id ?? null,
      godownId: input.godownId,
      gstEnabled: input.gstEnabled,
      interState,
      placeOfSupply,
      subtotal: t.subtotal,
      discount: t.discount,
      cgst: t.cgst,
      sgst: t.sgst,
      igst: t.igst,
      roundOff: t.roundOff,
      total: t.total,
      costTotal,
      paidAtBilling: r2(billPayments.reduce((a, p) => a + p.amount, 0)),
      notes: input.notes,
      sourceId: opts.sourceId ?? null,
      createdBy: actor.name,
      createdById: actor.actorId,
      lines: { create: lineRows(input, lines, t, byId) },
    },
  });

  const effect = opts.skipStock ? null : stockEffect(kind);
  if (effect) {
    for (const l of lines) {
      await applyStockEntry(tx, actor, {
        itemId: l.itemId,
        godownId: input.godownId,
        type: effect,
        qty: l.qty,
        rate: l.rate,
        party: party?.name ?? "Cash",
        remarks: number,
        date: input.date,
        refType: "VOUCHER",
        refId: v.id,
      });
    }
  }

  await saveBillPayments(tx, actor, v, party, billPayments, input.date);

  if (paidNow > 0 && party) {
    await tx.partyPayment.create({
      data: {
        userId: accountId,
        partyId: party.id,
        direction: kind === "SALE" ? "IN" : "OUT",
        amount: paidNow,
        mode: input.paymentMode,
        date: input.date,
        reference: number,
        notes: `With ${KIND_LABEL[kind].toLowerCase()} ${number}`,
        voucherId: v.id,
        createdBy: actor.name,
      },
    });
  }

  await logActivity(tx, actor, "voucher.create", `${KIND_LABEL[kind]} ${number} · ${party?.name ?? "Cash"} · ₹${t.total}`);
  return v.id;
}

function cleanPayment(p: BillPaymentInput): BillPaymentInput {
  const finance = p.mode === "FINANCE";
  return {
    mode: p.mode,
    amount: r2(p.amount),
    reference: (p.reference ?? "").trim(),
    financier: finance ? (p.financier ?? "").trim() : "",
    paymentInfo: finance ? (p.paymentInfo ?? "").trim() : "",
    scheme: finance ? (p.scheme ?? "").trim() : "",
  };
}

/**
 * Store the counter payments of a sale. With a party, each row is also posted to the party ledger
 * (PartyPayment, direction IN, notes start with BILLING_NOTE) so balances and the cash book stay right.
 */
async function saveBillPayments(
  tx: Tx,
  actor: Actor,
  v: { id: string; number: string },
  party: { id: string } | null,
  rows: BillPaymentInput[],
  date: string,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.voucherPayment.createMany({
    data: rows.map((r) => ({
      voucherId: v.id,
      mode: r.mode,
      amount: r.amount,
      reference: r.reference ?? "",
      financier: r.financier ?? "",
      paymentInfo: r.paymentInfo ?? "",
      scheme: r.scheme ?? "",
    })),
  });
  if (!party) return;
  for (const r of rows) {
    const finance = r.mode === "FINANCE" ? ` · ${r.financier} · ${r.scheme}` : "";
    await tx.partyPayment.create({
      data: {
        userId: actor.accountId,
        partyId: party.id,
        direction: "IN",
        amount: r.amount,
        mode: r.mode,
        date,
        reference: (r.mode === "FINANCE" ? r.paymentInfo : r.reference) || v.number,
        notes: `${BILLING_NOTE} ${v.number}${finance}`.slice(0, 300),
        voucherId: v.id,
        createdBy: actor.name,
      },
    });
  }
}

async function withNumberRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Two bills numbered at the same moment: try once more with the next number.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return fn();
    throw e;
  }
}

// ---------- Public API ----------

export async function createVoucher(actor: Actor, input: VoucherCreateInput): Promise<VoucherDTO> {
  const id = await withNumberRetry(() => prisma.$transaction((tx) => createInTx(tx, actor, input)));
  return getVoucher(actor, id);
}

export async function getVoucher(actor: Actor, id: string): Promise<VoucherDTO> {
  const v = await prisma.voucher.findFirst({ where: { id, userId: actor.accountId }, include: voucherInclude });
  if (!v || !canUseGodown(actor, v.godownId) || !canSeeKind(actor, v.kind as VoucherKind)) throw new StockError("Bill not found", 404);
  const [source, children] = await Promise.all([
    v.sourceId ? prisma.voucher.findFirst({ where: { id: v.sourceId, userId: actor.accountId }, select: { number: true, kind: true } }) : null,
    prisma.voucher.findMany({ where: { userId: actor.accountId, sourceId: v.id }, select: { id: true, kind: true, number: true } }),
  ]);
  return toDTO(
    v,
    actor,
    { sourceNumber: source?.number ?? null, sourceKind: (source?.kind as VoucherKind | undefined) ?? null, convertedTo: children.map((c) => ({ ...c, kind: c.kind as VoucherKind })) },
    true,
  );
}

export interface VoucherFilter {
  kind?: string;
  partyId?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
}

export async function listVouchers(actor: Actor, f: VoucherFilter): Promise<VoucherDTO[]> {
  const requested = (f.kind ? f.kind.split(",") : []).filter(Boolean) as VoucherKind[];
  const kinds = (requested.length ? requested : (Object.keys(KIND_LABEL) as VoucherKind[])).filter((k) => canSeeKind(actor, k));
  if (kinds.length === 0) return [];
  const q = f.q?.trim();
  const rows = await prisma.voucher.findMany({
    where: {
      userId: actor.accountId,
      kind: { in: kinds },
      partyId: f.partyId || undefined,
      status: f.status || undefined,
      date: { gte: f.from || undefined, lte: f.to || undefined },
      godownId: actor.godownIds ? { in: actor.godownIds } : undefined,
      ...(q ? { OR: [{ number: { contains: q } }, { party: { name: { contains: q } } }, { notes: { contains: q } }] } : {}),
    },
    include: voucherInclude,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  const ids = rows.map((r) => r.id);
  const children = ids.length
    ? await prisma.voucher.findMany({ where: { userId: actor.accountId, sourceId: { in: ids } }, select: { id: true, kind: true, number: true, sourceId: true } })
    : [];
  const sourceIds = rows.map((r) => r.sourceId).filter((x): x is string => !!x);
  const sources = sourceIds.length
    ? await prisma.voucher.findMany({ where: { userId: actor.accountId, id: { in: sourceIds } }, select: { id: true, number: true, kind: true } })
    : [];
  const srcMap = new Map(sources.map((s) => [s.id, s]));
  return rows.map((r) =>
    toDTO(
      r,
      actor,
      {
        sourceNumber: r.sourceId ? srcMap.get(r.sourceId)?.number ?? null : null,
        sourceKind: r.sourceId ? ((srcMap.get(r.sourceId)?.kind as VoucherKind | undefined) ?? null) : null,
        convertedTo: children.filter((c) => c.sourceId === r.id).map((c) => ({ id: c.id, kind: c.kind as VoucherKind, number: c.number })),
      },
      false,
    ),
  );
}

export async function cancelVoucher(actor: Actor, id: string): Promise<VoucherDTO> {
  await prisma.$transaction(async (tx) => {
    const v = await tx.voucher.findFirst({ where: { id, userId: actor.accountId } });
    if (!v || !canUseGodown(actor, v.godownId)) throw new StockError("Bill not found", 404);
    const kind = v.kind as VoucherKind;
    assertCan(actor, permissionFor(kind));
    if (v.status === "CANCELLED") throw new StockError("This is already cancelled");
    if (v.status === "CONVERTED") throw new StockError("This was converted into another bill. Cancel that bill first.", 409);

    // Reverse exactly the stock this voucher has moved, net of any edits (a challan-converted sale moved none).
    const party = v.partyId ? await tx.party.findFirst({ where: { id: v.partyId }, select: { name: true } }) : null;
    await reverseNetStock(tx, actor, v.id, { remarks: `Cancelled ${v.number}`, refType: "VOUCHER_CANCEL", party: party?.name ?? "Cash" });
    // Payments recorded together with this bill go away with it.
    const linked = await tx.partyPayment.deleteMany({ where: { userId: actor.accountId, voucherId: v.id } });
    await tx.voucherPayment.deleteMany({ where: { voucherId: v.id } });
    await tx.voucher.update({ where: { id: v.id }, data: { status: "CANCELLED", paidAtBilling: 0 } });
    // A cancelled conversion re-opens its quotation / order / challan.
    if (v.sourceId) await tx.voucher.updateMany({ where: { id: v.sourceId, userId: actor.accountId, status: "CONVERTED" }, data: { status: "OPEN" } });
    await logActivity(tx, actor, "voucher.cancel", `${KIND_LABEL[kind]} ${v.number}${linked.count ? ` (removed ${linked.count} linked payment)` : ""}`);
  });
  return getVoucher(actor, id);
}

/** Ledger entries that make up a voucher's current stock effect. */
const STOCK_REF_TYPES = ["VOUCHER", "VOUCHER_EDIT"];

/** Put back whatever stock this voucher currently has moved (per item + godown). */
async function reverseNetStock(tx: Tx, actor: Actor, voucherId: string, o: { remarks: string; refType: string; party: string }): Promise<void> {
  const entries = await tx.ledgerEntry.findMany({
    where: { userId: actor.accountId, refId: voucherId, refType: { in: STOCK_REF_TYPES } },
    select: { itemId: true, godownId: true, qtyIn: true, qtyOut: true, rate: true },
  });
  const rateOf = new Map(entries.map((e) => [`${e.itemId}|${e.godownId}`, e.rate]));
  for (const n of netStockEffect(entries)) {
    await applyStockEntry(tx, actor, {
      itemId: n.itemId,
      godownId: n.godownId,
      type: n.qty < 0 ? "IN" : "OUT",
      qty: Math.abs(n.qty),
      rate: rateOf.get(`${n.itemId}|${n.godownId}`) ?? 0,
      party: o.party,
      remarks: o.remarks,
      date: todayISO(),
      refType: o.refType,
      refId: voucherId,
    });
  }
}

export type VoucherEditInput = Omit<VoucherCreateInput, "kind" | "paidNow" | "paymentMode" | "payments"> & {
  /** Omitted = keep the bill's payments; an array (even empty) replaces those taken at billing. */
  payments?: BillPaymentInput[];
};

/**
 * Edit a saved bill. OWNER ONLY. Reverses the bill's current stock, applies the new lines,
 * recomputes totals and keeps the same number — all in one transaction.
 */
export async function editVoucher(actor: Actor, id: string, input: VoucherEditInput): Promise<VoucherDTO> {
  if (!actor.isOwner) throw new StockError("Only the owner can edit invoices.", 403, "FORBIDDEN");
  await prisma.$transaction(async (tx) => {
    const v = await tx.voucher.findFirst({
      where: { id, userId: actor.accountId },
      include: { lines: true, splits: true, payments: { select: { id: true, amount: true, partyId: true, notes: true } } },
    });
    if (!v) throw new StockError("Bill not found", 404);
    const kind = v.kind as VoucherKind;
    const source = v.sourceId ? await tx.voucher.findFirst({ where: { id: v.sourceId, userId: actor.accountId }, select: { kind: true } }) : null;
    const blocked = editBlockReason(kind, v.status, (source?.kind as VoucherKind | undefined) ?? null);
    if (blocked) throw new StockError(blocked, 409);
    assertGodownAccess(actor, input.godownId);

    const { party, byId, placeOfSupply, interState, lines, t, costTotal } = await prepare(tx, actor, kind, input);

    const partyChanged = (party?.id ?? null) !== v.partyId;
    const mirrors = v.payments.filter((p) => isBillingMirror(p, v));
    const later = v.payments.filter((p) => !isBillingMirror(p, v));
    const laterPaid = r2(later.reduce((a, p) => a + p.amount, 0));
    const newPayments = input.payments ? input.payments.map(cleanPayment) : null;
    if (newPayments) {
      // Payments taken at billing are replaced; ones recorded later from the Parties screen stay.
      if (laterPaid > 0 && partyChanged)
        throw new StockError("This bill has a payment recorded later against its party, so the party can't be changed. Reverse that payment first.", 409);
      const err = paymentError(newPayments, { total: t.total, hasParty: !!party, otherPaid: laterPaid });
      if (err) throw new StockError(err, 400);
    } else {
      const paid = r2(v.payments.reduce((a, p) => a + p.amount, 0));
      if ((paid > 0 || v.splits.length > 0) && partyChanged)
        throw new StockError("This bill has a payment recorded against its party, so the party can't be changed. Reverse the payment first.", 409);
      if (paid > t.total + 0.005)
        throw new StockError(`₹${paid} has already been received against this bill, so the new total (₹${t.total}) can't be lower than that.`, 409);
      if (!party && v.splits.length > 0) {
        const err = paymentError(v.splits.map((p) => ({ ...p, mode: p.mode as BillPaymentMode })), { total: t.total, hasParty: false });
        if (err) throw new StockError(`${err} Update the payments together with the items.`, 400);
      }
    }

    // 1) put back what the bill took out, 2) take out the new lines. Insufficient stock fails the whole edit.
    const effect = stockEffect(kind);
    if (effect) {
      await reverseNetStock(tx, actor, v.id, { remarks: `Edit ${v.number}: reversal`, refType: "VOUCHER_EDIT", party: party?.name ?? "Cash" });
      for (const l of lines) {
        await applyStockEntry(tx, actor, {
          itemId: l.itemId,
          godownId: input.godownId,
          type: effect,
          qty: l.qty,
          rate: l.rate,
          party: party?.name ?? "Cash",
          remarks: `Edit ${v.number}`,
          date: input.date,
          refType: "VOUCHER_EDIT",
          refId: v.id,
        });
      }
    }

    await tx.voucherLine.deleteMany({ where: { voucherId: v.id } });
    await tx.voucher.update({
      where: { id: v.id },
      data: {
        date: input.date,
        partyId: party?.id ?? null,
        godownId: input.godownId,
        gstEnabled: input.gstEnabled,
        interState,
        placeOfSupply,
        subtotal: t.subtotal,
        discount: t.discount,
        cgst: t.cgst,
        sgst: t.sgst,
        igst: t.igst,
        roundOff: t.roundOff,
        total: t.total,
        costTotal,
        ...(newPayments ? { paidAtBilling: r2(newPayments.reduce((a, p) => a + p.amount, 0)) } : {}),
        notes: input.notes,
        updatedBy: actor.name,
        updatedById: actor.actorId,
        updatedAt: new Date(),
        editCount: { increment: 1 },
        lines: { create: lineRows(input, lines, t, byId) },
      },
    });
    if (newPayments) {
      await tx.voucherPayment.deleteMany({ where: { voucherId: v.id } });
      if (mirrors.length) await tx.partyPayment.deleteMany({ where: { id: { in: mirrors.map((m) => m.id) } } });
      await saveBillPayments(tx, actor, v, party, newPayments, input.date);
    }
    await logActivity(
      tx,
      actor,
      "voucher.edit",
      `${KIND_LABEL[kind]} ${v.number}: ₹${v.total} → ₹${t.total}, ${v.lines.length} → ${lines.length} line(s)${(party?.id ?? null) !== v.partyId ? `, party → ${party?.name ?? "Cash"}` : ""}`,
    );
  });
  return getVoucher(actor, id);
}

export { EDITABLE_KINDS };

export async function convertVoucher(actor: Actor, id: string, to: VoucherKind, date?: string): Promise<VoucherDTO> {
  const newId = await withNumberRetry(() =>
    prisma.$transaction(async (tx) => {
      const src = await tx.voucher.findFirst({ where: { id, userId: actor.accountId }, include: { lines: true } });
      if (!src || !canUseGodown(actor, src.godownId)) throw new StockError("Document not found", 404);
      const from = src.kind as VoucherKind;
      assertCan(actor, permissionFor(from));
      if (!(CONVERSIONS[from] ?? []).includes(to)) throw new StockError(`A ${KIND_LABEL[from].toLowerCase()} can't be converted to a ${KIND_LABEL[to].toLowerCase()}`);
      if (src.status !== "OPEN") throw new StockError(`This ${KIND_LABEL[from].toLowerCase()} is ${src.status.toLowerCase()}`, 409);
      const created = await createInTx(
        tx,
        actor,
        {
          kind: to,
          date: date ?? todayISO(),
          partyId: src.partyId,
          godownId: src.godownId,
          gstEnabled: src.gstEnabled,
          placeOfSupply: src.placeOfSupply,
          notes: src.notes,
          lines: src.lines.map((l) => ({ itemId: l.itemId, description: l.description, qty: l.qty, rate: l.rate, discountPct: l.discountPct, discountAmt: l.discountAmt, taxRate: l.taxRate })),
          payments: [],
          paidNow: 0,
          paymentMode: "CASH",
        },
        { sourceId: src.id, skipStock: from === "CHALLAN" && to === "SALE" },
      );
      await tx.voucher.update({ where: { id: src.id }, data: { status: "CONVERTED" } });
      await logActivity(tx, actor, "voucher.convert", `${KIND_LABEL[from]} ${src.number} → ${KIND_LABEL[to]}`);
      return created;
    }),
  );
  return getVoucher(actor, newId);
}

// ---------- Business profile ----------

export function profileOf(u: BusinessProfile): BusinessProfile {
  return {
    businessName: u.businessName,
    gstin: u.gstin,
    address: u.address,
    state: u.state,
    phone: u.phone,
    invoicePrefix: u.invoicePrefix,
    invoiceTerms: u.invoiceTerms,
    bankDetails: u.bankDetails,
  };
}

export async function updateProfile(actor: Actor, p: BusinessProfile): Promise<BusinessProfile> {
  const u = await prisma.user.update({ where: { id: actor.accountId }, data: { ...p, invoicePrefix: p.invoicePrefix || "INV" } });
  await logActivity(prisma, actor, "settings.update", "Business profile");
  return profileOf(u);
}

// ---------- Reports ----------

export interface SalesReport {
  side: "sales" | "purchases";
  from: string | null;
  to: string | null;
  register: { id: string; date: string; number: string; kind: VoucherKind; party: string; gstin: string; taxable: number; cgst: number; sgst: number; igst: number; total: number }[];
  byRate: { rate: number; taxable: number; cgst: number; sgst: number; igst: number }[];
  byHsn: { hsn: string; description: string; qty: number; taxable: number; tax: number }[];
  b2b: { count: number; taxable: number; tax: number; total: number };
  b2c: { count: number; taxable: number; tax: number; total: number };
  totals: { taxable: number; cgst: number; sgst: number; igst: number; total: number };
  /** Null when the actor can't see costs or for purchases. */
  profit: {
    total: number;
    byBill: { id: string; number: string; date: string; party: string; sales: number; cost: number; profit: number }[];
    byItem: { itemId: string; name: string; qty: number; sales: number; cost: number; profit: number }[];
    byParty: { party: string; sales: number; cost: number; profit: number }[];
  } | null;
}

export async function salesReport(actor: Actor, opts: { side: "sales" | "purchases"; from?: string; to?: string }): Promise<SalesReport> {
  assertCan(actor, "reports.view");
  if (opts.side === "purchases") assertCan(actor, "costs.view");
  const kinds: VoucherKind[] = opts.side === "sales" ? ["SALE", "SALE_RETURN"] : ["PURCHASE", "PURCHASE_RETURN"];
  const rows = await prisma.voucher.findMany({
    where: {
      userId: actor.accountId,
      kind: { in: kinds },
      status: { not: "CANCELLED" },
      date: { gte: opts.from || undefined, lte: opts.to || undefined },
      godownId: actor.godownIds ? { in: actor.godownIds } : undefined,
    },
    include: { party: { select: { name: true, gstin: true } }, lines: { include: { item: { select: { name: true, hsn: true } } } } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  const rate = new Map<number, SalesReport["byRate"][number]>();
  const hsn = new Map<string, SalesReport["byHsn"][number]>();
  const b2b = { count: 0, taxable: 0, tax: 0, total: 0 };
  const b2c = { count: 0, taxable: 0, tax: 0, total: 0 };
  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
  const byItem = new Map<string, { itemId: string; name: string; qty: number; sales: number; cost: number; profit: number }>();
  const byParty = new Map<string, { party: string; sales: number; cost: number; profit: number }>();
  const byBill: NonNullable<SalesReport["profit"]>["byBill"] = [];

  const register = rows.map((v) => {
    const s = v.kind.endsWith("_RETURN") ? -1 : 1;
    const party = v.party?.name ?? "Cash";
    const bucket = v.party?.gstin ? b2b : b2c;
    bucket.count++;
    bucket.taxable += s * v.subtotal;
    bucket.tax += s * (v.cgst + v.sgst + v.igst);
    bucket.total += s * v.total;
    totals.taxable += s * v.subtotal;
    totals.cgst += s * v.cgst;
    totals.sgst += s * v.sgst;
    totals.igst += s * v.igst;
    totals.total += s * v.total;
    let billCost = 0;
    for (const l of v.lines) {
      const rr = rate.get(l.taxRate) ?? { rate: l.taxRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      rr.taxable += s * l.taxable;
      if (v.interState) rr.igst += s * l.tax;
      else {
        rr.cgst += (s * l.tax) / 2;
        rr.sgst += (s * l.tax) / 2;
      }
      rate.set(l.taxRate, rr);
      const key = l.item.hsn || "—";
      const hh = hsn.get(key) ?? { hsn: key, description: l.item.name, qty: 0, taxable: 0, tax: 0 };
      hh.qty += s * l.qty;
      hh.taxable += s * l.taxable;
      hh.tax += s * l.tax;
      hsn.set(key, hh);
      const cost = s * l.qty * l.costRate;
      billCost += cost;
      const it = byItem.get(l.itemId) ?? { itemId: l.itemId, name: l.item.name, qty: 0, sales: 0, cost: 0, profit: 0 };
      it.qty += s * l.qty;
      it.sales += s * l.taxable;
      it.cost += cost;
      byItem.set(l.itemId, it);
    }
    const pp = byParty.get(party) ?? { party, sales: 0, cost: 0, profit: 0 };
    pp.sales += s * v.subtotal;
    pp.cost += billCost;
    byParty.set(party, pp);
    byBill.push({ id: v.id, number: v.number, date: v.date, party, sales: r2(s * v.subtotal), cost: r2(billCost), profit: r2(s * v.subtotal - billCost) });
    return {
      id: v.id, date: v.date, number: v.number, kind: v.kind as VoucherKind, party, gstin: v.party?.gstin ?? "",
      taxable: r2(s * v.subtotal), cgst: r2(s * v.cgst), sgst: r2(s * v.sgst), igst: r2(s * v.igst), total: r2(s * v.total),
    };
  });

  const round = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? (k === "qty" ? round3(v) : r2(v)) : v])) as T;
  const showProfit = opts.side === "sales" && actor.can("costs.view");
  const finish = <T extends { sales: number; cost: number; profit: number }>(x: T): T => round({ ...x, profit: x.sales - x.cost });

  return {
    side: opts.side,
    from: opts.from ?? null,
    to: opts.to ?? null,
    register,
    byRate: [...rate.values()].sort((a, b) => a.rate - b.rate).map(round),
    byHsn: [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn)).map(round),
    b2b: round(b2b),
    b2c: round(b2c),
    totals: round(totals),
    profit: showProfit
      ? {
          total: r2(byBill.reduce((a, b) => a + b.profit, 0)),
          byBill,
          byItem: [...byItem.values()].map(finish).sort((a, b) => b.profit - a.profit),
          byParty: [...byParty.values()].map(finish).sort((a, b) => b.profit - a.profit),
        }
      : null,
  };
}

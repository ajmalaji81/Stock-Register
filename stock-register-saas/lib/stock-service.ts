// Server-side register. Every stock change goes through here, inside a transaction.
// Stock is changed with conditional atomic updates (`quantity >= qty` for removals), so two
// requests at the same moment can never push a godown below zero.
//
// Everything is scoped by `actor.accountId` (the owner's User.id); staff act on the owner's data.
import { Prisma } from "@prisma/client";
import { actorInfo, assertGodownAccess, canUseGodown, type Actor } from "./actor";
import { logActivity } from "./activity";
import { prisma } from "./db";
import { assertCanRemove, assertWithinLimit, round3, StockError, todayISO } from "./engine";
import { effectivePlan, limitsFor } from "./plans";
import type { EntryType, Item, ItemInput, LedgerEntry, LedgerFilter, MovementInput, TransferInput, Workspace } from "./types";

export type Tx = Prisma.TransactionClient;

export async function loadWorkspace(actor: Actor): Promise<Workspace> {
  const id = actor.accountId;
  const [godowns, items] = await Promise.all([
    prisma.godown.findMany({ where: { userId: id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
    prisma.item.findMany({ where: { userId: id }, orderBy: { name: "asc" }, include: { stocks: true } }),
  ]);
  const visible = godowns.filter((g) => canUseGodown(actor, g.id));
  const showCosts = actor.can("costs.view");
  const owner = actor.owner;
  return {
    mode: "live",
    actor: actorInfo(actor),
    user: { name: owner.name, email: owner.email, plan: effectivePlan(owner), trialEndsAt: owner.trialEndsAt?.toISOString() ?? null },
    limits: limitsFor(owner),
    godowns: visible,
    items: items.map(
      (i): Item => ({
        id: i.id,
        name: i.name,
        sku: i.sku,
        category: i.category,
        unit: i.unit,
        purchasePrice: showCosts ? i.purchasePrice : 0,
        salePrice: i.salePrice,
        minStockAlert: i.minStockAlert,
        hsn: i.hsn,
        gstRate: i.gstRate,
        stock: Object.fromEntries(i.stocks.filter((s) => canUseGodown(actor, s.godownId)).map((s) => [s.godownId, round3(s.quantity)])),
      }),
    ),
  };
}

export async function getItem(tx: Tx, accountId: string, id: string) {
  const item = await tx.item.findFirst({ where: { id, userId: accountId } });
  if (!item) throw new StockError("Item not found", 404);
  return item;
}

export async function getGodown(tx: Tx, accountId: string, id: string) {
  const g = await tx.godown.findFirst({ where: { id, userId: accountId } });
  if (!g) throw new StockError("Godown not found", 404);
  return g;
}

/** Atomically add (delta > 0) or remove (delta < 0) stock; returns the new godown and item balances. */
async function changeStock(
  tx: Tx,
  item: { id: string; name: string },
  godown: { id: string; name: string },
  delta: number,
): Promise<{ balance: number; itemBalance: number }> {
  if (delta < 0) {
    const res = await tx.stock.updateMany({
      where: { itemId: item.id, godownId: godown.id, quantity: { gte: -delta - 0.0005 } },
      data: { quantity: { increment: delta } },
    });
    if (res.count === 0) {
      const row = await tx.stock.findUnique({ where: { itemId_godownId: { itemId: item.id, godownId: godown.id } } });
      assertCanRemove(row?.quantity ?? 0, -delta, item.name, godown.name);
      throw new StockError("Stock changed, please try again", 409);
    }
  } else {
    await tx.stock.upsert({
      where: { itemId_godownId: { itemId: item.id, godownId: godown.id } },
      create: { itemId: item.id, godownId: godown.id, quantity: delta },
      update: { quantity: { increment: delta } },
    });
  }
  // Keep stored quantities to 3 decimals so float noise never builds up.
  const row = await tx.stock.findUniqueOrThrow({ where: { itemId_godownId: { itemId: item.id, godownId: godown.id } } });
  const balance = Math.max(0, round3(row.quantity));
  if (balance !== row.quantity) {
    await tx.stock.update({ where: { itemId_godownId: { itemId: item.id, godownId: godown.id } }, data: { quantity: balance } });
  }
  const agg = await tx.stock.aggregate({ where: { itemId: item.id }, _sum: { quantity: true } });
  return { balance, itemBalance: round3(agg._sum.quantity ?? 0) };
}

export interface StockEntryInput {
  itemId: string;
  godownId: string;
  /** IN / OUT for bills and manual entries, ADJUSTMENT for corrections, OPENING for opening stock. */
  type: "IN" | "OUT" | "ADJUSTMENT" | "OPENING";
  /** Positive quantity for IN / OUT / OPENING. Signed (non-zero) for ADJUSTMENT. */
  qty: number;
  rate: number;
  party: string;
  remarks: string;
  date: string;
  /** e.g. "VOUCHER" + voucher id when a bill moves stock. */
  refType?: string;
  refId?: string;
}

/**
 * THE way to change stock from other modules (bills, returns, adjustments).
 * Must be called inside `prisma.$transaction`. Checks the item/godown belong to the account and
 * that the actor may use the godown; refuses to go below zero; writes the ledger entry.
 */
export async function applyStockEntry(tx: Tx, actor: Actor, e: StockEntryInput): Promise<{ balance: number; itemBalance: number }> {
  assertGodownAccess(actor, e.godownId);
  const item = await getItem(tx, actor.accountId, e.itemId);
  const godown = await getGodown(tx, actor.accountId, e.godownId);
  const qty = round3(e.qty);
  if (qty === 0 || (e.type !== "ADJUSTMENT" && qty < 0)) throw new StockError("Quantity must be more than 0");
  const delta = e.type === "OUT" ? -qty : qty;
  const { balance, itemBalance } = await changeStock(tx, item, godown, delta);
  await tx.ledgerEntry.create({
    data: {
      userId: actor.accountId, itemId: item.id, godownId: godown.id, type: e.type,
      qtyIn: delta > 0 ? Math.abs(qty) : 0, qtyOut: delta < 0 ? Math.abs(qty) : 0,
      balance, itemBalance, rate: e.rate, party: e.party, remarks: e.remarks, date: e.date,
      refType: e.refType ?? null, refId: e.refId ?? null, actorName: actor.name,
    },
  });
  return { balance, itemBalance };
}

export async function createItem(actor: Actor, input: ItemInput): Promise<void> {
  const id = actor.accountId;
  await prisma.$transaction(async (tx) => {
    assertWithinLimit(await tx.item.count({ where: { userId: id } }), limitsFor(actor.owner).maxItems, "items");
    const item = await tx.item.create({
      data: {
        userId: id,
        name: input.name,
        sku: input.sku,
        category: input.category,
        unit: input.unit,
        purchasePrice: input.purchasePrice,
        salePrice: input.salePrice,
        minStockAlert: input.minStockAlert,
        hsn: input.hsn ?? "",
        gstRate: input.gstRate ?? 0,
      },
    });
    const godowns = await tx.godown.findMany({ where: { userId: id } });
    await tx.stock.createMany({ data: godowns.map((g) => ({ itemId: item.id, godownId: g.id, quantity: 0 })) });
    const qty = round3(input.openingQty ?? 0);
    if (qty > 0) {
      await applyStockEntry(tx, actor, {
        itemId: item.id, godownId: input.openingGodownId || godowns[0]?.id || "", type: "OPENING", qty,
        rate: input.purchasePrice, party: "Opening stock", remarks: "", date: todayISO(),
      });
    }
    await logActivity(tx, actor, "item.create", `${item.name} (${item.sku})${qty > 0 ? `, opening ${qty} ${item.unit}` : ""}`);
  });
}

export async function updateItem(actor: Actor, id: string, input: ItemInput): Promise<void> {
  const keepCost = !actor.can("costs.view"); // staff who can't see costs can't change them either
  const res = await prisma.item.updateMany({
    where: { id, userId: actor.accountId },
    data: {
      name: input.name,
      sku: input.sku,
      category: input.category,
      unit: input.unit,
      ...(keepCost ? {} : { purchasePrice: input.purchasePrice }),
      salePrice: input.salePrice,
      minStockAlert: input.minStockAlert,
      hsn: input.hsn ?? "",
      gstRate: input.gstRate ?? 0,
    },
  });
  if (res.count === 0) throw new StockError("Item not found", 404);
  await logActivity(prisma, actor, "item.update", `${input.name} (${input.sku})`);
}

export async function deleteItem(actor: Actor, id: string): Promise<void> {
  const item = await prisma.item.findFirst({ where: { id, userId: actor.accountId } });
  if (!item) throw new StockError("Item not found", 404);
  if (await prisma.voucherLine.count({ where: { itemId: id } }))
    throw new StockError("This item is used on bills or documents, so it can't be deleted.", 409);
  await prisma.item.delete({ where: { id } });
  await logActivity(prisma, actor, "item.delete", `${item.name} (${item.sku})`);
}

export async function recordMovement(actor: Actor, input: MovementInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await applyStockEntry(tx, actor, { ...input, type: input.type });
    const item = await getItem(tx, actor.accountId, input.itemId);
    await logActivity(tx, actor, `stock.${input.type.toLowerCase()}`, `${item.name}: ${input.qty} ${item.unit}${input.party ? `, ${input.party}` : ""}`);
  });
}

export async function transferStock(actor: Actor, input: TransferInput): Promise<void> {
  if (input.fromGodownId === input.toGodownId) throw new StockError("Choose two different godowns");
  assertGodownAccess(actor, input.fromGodownId);
  assertGodownAccess(actor, input.toGodownId);
  const userId = actor.accountId;
  await prisma.$transaction(async (tx) => {
    const item = await getItem(tx, userId, input.itemId);
    const from = await getGodown(tx, userId, input.fromGodownId);
    const to = await getGodown(tx, userId, input.toGodownId);
    const qty = round3(input.qty);
    const transferId = crypto.randomUUID();
    // Move both sides first so each entry records the item total after the whole transfer.
    const out = await changeStock(tx, item, from, -qty);
    const inn = await changeStock(tx, item, to, qty);
    await tx.ledgerEntry.create({
      data: {
        userId, itemId: item.id, godownId: from.id, type: "TRANSFER_OUT", qtyOut: qty, balance: out.balance,
        itemBalance: inn.itemBalance, rate: item.purchasePrice, party: `To ${to.name}`, remarks: input.remarks,
        date: input.date, transferId, actorName: actor.name,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        userId, itemId: item.id, godownId: to.id, type: "TRANSFER_IN", qtyIn: qty, balance: inn.balance,
        itemBalance: inn.itemBalance, rate: item.purchasePrice, party: `From ${from.name}`, remarks: input.remarks,
        date: input.date, transferId, actorName: actor.name,
      },
    });
    await logActivity(tx, actor, "stock.transfer", `${item.name}: ${qty} ${item.unit} ${from.name} → ${to.name}`);
  });
}

export async function createGodown(actor: Actor, name: string): Promise<void> {
  const id = actor.accountId;
  await prisma.$transaction(async (tx) => {
    assertWithinLimit(await tx.godown.count({ where: { userId: id } }), limitsFor(actor.owner).maxGodowns, "godowns");
    const g = await tx.godown.create({ data: { userId: id, name } });
    const items = await tx.item.findMany({ where: { userId: id }, select: { id: true } });
    await tx.stock.createMany({ data: items.map((i) => ({ itemId: i.id, godownId: g.id, quantity: 0 })) });
    await logActivity(tx, actor, "godown.create", name);
  });
}

export async function renameGodown(actor: Actor, id: string, name: string): Promise<void> {
  const res = await prisma.godown.updateMany({ where: { id, userId: actor.accountId }, data: { name } });
  if (res.count === 0) throw new StockError("Godown not found", 404);
  await logActivity(prisma, actor, "godown.rename", name);
}

export async function deleteGodown(actor: Actor, id: string): Promise<void> {
  const userId = actor.accountId;
  await prisma.$transaction(async (tx) => {
    const g = await getGodown(tx, userId, id);
    if ((await tx.godown.count({ where: { userId } })) <= 1) throw new StockError("You need at least one godown");
    if ((await tx.ledgerEntry.count({ where: { userId, godownId: id } })) || (await tx.voucher.count({ where: { userId, godownId: id } })))
      throw new StockError("This godown has ledger entries or bills. Godowns with history can't be deleted.", 409);
    await tx.godown.delete({ where: { id } });
    await logActivity(tx, actor, "godown.delete", g.name);
  });
}

const LEDGER_MAX = 2000;

export async function listLedger(actor: Actor, f: LedgerFilter): Promise<LedgerEntry[]> {
  if (f.godownId && f.godownId !== "ALL") assertGodownAccess(actor, f.godownId);
  const rows = await prisma.ledgerEntry.findMany({
    where: {
      userId: actor.accountId,
      itemId: f.itemId || undefined,
      godownId: f.godownId && f.godownId !== "ALL" ? f.godownId : actor.godownIds ? { in: actor.godownIds } : undefined,
      type: f.type || undefined,
      date: { gte: f.from || undefined, lte: f.to || undefined },
    },
    include: { item: { select: { name: true, unit: true } }, godown: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LEDGER_MAX,
  });
  const showCosts = actor.can("costs.view");
  return rows.reverse().map((r) => ({
    id: r.id,
    itemId: r.itemId,
    itemName: r.item.name,
    unit: r.item.unit,
    godownId: r.godownId,
    godownName: r.godown.name,
    type: r.type as EntryType,
    qtyIn: r.qtyIn,
    qtyOut: r.qtyOut,
    balance: r.balance,
    itemBalance: r.itemBalance,
    // Purchase-side rates are costs; hide them from roles that can't see costs.
    rate: showCosts || r.type === "OUT" ? r.rate : 0,
    party: r.party,
    remarks: r.remarks,
    date: r.date,
    createdAt: r.createdAt.toISOString(),
    transferId: r.transferId,
    refType: r.refType,
    refId: r.refId,
    actorName: r.actorName,
  }));
}

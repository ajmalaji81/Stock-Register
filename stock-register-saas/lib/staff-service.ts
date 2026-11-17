// Staff accounts, stock adjustments and the activity timeline.
import bcrypt from "bcryptjs";
import type { z } from "zod";
import type { Actor } from "./actor";
import { assertGodownAccess } from "./actor";
import { logActivity } from "./activity";
import { prisma } from "./db";
import { round3, StockError } from "./engine";
import { roleLabel, type StaffRole } from "./permissions";
import { effectivePlan } from "./plans";
import { applyStockEntry, getGodown, getItem } from "./stock-service";
import type { activityQuerySchema, adjustmentSchema, staffCreateSchema, staffUpdateSchema } from "./staff-schemas";

export interface StaffDTO {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  godownIds: string[];
  active: boolean;
  createdAt: string;
  avatar: string | null;
}

function parseIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toDTO(s: { id: string; name: string; email: string; role: string; godownIds: string; active: boolean; createdAt: Date; avatar: string | null }): StaffDTO {
  return { id: s.id, name: s.name, email: s.email, role: s.role as StaffRole, godownIds: parseIds(s.godownIds), active: s.active, createdAt: s.createdAt.toISOString(), avatar: s.avatar };
}

/** Staff logins are a Pro feature (Lifetime Pro or the 90-day trial). */
export function assertStaffPlan(actor: Actor): void {
  if (effectivePlan(actor.owner) === "FREE")
    throw new StockError("Staff logins are a Pro feature. Get Lifetime Pro to add staff.", 402, "LIMIT");
}

/** Only real godowns of this account; [] means all godowns. */
async function cleanGodownIds(accountId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = await prisma.godown.findMany({ where: { userId: accountId, id: { in: ids } }, select: { id: true } });
  if (found.length !== new Set(ids).size) throw new StockError("One of the selected godowns doesn't exist", 400);
  return found.map((g) => g.id);
}

export async function listStaff(actor: Actor): Promise<StaffDTO[]> {
  const rows = await prisma.staffMember.findMany({ where: { userId: actor.accountId }, orderBy: { createdAt: "asc" } });
  return rows.map(toDTO);
}

export async function createStaff(actor: Actor, input: z.infer<typeof staffCreateSchema>): Promise<StaffDTO> {
  assertStaffPlan(actor);
  const [user, staff] = await Promise.all([
    prisma.user.findUnique({ where: { email: input.email } }),
    prisma.staffMember.findUnique({ where: { email: input.email } }),
  ]);
  if (user || staff) throw new StockError("This email already has a GodownBook login. Use a different email.", 409);
  const godownIds = await cleanGodownIds(actor.accountId, input.godownIds);
  const row = await prisma.staffMember.create({
    data: {
      userId: actor.accountId,
      name: input.name,
      email: input.email,
      passwordHash: await bcrypt.hash(input.password, 12),
      role: input.role,
      godownIds: JSON.stringify(godownIds),
    },
  });
  await logActivity(prisma, actor, "staff.create", `${row.name} (${roleLabel(input.role)})`);
  return toDTO(row);
}

export async function updateStaff(actor: Actor, id: string, input: z.infer<typeof staffUpdateSchema>): Promise<StaffDTO> {
  const existing = await prisma.staffMember.findFirst({ where: { id, userId: actor.accountId } });
  if (!existing) throw new StockError("Staff member not found", 404);
  // Re-activating someone counts as adding a login.
  if (input.active === true && !existing.active) assertStaffPlan(actor);
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.role !== undefined) data.role = input.role;
  if (input.active !== undefined) data.active = input.active;
  if (input.godownIds !== undefined) data.godownIds = JSON.stringify(await cleanGodownIds(actor.accountId, input.godownIds));
  if (input.password !== undefined) data.passwordHash = await bcrypt.hash(input.password, 12);
  const row = await prisma.staffMember.update({ where: { id }, data });
  const changes = [
    input.role !== undefined && input.role !== existing.role ? `role → ${roleLabel(input.role)}` : "",
    input.active !== undefined && input.active !== existing.active ? (input.active ? "activated" : "deactivated") : "",
    input.godownIds !== undefined ? "godown access changed" : "",
    input.password !== undefined ? "password reset" : "",
    input.name !== undefined && input.name !== existing.name ? `renamed to ${input.name}` : "",
  ].filter(Boolean);
  await logActivity(prisma, actor, "staff.update", `${row.name}${changes.length ? `: ${changes.join(", ")}` : ""}`);
  return toDTO(row);
}

export async function deleteStaff(actor: Actor, id: string): Promise<void> {
  const existing = await prisma.staffMember.findFirst({ where: { id, userId: actor.accountId } });
  if (!existing) throw new StockError("Staff member not found", 404);
  await prisma.staffMember.delete({ where: { id } });
  await logActivity(prisma, actor, "staff.delete", existing.name);
}

// ---------------- Adjustments ----------------

export async function recordAdjustment(actor: Actor, input: z.infer<typeof adjustmentSchema>): Promise<{ delta: number; balance: number }> {
  assertGodownAccess(actor, input.godownId);
  return prisma.$transaction(async (tx) => {
    const item = await getItem(tx, actor.accountId, input.itemId);
    const godown = await getGodown(tx, actor.accountId, input.godownId);
    const row = await tx.stock.findUnique({ where: { itemId_godownId: { itemId: item.id, godownId: godown.id } } });
    const current = round3(row?.quantity ?? 0);
    const delta = round3(input.newQty !== undefined ? input.newQty - current : (input.delta ?? 0));
    if (delta === 0) throw new StockError("No change: the count matches the current stock.");
    const { balance } = await applyStockEntry(tx, actor, {
      itemId: item.id, godownId: godown.id, type: "ADJUSTMENT", qty: delta,
      rate: item.purchasePrice, party: "Stock adjustment", remarks: input.reason, date: input.date,
    });
    await logActivity(tx, actor, "stock.adjust", `${item.name} @ ${godown.name}: ${delta > 0 ? "+" : ""}${delta} ${item.unit} (${input.reason})`);
    return { delta, balance };
  });
}

export async function listAdjustments(actor: Actor, limit = 100) {
  const rows = await prisma.ledgerEntry.findMany({
    where: { userId: actor.accountId, type: "ADJUSTMENT", ...(actor.godownIds ? { godownId: { in: actor.godownIds } } : {}) },
    include: { item: { select: { name: true, unit: true } }, godown: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    itemName: r.item.name,
    unit: r.item.unit,
    godownName: r.godown.name,
    delta: r.qtyIn > 0 ? r.qtyIn : -r.qtyOut,
    balance: r.balance,
    reason: r.remarks,
    actorName: r.actorName,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------------- Activity ----------------

export async function listActivity(actor: Actor, q: z.infer<typeof activityQuerySchema>) {
  // Dates are entered as local calendar days; widen by a day each side and let the UI show local time.
  const where = {
    userId: actor.accountId,
    actorId: q.actorId || undefined,
    action: q.action ? { startsWith: q.action } : undefined,
    createdAt: {
      gte: q.from ? new Date(`${q.from}T00:00:00`) : undefined,
      lte: q.to ? new Date(`${q.to}T23:59:59.999`) : undefined,
    },
  };
  const [total, rows, actors] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.size, take: q.size }),
    prisma.activityLog.groupBy({ by: ["actorId", "actorName"], where: { userId: actor.accountId } }),
  ]);
  return {
    total,
    page: q.page,
    size: q.size,
    items: rows.map((r) => ({ id: r.id, actorId: r.actorId, actorName: r.actorName, action: r.action, detail: r.detail, createdAt: r.createdAt.toISOString() })),
    actors: actors.map((a) => ({ id: a.actorId, name: a.actorName })),
  };
}

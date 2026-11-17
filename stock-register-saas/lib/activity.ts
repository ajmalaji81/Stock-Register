import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { Actor } from "./actor";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Record what someone did, for the owner's activity timeline.
 * Pass the transaction client when inside a transaction so the log rolls back with the change.
 * action: "<area>.<verb>", e.g. "item.create", "voucher.create", "payment.create", "staff.update".
 */
export async function logActivity(db: Db, actor: Actor, action: string, detail = ""): Promise<void> {
  await db.activityLog.create({
    data: { userId: actor.accountId, actorId: actor.actorId, actorName: actor.name, action, detail: detail.slice(0, 500) },
  });
}

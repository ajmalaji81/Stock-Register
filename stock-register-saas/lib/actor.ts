// The signed-in person and the business account they act on.
// EVERY server query on business data must use `actor.accountId` (the owner's User.id).
import type { User } from "@prisma/client";
import { readSession } from "./auth";
import { sessionIsStale } from "./password-reset";
import { prisma } from "./db";
import { StockError } from "./engine";
import { PERMISSIONS, roleCan, type Permission, type Role } from "./permissions";
import type { ActorInfo } from "./types";

export interface Actor {
  /** Owner's User.id — scope every query with this. */
  accountId: string;
  /** The owner's User row (plan, trial, business profile). */
  owner: User;
  /** User.id (owner) or StaffMember.id (staff). */
  actorId: string;
  name: string;
  email: string;
  /** Profile picture (data: URL) or null. */
  avatar: string | null;
  role: Role;
  isOwner: boolean;
  /** Godowns this actor may use; null = all. */
  godownIds: string[] | null;
  can(p: Permission): boolean;
}

function parseIds(json: string): string[] | null {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** The signed-in actor, or null. Inactive staff, and sessions from before a password reset, count as signed out. */
export async function currentActor(): Promise<Actor | null> {
  const s = await readSession();
  if (!s) return null;
  if (s.kind === "owner") {
    const owner = await prisma.user.findUnique({ where: { id: s.id } });
    if (!owner || sessionIsStale(s.iat, owner.passwordChangedAt)) return null;
    return {
      accountId: owner.id, owner, actorId: owner.id, name: owner.name, email: owner.email, avatar: owner.avatar,
      role: "OWNER", isOwner: true, godownIds: null, can: () => true,
    };
  }
  const staff = await prisma.staffMember.findUnique({ where: { id: s.id }, include: { user: true } });
  if (!staff || !staff.active || sessionIsStale(s.iat, staff.passwordChangedAt)) return null;
  const role = staff.role as Role;
  return {
    accountId: staff.userId, owner: staff.user, actorId: staff.id, name: staff.name, email: staff.email, avatar: staff.avatar,
    role, isOwner: false, godownIds: parseIds(staff.godownIds), can: (p) => roleCan(role, p),
  };
}

/** For API routes: the signed-in actor, or a 401. */
export async function requireActor(): Promise<Actor> {
  const a = await currentActor();
  if (!a) throw new StockError("Please log in", 401);
  return a;
}

/** For API routes: the actor, if they have this permission; else 403. */
export async function requirePermission(p: Permission): Promise<Actor> {
  const a = await requireActor();
  assertCan(a, p);
  return a;
}

export function assertCan(a: Actor, p: Permission): void {
  if (!a.can(p)) throw new StockError("Your role doesn't allow this. Ask the owner for access.", 403, "FORBIDDEN");
}

export function canUseGodown(a: Actor, godownId: string): boolean {
  return a.godownIds === null || a.godownIds.includes(godownId);
}

/** Throws 403 if this staff member isn't assigned to the godown. */
export function assertGodownAccess(a: Actor, godownId: string): void {
  if (!canUseGodown(a, godownId)) throw new StockError("You don't have access to this godown.", 403, "FORBIDDEN");
}

/** Safe-to-send summary for the browser. */
export function actorInfo(a: Actor): ActorInfo {
  return {
    name: a.name,
    role: a.role,
    isOwner: a.isOwner,
    permissions: PERMISSIONS.filter((p) => a.can(p)),
    godownIds: a.godownIds,
    avatar: a.avatar,
  };
}

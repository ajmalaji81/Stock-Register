import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE = "sr_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Who is signed in: the business owner, or one of the owner's staff members. */
export type SessionKind = "owner" | "staff";
export interface Session {
  kind: SessionKind;
  id: string; // User.id for owners, StaffMember.id for staff
}

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET must be set (32+ characters)");
  return new TextEncoder().encode(s);
}

export async function startSession(id: string, kind: SessionKind = "owner"): Promise<void> {
  const token = await new SignJWT({ kind })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function readSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return { id: payload.sub, kind: payload.kind === "staff" ? "staff" : "owner" };
  } catch {
    return null;
  }
}

/**
 * The business account's owner User for the current session (owner or staff), or null.
 * For pages that only need plan / name. API routes should use requireActor() from lib/actor.ts.
 */
export async function currentUser() {
  const s = await readSession();
  if (!s) return null;
  const { prisma } = await import("./db");
  if (s.kind === "owner") return prisma.user.findUnique({ where: { id: s.id } });
  const staff = await prisma.staffMember.findUnique({ where: { id: s.id }, include: { user: true } });
  return staff?.active ? staff.user : null;
}

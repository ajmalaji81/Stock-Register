import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { startSession } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { loginSchema } from "@/lib/schemas";
import { StockError } from "@/lib/engine";

// Compared against when the email doesn't exist, so response time doesn't reveal accounts.
const DUMMY_HASH = "$2b$12$M8/sqyLj07IdzSTFHBLiTuf541Qp95uEDwdzH3sSwBppxZio2Mfze";

/** One login form for owners and staff. Emails are unique across both tables (enforced at creation). */
export async function POST(req: Request) {
  return handle(async () => {
    const { email, password } = loginSchema.parse(await req.json());
    const [user, staff] = await Promise.all([
      prisma.user.findUnique({ where: { email } }),
      prisma.staffMember.findUnique({ where: { email } }),
    ]);
    // An email that exists in both tables (shouldn't happen) is refused rather than guessed.
    const account = user && !staff ? { id: user.id, hash: user.passwordHash, kind: "owner" as const } : null;
    const member = staff && !user && staff.active ? { id: staff.id, hash: staff.passwordHash, kind: "staff" as const } : null;
    const target = account ?? member;
    const ok = await bcrypt.compare(password, target?.hash ?? DUMMY_HASH);
    if (!target || !ok) throw new StockError("Wrong email or password", 401);
    await startSession(target.id, target.kind);
    return json({ ok: true, kind: target.kind });
  });
}

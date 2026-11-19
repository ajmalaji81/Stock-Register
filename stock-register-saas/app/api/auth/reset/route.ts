import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { StockError } from "@/lib/engine";
import { handle, json } from "@/lib/http";
import { hashToken, tokenProblem, TOKEN_PROBLEM_MESSAGE } from "@/lib/password-reset";

const schema = z.object({
  token: z.string().min(10, TOKEN_PROBLEM_MESSAGE.invalid).max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

/** Check a reset token without using it (the page calls this to show "expired" before the user types). */
export async function GET(req: Request) {
  return handle(async () => {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    const row = token ? await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } }) : null;
    const problem = tokenProblem(row);
    return json({ ok: !problem, error: problem ? TOKEN_PROBLEM_MESSAGE[problem] : undefined });
  });
}

/** Set a new password with a valid, unused, unexpired token. Signs the person out everywhere. */
export async function POST(req: Request) {
  return handle(async () => {
    const { token, password } = schema.parse(await req.json());
    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    const problem = tokenProblem(row);
    if (problem || !row) throw new StockError(TOKEN_PROBLEM_MESSAGE[problem ?? "invalid"], 400, "TOKEN");

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      // Claim the token atomically so two simultaneous submits can't both use it.
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) throw new StockError(TOKEN_PROBLEM_MESSAGE.used, 400, "TOKEN");
      // Any other outstanding links for this person stop working too.
      await tx.passwordResetToken.updateMany({ where: { subjectId: row.subjectId, usedAt: null }, data: { usedAt: now } });

      if (row.kind === "owner") {
        const u = await tx.user.update({ where: { id: row.subjectId }, data: { passwordHash, passwordChangedAt: now } });
        await tx.activityLog.create({
          data: { userId: u.id, actorId: u.id, actorName: u.name, action: "auth.password_reset", detail: "Password reset by email link" },
        });
      } else {
        const s = await tx.staffMember.update({ where: { id: row.subjectId }, data: { passwordHash, passwordChangedAt: now } });
        await tx.activityLog.create({
          data: { userId: s.userId, actorId: s.id, actorName: s.name, action: "auth.password_reset", detail: "Password reset by email link" },
        });
      }
    });
    return json({ ok: true });
  });
}

import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { sendMail, smtpConfigured } from "@/lib/mailer";
import { newResetToken, resetEmail, resetExpiry, resetLink, RESET_MAX_PER_HOUR } from "@/lib/password-reset";

const schema = z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email") });

/** Same answer whether or not the account exists, so this can't be used to discover accounts. */
const GENERIC = "If an account exists for that email, we've sent a link to reset the password. Check your inbox and spam folder.";

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

/** Find the account, create a token and send the email. Runs after the response is sent. */
async function issueReset(email: string): Promise<void> {
  const owner = await prisma.user.findUnique({ where: { email } });
  const staff = owner ? null : await prisma.staffMember.findUnique({ where: { email } });
  const subject = owner
    ? { kind: "owner" as const, id: owner.id, name: owner.name }
    : staff && staff.active
      ? { kind: "staff" as const, id: staff.id, name: staff.name }
      : null;
  if (!subject) return;

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.passwordResetToken.count({ where: { subjectId: subject.id, createdAt: { gt: hourAgo } } });
  if (recent >= RESET_MAX_PER_HOUR) {
    console.warn(`Password reset: rate limit reached for ${subject.kind} ${subject.id}`);
    return;
  }

  const { token, hash } = newResetToken();
  await prisma.passwordResetToken.create({
    data: { tokenHash: hash, kind: subject.kind, subjectId: subject.id, email, expiresAt: resetExpiry() },
  });
  const link = resetLink(appUrl(), token);

  if (!smtpConfigured()) {
    if (process.env.NODE_ENV !== "production") console.log(`[password reset] SMTP not configured. Reset link for ${email}: ${link}`);
    else console.error("Password reset requested but SMTP is not configured (set SMTP_USER / SMTP_PASS).");
    return;
  }
  try {
    await sendMail({ to: email, ...resetEmail(subject.name, link) });
  } catch (err) {
    console.error("Password reset email failed:", (err as Error).message);
  }
}

export async function POST(req: Request) {
  return handle(async () => {
    const { email } = schema.parse(await req.json());
    // Do the lookup and sending after responding, so response time doesn't reveal whether the account exists.
    after(() => issueReset(email).catch((e) => console.error("Password reset failed:", (e as Error).message)));
    return json({ ok: true, message: GENERIC });
  });
}

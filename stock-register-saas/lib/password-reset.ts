// Password reset helpers. Pure (node:crypto only) so they can be unit-tested directly.
// Only the SHA-256 hash of a reset token is stored; the token itself goes in the emailed link.
import { createHash, randomBytes } from "node:crypto";

/** A reset link is valid for this long. */
export const RESET_TTL_MINUTES = 30;
/** At most this many reset emails per account per hour (extra requests are silently ignored). */
export const RESET_MAX_PER_HOUR = 3;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new random token (32 bytes, URL-safe) and the hash to store. */
export function newResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function resetExpiry(now = new Date()): Date {
  return new Date(now.getTime() + RESET_TTL_MINUTES * 60 * 1000);
}

export type TokenProblem = "invalid" | "used" | "expired";

/** Why a stored token can't be used, or null if it's fine. */
export function tokenProblem(row: { usedAt: Date | null; expiresAt: Date } | null, now = new Date()): TokenProblem | null {
  if (!row) return "invalid";
  if (row.usedAt) return "used";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

export const TOKEN_PROBLEM_MESSAGE: Record<TokenProblem, string> = {
  invalid: "This reset link isn't valid. Request a new one.",
  used: "This reset link has already been used. Request a new one if you still need to change your password.",
  expired: `This reset link has expired (links last ${RESET_TTL_MINUTES} minutes). Request a new one.`,
};

/**
 * True if a session issued at `iatSeconds` was created before the password was last changed,
 * so it must no longer be accepted. Same-second sessions are allowed.
 */
export function sessionIsStale(iatSeconds: number | undefined, passwordChangedAt: Date | null | undefined): boolean {
  if (!passwordChangedAt) return false;
  if (typeof iatSeconds !== "number") return true;
  return iatSeconds < Math.floor(passwordChangedAt.getTime() / 1000);
}

export function resetLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

export function resetEmail(name: string, link: string): { subject: string; text: string; html: string } {
  const safeName = name.replace(/[<>&"]/g, "");
  const subject = "Reset your GodownBook password";
  const text = [
    `Hi ${safeName},`,
    "",
    "We received a request to reset the password for your GodownBook account.",
    `Open this link to choose a new password (it expires in ${RESET_TTL_MINUTES} minutes and works once):`,
    "",
    link,
    "",
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
    "",
    "— GodownBook",
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;background:#f3f5f0;font-family:Segoe UI,Arial,sans-serif;color:#0b0f0c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #d9ded8;border-radius:16px;padding:28px">
        <tr><td style="font-size:20px;font-weight:700">Godown<span style="color:#16a34a">Book</span></td></tr>
        <tr><td style="padding-top:18px;font-size:16px">Hi ${safeName},</td></tr>
        <tr><td style="padding-top:10px;font-size:15px;line-height:1.5">We received a request to reset the password for your GodownBook account. Click the button to choose a new one.</td></tr>
        <tr><td style="padding:22px 0">
          <a href="${link}" style="display:inline-block;background:#15803d;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;border-bottom:4px solid #0b5227">Set a new password</a>
        </td></tr>
        <tr><td style="font-size:13px;color:#4b524c;line-height:1.5">This link expires in ${RESET_TTL_MINUTES} minutes and can be used once. If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all;color:#15803d">${link}</span></td></tr>
        <tr><td style="padding-top:18px;font-size:13px;color:#4b524c">If you didn't ask for this, you can ignore this email. Your password won't change.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, text, html };
}

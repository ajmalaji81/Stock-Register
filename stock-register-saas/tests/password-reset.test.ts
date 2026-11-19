import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashToken,
  newResetToken,
  resetEmail,
  resetExpiry,
  resetLink,
  RESET_TTL_MINUTES,
  sessionIsStale,
  tokenProblem,
} from "../lib/password-reset.ts";

test("tokens are random, URL-safe and only their hash is stored", () => {
  const a = newResetToken();
  const b = newResetToken();
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.hash, hashToken(a.token));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.hash, a.token);
});

test("links expire after 30 minutes and work once", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const exp = resetExpiry(now);
  assert.equal(RESET_TTL_MINUTES, 30);
  assert.equal(exp.getTime() - now.getTime(), 30 * 60 * 1000);
  assert.equal(tokenProblem({ usedAt: null, expiresAt: exp }, now), null);
  assert.equal(tokenProblem({ usedAt: null, expiresAt: exp }, new Date(exp.getTime())), "expired");
  assert.equal(tokenProblem({ usedAt: now, expiresAt: exp }, now), "used");
  assert.equal(tokenProblem(null, now), "invalid");
});

test("sessions issued before a password change are stale; same second is allowed", () => {
  const changed = new Date("2026-11-18T10:00:00.700Z");
  const sec = Math.floor(changed.getTime() / 1000);
  assert.equal(sessionIsStale(sec - 1, changed), true);
  assert.equal(sessionIsStale(sec, changed), false);
  assert.equal(sessionIsStale(sec + 60, changed), false);
  assert.equal(sessionIsStale(sec - 1, null), false);
  assert.equal(sessionIsStale(undefined, changed), true);
});

test("reset link and email", () => {
  assert.equal(resetLink("https://x.example/", "a b"), "https://x.example/reset-password?token=a%20b");
  const m = resetEmail("Ravi <script>", "https://x.example/reset-password?token=t");
  assert.match(m.subject, /Reset your GodownBook password/);
  assert.ok(m.text.includes("https://x.example/reset-password?token=t"));
  assert.ok(m.text.includes("30 minutes"));
  assert.ok(m.html.includes("didn't ask for this"));
  assert.ok(!m.html.includes("<script>"));
});

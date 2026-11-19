"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "../ui";

export default function ForgotForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setSent(data.message ?? "If an account exists for that email, we've sent a reset link.");
    } catch (err) {
      setError((err as Error).message || "Network error, please try again");
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-lg border-2 border-in bg-in/10 px-3 py-3 text-sm font-medium text-in">
          📧 {sent}
        </p>
        <p className="text-sm text-ink/70">The link works once and expires in 30 minutes.</p>
        <Button variant="ghost" className="w-full" onClick={() => setSent(null)}>
          Use a different email
        </Button>
        <p className="text-center text-sm">
          <Link href="/login" className="font-semibold underline">Back to log in</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Email">
        <Input name="email" type="email" required autoComplete="email" autoFocus />
      </Field>
      {error && (
        <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="w-full py-3">
        {busy ? "Sending…" : "Email me a reset link"}
      </Button>
      <p className="text-center text-sm">
        Remembered it? <Link href="/login" className="font-semibold underline">Log in</Link>
      </p>
    </form>
  );
}

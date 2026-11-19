"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, Input } from "../ui";

type State = "checking" | "ready" | "bad" | "done";

export default function ResetForm({ token }: { token: string }) {
  const [state, setState] = useState<State>(token ? "checking" : "bad");
  const [error, setError] = useState<string | null>(token ? null : "This reset link isn't valid. Request a new one.");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // Tell the person straight away if the link is expired or used.
  useEffect(() => {
    if (!token) return;
    let live = true;
    fetch(`/api/auth/reset?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (d.ok) setState("ready");
        else {
          setState("bad");
          setError(d.error ?? "This reset link isn't valid.");
        }
      })
      .catch(() => live && setState("ready"));
    return () => {
      live = false;
    };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "TOKEN") setState("bad");
        throw new Error(data.error ?? "Couldn't reset the password");
      }
      setState("done");
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  if (state === "checking") return <p className="text-sm text-ink/60">Checking your link…</p>;

  if (state === "done") {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-lg border-2 border-in bg-in/10 px-3 py-3 text-sm font-medium text-in">
          ✓ Your password has been changed. You&apos;ve been signed out on all devices.
        </p>
        <Link href="/login" className="btn-3d btn-edge-ink block rounded-xl bg-ink py-3 text-center font-semibold text-paper">
          Log in with the new password
        </Link>
      </div>
    );
  }

  if (state === "bad") {
    return (
      <div className="space-y-4">
        <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-3 text-sm font-medium text-out">{error}</p>
        <Link href="/forgot-password" className="btn-3d btn-edge-ink block rounded-xl bg-ink py-3 text-center font-semibold text-paper">
          Request a new link
        </Link>
        <p className="text-center text-sm">
          <Link href="/login" className="font-semibold underline">Back to log in</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="New password" hint="At least 8 characters">
        <Input
          type={show ? "text" : "password"}
          required
          minLength={8}
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password">
        <Input
          type={show ? "text" : "password"}
          required
          minLength={8}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="h-4 w-4 accent-brand" />
        Show passwords
      </label>
      {error && (
        <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="w-full py-3">
        {busy ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}

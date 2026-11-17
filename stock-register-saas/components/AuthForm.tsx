"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "./ui";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        router.push("/app");
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Something went wrong");
    } catch {
      setError("Network error, please try again");
    }
    setBusy(false);
  }

  const signup = mode === "signup";
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {signup && (
        <Field label="Your name / shop name">
          <Input name="name" required autoComplete="name" />
        </Field>
      )}
      <Field label="Email">
        <Input name="email" type="email" required autoComplete="email" />
      </Field>
      <Field label="Password" hint={signup ? "At least 8 characters" : undefined}>
        <Input
          name="password"
          type="password"
          required
          minLength={signup ? 8 : undefined}
          autoComplete={signup ? "new-password" : "current-password"}
        />
      </Field>
      {error && (
        <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="w-full py-3">
        {busy ? "Please wait…" : signup ? "Create free account" : "Log in"}
      </Button>
      <p className="text-center text-sm">
        {signup ? "Already have an account? " : "New here? "}
        <Link href={signup ? "/login" : "/signup"} className="font-semibold underline">
          {signup ? "Log in" : "Create a free account"}
        </Link>
      </p>
    </form>
  );
}

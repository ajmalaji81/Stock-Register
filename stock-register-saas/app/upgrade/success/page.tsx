"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Logo from "@/components/Logo";

type State = "waiting" | "pro" | "slow" | "failed";

/**
 * Dodo sends the buyer back here. The plan is only upgraded by the verified webhook,
 * so we poll until it lands instead of trusting the URL's query string.
 */
export default function UpgradeSuccessPage() {
  const [state, setState] = useState<State>("waiting");
  const [paymentId, setPaymentId] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    setPaymentId(qs.get("payment_id"));
    const status = qs.get("status");
    if (status && status !== "succeeded") {
      setState("failed");
      return;
    }
    let tries = 0;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      tries++;
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        const data = await res.json();
        if (data.user?.plan === "PRO") {
          setState("pro");
          return;
        }
      } catch {
        /* keep polling */
      }
      if (tries >= 20) setState("slow");
      else setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);

  return (
    <div className="bg-dots flex min-h-full items-center justify-center px-4">
      <div className="card-3d pop-in w-full max-w-md p-8 text-center">
        <div className="mb-6 flex justify-center"><Logo /></div>
        {state === "waiting" && (
          <>
            <h1 className="text-2xl font-bold">Confirming your payment…</h1>
            <p className="mt-2 text-ink/70">This usually takes a few seconds.</p>
          </>
        )}
        {state === "pro" && (
          <>
            <h1 className="text-2xl font-bold text-in">Lifetime Pro unlocked 🎉</h1>
            <p className="mt-2">Unlimited items and godowns are now on your account.</p>
            <Link href="/app" className="btn-3d btn-edge-ink mt-6 inline-block rounded-xl bg-ink px-5 py-2.5 font-semibold text-paper">Open my book</Link>
          </>
        )}
        {state === "slow" && (
          <>
            <h1 className="text-2xl font-bold">Payment received, still syncing</h1>
            <p className="mt-2 text-ink/70">
              Your upgrade should appear within a few minutes. If it doesn&apos;t, contact support with your payment ID
              {paymentId ? <> (<code className="font-mono text-xs">{paymentId}</code>)</> : null}.
            </p>
            <Link href="/app" className="btn-3d btn-edge-ink mt-6 inline-block rounded-xl bg-ink px-5 py-2.5 font-semibold text-paper">Go to my book</Link>
          </>
        )}
        {state === "failed" && (
          <>
            <h1 className="text-2xl font-bold text-out">Payment not completed</h1>
            <p className="mt-2 text-ink/70">You haven&apos;t been charged for Lifetime Pro. You can try again any time.</p>
            <Link href="/upgrade" className="btn-3d btn-edge-ink mt-6 inline-block rounded-xl bg-ink px-5 py-2.5 font-semibold text-paper">Try again</Link>
          </>
        )}
      </div>
    </div>
  );
}

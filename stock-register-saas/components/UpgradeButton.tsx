"use client";

import { useState } from "react";
import { Button } from "./ui";

/** Creates a Dodo checkout session on the server and sends the user to it. */
export default function UpgradeButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.href = "/signup";
        return;
      }
      if (!res.ok || !data.url) throw new Error(data.error ?? "Couldn't start checkout");
      window.location.href = data.url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="in" onClick={go} disabled={busy} className="w-full py-3 text-base">
        {busy ? "Opening secure checkout…" : label}
      </Button>
      {error && <p role="alert" className="mt-2 text-sm font-medium text-out">{error}</p>}
    </div>
  );
}

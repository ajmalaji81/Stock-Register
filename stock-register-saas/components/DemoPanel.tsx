"use client";

import { useEffect, useState } from "react";
import { createDemoStore } from "@/lib/store";
import Workspace from "./Workspace";

/** The landing-page sandbox: the real app UI running against an in-browser register. */
export default function DemoPanel() {
  const [store, setStore] = useState<ReturnType<typeof createDemoStore> | null>(null);
  // Created after mount because it reads localStorage, which doesn't exist on the server.
  useEffect(() => setStore(createDemoStore()), []);
  if (!store)
    return (
      <div className="grid gap-3 p-4 sm:grid-cols-4" aria-busy="true" aria-label="Loading demo">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="well h-24 animate-pulse rounded-2xl motion-reduce:animate-none" />
        ))}
      </div>
    );
  return <Workspace store={store} onReset={() => store.reset()} />;
}

"use client";

import { useEffect, useState } from "react";
import type { BusinessProfile } from "@/lib/voucher-service";

/** JSON fetch that throws an Error carrying the API's message. */
export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface PartyLite {
  id: string;
  name: string;
  type: string;
  phone: string;
  gstin: string;
  state: string;
}

function normaliseParties(data: unknown): PartyLite[] {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { parties?: unknown[] })?.parties)
      ? (data as { parties: unknown[] }).parties
      : Array.isArray((data as { items?: unknown[] })?.items)
        ? (data as { items: unknown[] }).items
        : [];
  return arr
    .map((p) => p as Partial<PartyLite>)
    .filter((p): p is Partial<PartyLite> & { id: string; name: string } => typeof p.id === "string" && typeof p.name === "string")
    .map((p) => ({ id: p.id, name: p.name, type: p.type ?? "CUSTOMER", phone: p.phone ?? "", gstin: p.gstin ?? "", state: p.state ?? "" }));
}

/** Parties from the Parties module (GET /api/parties). Empty if unavailable. */
export function useParties(version: number) {
  const [parties, setParties] = useState<PartyLite[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<unknown>("GET", "/api/parties")
      .then((d) => live && setParties(normaliseParties(d)))
      .catch(() => live && setParties([]));
    return () => {
      live = false;
    };
  }, [version, tick]);
  return { parties, reload: () => setTick((t) => t + 1) };
}

export async function quickAddParty(input: { name: string; type: string; phone: string; state: string }): Promise<PartyLite> {
  const d = await api<unknown>("POST", "/api/parties", { ...input, email: "", gstin: "", address: "", openingBalance: 0 });
  const p = { ...input, ...((d as { party?: object }).party ?? (d as object)) };
  const list = normaliseParties([p]);
  if (!list[0]) throw new Error("Party added, refresh to see it");
  return list[0];
}

export function useProfile() {
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  useEffect(() => {
    api<BusinessProfile>("GET", "/api/settings").then(setProfile).catch(() => setProfile(null));
  }, []);
  return profile;
}

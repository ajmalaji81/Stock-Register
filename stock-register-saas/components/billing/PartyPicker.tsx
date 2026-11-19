"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, Input, money } from "../ui";
import type { PartyLite } from "./api";

/** Digits only, without a leading 91 / 0 on Indian numbers, so "+91 98401 00001" matches "9840100001". */
export function phoneDigits(s: string): string {
  let d = s.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}

/** A 10-digit Indian mobile number (optionally typed with +91 / 0 / spaces). */
export function isIndianMobile(s: string): boolean {
  return /^[6-9]\d{9}$/.test(phoneDigits(s)) && /^[\d\s+()-]+$/.test(s.trim());
}

type Option =
  | { kind: "walkin" }
  | { kind: "party"; party: PartyLite }
  | { kind: "addPhone"; phone: string }
  | { kind: "addName"; name: string };

/**
 * Type a name or phone number to find a customer / supplier. If a mobile number isn't found,
 * offers to add a party with that number (asks only for a name); an unknown name can be added directly.
 */
export default function PartyPicker({
  parties,
  wantedTypes,
  value,
  onChange,
  walkInLabel,
  roleLabel,
  onQuickAdd,
}: {
  parties: PartyLite[];
  /** e.g. ["CUSTOMER","BOTH"] — other types are hidden (except the selected one). */
  wantedTypes: string[];
  value: string;
  onChange: (partyId: string) => void;
  /** Shown as the first option when a bill may have no party; omit when a party is required. */
  walkInLabel?: string;
  /** "customer" / "supplier" */
  roleLabel: string;
  onQuickAdd: (p: { name: string; phone: string }) => Promise<PartyLite>;
}) {
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const selected = parties.find((p) => p.id === value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [askName, setAskName] = useState<string | null>(null); // phone waiting for a name
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const options = useMemo<Option[]>(() => {
    const q = query.trim();
    const qLower = q.toLowerCase();
    const qDigits = phoneDigits(q);
    const numeric = q !== "" && /^[\d\s+()-]+$/.test(q);
    const pool = parties.filter((p) => wantedTypes.includes(p.type) || p.id === value);
    const matches = q
      ? pool.filter((p) => (numeric ? qDigits.length >= 3 && phoneDigits(p.phone).includes(qDigits) : p.name.toLowerCase().includes(qLower) || (qDigits.length >= 3 && phoneDigits(p.phone).includes(qDigits))))
      : pool;
    const out: Option[] = [];
    if (walkInLabel && !q) out.push({ kind: "walkin" });
    out.push(...matches.slice(0, 8).map((party) => ({ kind: "party" as const, party })));
    if (q && isIndianMobile(q) && !pool.some((p) => phoneDigits(p.phone) === qDigits)) out.push({ kind: "addPhone", phone: qDigits });
    else if (q && !numeric && !pool.some((p) => p.name.toLowerCase() === qLower)) out.push({ kind: "addName", name: q });
    return out;
  }, [parties, wantedTypes, value, query, walkInLabel]);

  useEffect(() => setActive(0), [query]);

  async function add(name: string, phone: string) {
    setBusy(true);
    setError(null);
    try {
      const p = await onQuickAdd({ name: name.trim(), phone });
      onChange(p.id);
      setAskName(null);
      setNewName("");
      setQuery("");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function choose(o: Option) {
    setError(null);
    if (o.kind === "walkin") onChange("");
    else if (o.kind === "party") onChange(o.party.id);
    else if (o.kind === "addPhone") {
      setAskName(o.phone);
      setOpen(false);
      return;
    } else {
      void add(o.name, "");
      return;
    }
    setQuery("");
    setOpen(false);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open && options[active]) {
        e.preventDefault();
        choose(options[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (askName !== null) {
    return (
      <div className="space-y-2">
        <p className="text-sm">
          New {roleLabel} with phone <b className="tabular-nums">{askName}</b>
        </p>
        <Input autoFocus placeholder={`${roleLabel[0].toUpperCase()}${roleLabel.slice(1)} name`} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <div className="flex gap-2">
          <Button type="button" disabled={!newName.trim() || busy} onClick={() => add(newName, askName)} className="flex-1">
            {busy ? "Adding…" : `Add ${roleLabel}`}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAskName(null)}>Back</Button>
        </div>
        {error && <p role="alert" className="text-sm font-medium text-out">{error}</p>}
      </div>
    );
  }

  const label = (o: Option) =>
    o.kind === "walkin" ? walkInLabel : o.kind === "party" ? o.party.name : o.kind === "addPhone" ? `Add ${roleLabel} with phone ${o.phone}` : `Add "${o.name}"`;

  return (
    <div ref={box} className="relative">
      <Input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        placeholder={selected ? `${selected.name}${selected.phone ? ` · ${selected.phone}` : ""}` : `Search ${roleLabel} by name or phone`}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className={selected && !query ? "placeholder:font-semibold placeholder:text-ink" : ""}
      />
      {selected && !query && (
        <button type="button" aria-label={`Clear ${roleLabel}`} className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-lg text-ink/50 hover:text-out" onClick={() => onChange("")}>
          ×
        </button>
      )}
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="card-3d absolute z-30 mt-1 max-h-72 w-full overflow-y-auto p-1">
          {options.map((o, i) => (
            <li
              key={o.kind === "party" ? o.party.id : `${o.kind}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm ${i === active ? "bg-brand-soft" : ""} ${o.kind === "addPhone" || o.kind === "addName" ? "font-semibold text-in" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate">{o.kind === "addPhone" || o.kind === "addName" ? `+ ${label(o)}` : label(o)}</span>
                {o.kind === "party" && (o.party.phone || o.party.gstin) && (
                  <span className="block truncate text-xs text-ink/60">{[o.party.phone, o.party.gstin && `GSTIN ${o.party.gstin}`].filter(Boolean).join(" · ")}</span>
                )}
              </span>
              {o.kind === "party" && o.party.balance !== null && Math.abs(o.party.balance) > 0.005 && (
                <span className={`shrink-0 text-xs font-semibold tabular-nums ${o.party.balance > 0 ? "text-low" : "text-in"}`}>
                  {o.party.balance > 0 ? `Due ${money(o.party.balance)}` : `Payable ${money(-o.party.balance)}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-1 text-sm font-medium text-out">{error}</p>}
    </div>
  );
}

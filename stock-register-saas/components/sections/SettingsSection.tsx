"use client";

import { useEffect, useState, type FormEvent } from "react";
import { INDIAN_STATES } from "@/lib/gst";
import type { BusinessProfile } from "@/lib/voucher-service";
import { api } from "../billing/api";
import { Button, Card, Empty, Field, Input, SectionHeader, Select } from "../ui";
import type { SectionProps } from "./types";

const EMPTY: BusinessProfile = { businessName: "", gstin: "", address: "", state: "", phone: "", invoicePrefix: "INV", invoiceTerms: "", bankDetails: "" };

export default function SettingsSection({ notify }: SectionProps) {
  const [f, setF] = useState<BusinessProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<BusinessProfile>("GET", "/api/settings").then(setF).catch((e: Error) => { setF(EMPTY); setError(e.message); });
  }, []);

  if (!f) return <Empty>Loading…</Empty>;
  const set = (k: keyof BusinessProfile) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setF(await api<BusinessProfile>("PUT", "/api/settings", f));
      notify("Business settings saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <SectionHeader title="Business & invoice settings" subtitle="Printed on every invoice. Your state decides CGST + SGST (same state) or IGST (other state)." />
      <form onSubmit={save}>
        <Card className="space-y-4 p-5">
          <Field label="Business name"><Input value={f.businessName} onChange={set("businessName")} placeholder="Sharma Traders" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="GSTIN" hint="Leave empty if not registered"><Input value={f.gstin} onChange={set("gstin")} placeholder="33ABCDE1234F1Z5" maxLength={15} className="uppercase" /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={set("phone")} inputMode="tel" placeholder="98765 43210" /></Field>
            <Field label="State">
              <Select value={f.state} onChange={set("state")}>
                <option value="">Choose state</option>
                {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Invoice number prefix" hint={`Next invoices look like ${f.invoicePrefix || "INV"}-0001`}><Input value={f.invoicePrefix} onChange={set("invoicePrefix")} maxLength={10} /></Field>
          </div>
          <Field label="Address">
            <textarea value={f.address} onChange={set("address")} rows={2} className="well w-full rounded-xl border-2 border-ink/15 px-3 py-2 text-sm outline-none focus:border-ink" />
          </Field>
          <Field label="Bank details" hint="Account name, number, IFSC, UPI ID">
            <textarea value={f.bankDetails} onChange={set("bankDetails")} rows={3} className="well w-full rounded-xl border-2 border-ink/15 px-3 py-2 text-sm outline-none focus:border-ink" />
          </Field>
          <Field label="Terms & conditions">
            <textarea value={f.invoiceTerms} onChange={set("invoiceTerms")} rows={3} placeholder="Goods once sold will not be taken back." className="well w-full rounded-xl border-2 border-ink/15 px-3 py-2 text-sm outline-none focus:border-ink" />
          </Field>
          {error && <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy ? "Saving…" : "Save settings"}</Button>
        </Card>
      </form>
    </div>
  );
}

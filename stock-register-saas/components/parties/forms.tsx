"use client";

import { useState, type FormEvent } from "react";
import { todayISO } from "@/lib/engine";
import { EXPENSE_CATEGORIES, PAYMENT_MODES } from "@/lib/money";
import type { PartyRow } from "@/lib/party-service";
import { Button, Field, Input, Modal, Select, money } from "../ui";
import { MODE_LABEL } from "./api";

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">
      {error}
    </p>
  );
}

export interface PartyFormValues {
  name: string;
  type: "CUSTOMER" | "SUPPLIER" | "BOTH";
  phone: string;
  email: string;
  gstin: string;
  state: string;
  address: string;
  openingBalance: number;
}

export function PartyModal({
  party,
  busy,
  error,
  onClose,
  onSave,
}: {
  party: PartyRow | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (v: PartyFormValues) => void;
}) {
  const ob = party?.openingBalance ?? 0;
  const [f, setF] = useState({
    name: party?.name ?? "",
    type: party?.type ?? "CUSTOMER",
    phone: party?.phone ?? "",
    email: party?.email ?? "",
    gstin: party?.gstin ?? "",
    state: party?.state ?? "",
    address: party?.address ?? "",
    opening: ob ? String(Math.abs(ob)) : "",
    openingSide: ob < 0 ? "PAYABLE" : "RECEIVABLE",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const amt = Number(f.opening || 0);
    onSave({
      name: f.name,
      type: f.type as PartyFormValues["type"],
      phone: f.phone,
      email: f.email,
      gstin: f.gstin,
      state: f.state,
      address: f.address,
      openingBalance: f.openingSide === "PAYABLE" ? -amt : amt,
    });
  };

  return (
    <Modal title={party ? "Edit party" : "New party"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Party name">
          <Input required autoFocus value={f.name} onChange={set("name")} placeholder="Sharma Kirana Store" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={f.type} onChange={set("type")}>
              <option value="CUSTOMER">Customer</option>
              <option value="SUPPLIER">Supplier</option>
              <option value="BOTH">Both</option>
            </Select>
          </Field>
          <Field label="Phone (WhatsApp)">
            <Input type="tel" inputMode="tel" value={f.phone} onChange={set("phone")} placeholder="98765 43210" />
          </Field>
          <Field label="GSTIN">
            <Input value={f.gstin} onChange={set("gstin")} placeholder="33ABCDE1234F1Z5" maxLength={15} className="uppercase" />
          </Field>
          <Field label="State">
            <Input value={f.state} onChange={set("state")} placeholder="Tamil Nadu" />
          </Field>
        </div>
        <Field label="Email">
          <Input type="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Address">
          <Input value={f.address} onChange={set("address")} />
        </Field>
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-3">
          <Field label="Opening balance (₹)">
            <Input type="number" min="0" step="any" inputMode="decimal" value={f.opening} onChange={set("opening")} placeholder="0" />
          </Field>
          <Field label="Which side">
            <Select value={f.openingSide} onChange={set("openingSide")}>
              <option value="RECEIVABLE">They owe us</option>
              <option value="PAYABLE">We owe them</option>
            </Select>
          </Field>
        </div>
        <ErrorLine error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Saving…" : "Save party"}
        </Button>
      </form>
    </Modal>
  );
}

export interface PaymentFormValues {
  partyId: string;
  direction: "IN" | "OUT";
  amount: number;
  mode: string;
  date: string;
  reference: string;
  notes: string;
}

export function PaymentModal({
  parties,
  initialPartyId,
  initialDirection,
  busy,
  error,
  onClose,
  onSave,
}: {
  parties: PartyRow[];
  initialPartyId?: string;
  initialDirection?: "IN" | "OUT";
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (v: PaymentFormValues) => void;
}) {
  const first = parties.find((p) => p.id === initialPartyId) ?? parties[0];
  const guess: "IN" | "OUT" = initialDirection ?? (first && (first.balance < 0 || first.type === "SUPPLIER") ? "OUT" : "IN");
  const [partyId, setPartyId] = useState(first?.id ?? "");
  const [direction, setDirection] = useState<"IN" | "OUT">(guess);
  const [amount, setAmount] = useState(first && first.balance !== 0 ? String(Math.abs(first.balance)) : "");
  const [mode, setMode] = useState("CASH");
  const [date, setDate] = useState(todayISO());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const party = parties.find((p) => p.id === partyId);

  if (parties.length === 0) {
    return (
      <Modal title="Record payment" onClose={onClose}>
        <p className="text-sm">Add a customer or supplier first.</p>
      </Modal>
    );
  }

  return (
    <Modal title="Record payment" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ partyId, direction, amount: Number(amount), mode, date, reference, notes });
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Direction">
          {(["IN", "OUT"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={direction === d}
              onClick={() => setDirection(d)}
              className={`rounded-xl border-2 px-3 py-2.5 text-sm font-bold ${
                direction === d ? (d === "IN" ? "border-in bg-in text-white" : "border-out bg-out text-white") : "border-ink/20"
              }`}
            >
              {d === "IN" ? "↓ Received" : "↑ Paid"}
            </button>
          ))}
        </div>
        <Field
          label="Party"
          hint={party ? (party.balance > 0 ? `They owe ${money(party.balance)}` : party.balance < 0 ? `You owe ${money(-party.balance)}` : "Settled") : undefined}
        >
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)">
            <Input type="number" required autoFocus min="0" step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              {PAYMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." />
          </Field>
        </div>
        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
        <Button type="submit" variant={direction === "IN" ? "in" : "out"} disabled={busy} className="w-full">
          {busy ? "Saving…" : direction === "IN" ? "Save receipt" : "Save payment"}
        </Button>
      </form>
    </Modal>
  );
}

export interface ExpenseFormValues {
  category: string;
  amount: number;
  mode: string;
  date: string;
  notes: string;
}

export function ExpenseModal({
  categories,
  busy,
  error,
  onClose,
  onSave,
}: {
  categories: string[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (v: ExpenseFormValues) => void;
}) {
  const [category, setCategory] = useState("Rent");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("CASH");
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const all = [...new Set([...EXPENSE_CATEGORIES, ...categories])];

  return (
    <Modal title="Add expense" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ category, amount: Number(amount), mode, date, notes });
        }}
        className="space-y-3"
      >
        <Field label="Category" hint="Pick one or type your own">
          <Input required list="expense-cats" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="expense-cats">
            {all.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)">
            <Input type="number" required autoFocus min="0" step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Paid by">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              {PAYMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Date">
          <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shop rent for November" />
        </Field>
        <ErrorLine error={error} />
        <Button type="submit" variant="out" disabled={busy} className="w-full">
          {busy ? "Saving…" : "Save expense"}
        </Button>
      </form>
    </Modal>
  );
}

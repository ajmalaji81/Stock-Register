"use client";

import { BILL_PAYMENT_MODES, FINANCIERS, MAX_BILL_PAYMENTS, PAYMENT_MODE_LABEL, r2, type BillPaymentInput, type BillPaymentMode } from "@/lib/gst";
import type { VoucherPaymentDTO } from "@/lib/voucher-service";
import { Button, Field, Input, Select, money } from "../ui";

/** Editor state for one payment row (strings while typing). */
export interface PayRow {
  key: number;
  mode: BillPaymentMode;
  amount: string;
  reference: string;
  /** FINANCE: one of FINANCIERS, or "Other" with `financierOther`. */
  financier: string;
  financierOther: string;
  paymentInfo: string;
  scheme: string;
}

let payKey = 0;
const OTHER = "Other";

export function newPayRow(mode: BillPaymentMode = "CASH", amount = ""): PayRow {
  return { key: ++payKey, mode, amount, reference: "", financier: "", financierOther: "", paymentInfo: "", scheme: "" };
}

export function payRowsFrom(saved: VoucherPaymentDTO[]): PayRow[] {
  return saved.map((p) => {
    const known = (FINANCIERS as readonly string[]).includes(p.financier);
    return {
      key: ++payKey,
      mode: p.mode,
      amount: String(p.amount),
      reference: p.reference,
      financier: p.mode === "FINANCE" ? (known ? p.financier : p.financier ? OTHER : "") : "",
      financierOther: p.mode === "FINANCE" && !known ? p.financier : "",
      paymentInfo: p.paymentInfo,
      scheme: p.scheme,
    };
  });
}

/** Rows as the API expects them. */
export function toPayments(rows: PayRow[]): BillPaymentInput[] {
  return rows.map((r) => ({
    mode: r.mode,
    amount: Number(r.amount || 0),
    reference: r.reference.trim(),
    financier: r.mode === "FINANCE" ? (r.financier === OTHER ? r.financierOther.trim() : r.financier) : "",
    paymentInfo: r.mode === "FINANCE" ? r.paymentInfo.trim() : "",
    scheme: r.mode === "FINANCE" ? r.scheme.trim() : "",
  }));
}

const REF_HINT: Partial<Record<BillPaymentMode, string>> = {
  CARD: "Card last 4 / approval code",
  UPI: "UPI ref no.",
  BANK: "UTR / NEFT ref",
  CHEQUE: "Cheque no. & bank",
};

/**
 * How the customer paid at the counter: one or more modes (split payment), incl. FINANCE with
 * mandatory financier, disbursement amount, payment info and scheme.
 */
export default function PaymentsPanel({
  rows,
  setRows,
  total,
  hasParty,
  laterPaid = 0,
}: {
  rows: PayRow[];
  setRows: (r: PayRow[]) => void;
  total: number;
  hasParty: boolean;
  /** Payments recorded later from the Parties screen (edit mode); they stay as they are. */
  laterPaid?: number;
}) {
  const paid = r2(rows.reduce((a, r) => a + Number(r.amount || 0), 0));
  const balance = r2(total - paid - laterPaid);
  const set = (key: number, patch: Partial<PayRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const fillRest = (key: number) => {
    const others = r2(rows.filter((r) => r.key !== key).reduce((a, r) => a + Number(r.amount || 0), 0));
    set(key, { amount: String(Math.max(0, r2(total - laterPaid - others))) });
  };

  return (
    <div className="well space-y-3 rounded-xl p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-ink/70">Payment</span>
        <div className="flex gap-1.5">
          <Button type="button" variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setRows([newPayRow("CASH", String(Math.max(0, r2(total - laterPaid))))])}>
            Paid in full (Cash)
          </Button>
          <Button type="button" variant="ghost" className="px-2.5 py-1 text-xs" disabled={rows.length >= MAX_BILL_PAYMENTS} onClick={() => setRows([...rows, newPayRow(rows.length ? "UPI" : "CASH", rows.length ? String(Math.max(0, balance)) : "")])}>
            + Add payment mode
          </Button>
        </div>
      </div>

      {rows.length === 0 && (
        <p className="text-xs text-ink/60">
          {hasParty ? "No payment taken now — the full amount stays as the customer's balance." : "Cash sale. Add the payment modes to record how it was paid (card, UPI, finance…)."}
        </p>
      )}

      {rows.map((r, i) => {
        const finance = r.mode === "FINANCE";
        return (
          <div key={r.key} className={`space-y-2 rounded-lg border-2 p-2.5 ${finance ? "border-low/50 bg-low/5" : "border-ink/10 bg-paper"}`}>
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <Field label={rows.length > 1 ? `Mode ${i + 1}` : "Mode"}>
                <Select value={r.mode} onChange={(e) => set(r.key, { mode: e.target.value as BillPaymentMode })}>
                  {BILL_PAYMENT_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
                </Select>
              </Field>
              <Field label={finance ? "Disbursement ₹ *" : "Amount ₹"}>
                <Input type="number" min="0" step="any" inputMode="decimal" required={finance} value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} placeholder="0" />
              </Field>
              <button type="button" aria-label={`Remove payment ${i + 1}`} className="mb-1 rounded-lg px-2 text-xl text-out hover:bg-out/10" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>×</button>
            </div>
            {finance ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Financier *">
                  <Select required value={r.financier} onChange={(e) => set(r.key, { financier: e.target.value })}>
                    <option value="">Choose financier…</option>
                    {FINANCIERS.map((f) => <option key={f} value={f}>{f}</option>)}
                    <option value={OTHER}>Other…</option>
                  </Select>
                </Field>
                {r.financier === OTHER && (
                  <Field label="Financier name *">
                    <Input required value={r.financierOther} onChange={(e) => set(r.key, { financierOther: e.target.value })} placeholder="e.g. Poonawalla Fincorp" />
                  </Field>
                )}
                <Field label="Payment info *" hint="Loan / agreement / DO number">
                  <Input required value={r.paymentInfo} onChange={(e) => set(r.key, { paymentInfo: e.target.value })} placeholder="DO-552310" />
                </Field>
                <Field label="Scheme info *" hint="EMIs, down payment, interest">
                  <Input required value={r.scheme} onChange={(e) => set(r.key, { scheme: e.target.value })} placeholder="6 EMI × ₹2,500, 0 down, 0% interest" />
                </Field>
              </div>
            ) : (
              r.mode !== "CASH" && (
                <Input value={r.reference} onChange={(e) => set(r.key, { reference: e.target.value })} placeholder={REF_HINT[r.mode] ?? "Reference"} aria-label={`${PAYMENT_MODE_LABEL[r.mode]} reference`} />
              )
            )}
            {Number(r.amount || 0) === 0 && balance > 0 && (
              <button type="button" className="text-xs font-semibold underline" onClick={() => fillRest(r.key)}>Fill remaining {money(balance + Number(r.amount || 0))}</button>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap justify-between gap-2 border-t-2 border-ink/10 pt-2 text-sm tabular-nums">
        <span>
          Paid <b>{money(paid)}</b>
          {laterPaid > 0 && <span className="text-ink/60"> (+ {money(laterPaid)} received later)</span>}
        </span>
        <span className={balance > 0.005 ? "font-bold text-low" : balance < -0.005 ? "font-bold text-out" : "font-bold text-in"}>
          {balance < -0.005 ? `Over by ${money(-balance)}` : balance > 0.005 ? `Balance ${money(balance)}` : "Fully paid"}
        </span>
      </div>
      {!hasParty && rows.length > 0 && balance > 0.005 && (
        <p className="text-xs font-medium text-low">A walk-in sale must be fully paid. Pick a customer above to sell on credit.</p>
      )}
    </div>
  );
}

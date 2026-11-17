// Pure money helpers for parties, payments, expenses and the cash book.
// No imports besides types, so Node can run the unit tests directly.

export type VoucherKindForBalance = "SALE" | "SALE_RETURN" | "PURCHASE" | "PURCHASE_RETURN";
export type PaymentDirection = "IN" | "OUT";
export type PaymentMode = "CASH" | "BANK" | "UPI" | "CHEQUE";

export const PAYMENT_MODES: PaymentMode[] = ["CASH", "BANK", "UPI", "CHEQUE"];
export const EXPENSE_CATEGORIES = ["Rent", "Salary", "Transport", "Electricity", "Repairs", "Packaging", "Other"];

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Voucher kinds that change a party's balance, and the sign (+ = party owes us more). */
export const BALANCE_SIGN: Record<VoucherKindForBalance, 1 | -1> = {
  SALE: 1,
  SALE_RETURN: -1,
  PURCHASE: -1,
  PURCHASE_RETURN: 1,
};

export function isBalanceKind(kind: string): kind is VoucherKindForBalance {
  return kind in BALANCE_SIGN;
}

/** Sign of a payment's effect on the balance: receiving money reduces what they owe us. */
export function paymentSign(direction: PaymentDirection): 1 | -1 {
  return direction === "IN" ? -1 : 1;
}

export interface BalanceParts {
  openingBalance: number;
  sale: number;
  saleReturn: number;
  purchase: number;
  purchaseReturn: number;
  paidIn: number;
  paidOut: number;
}

/**
 * Party balance. Positive = receivable (they owe us), negative = payable (we owe them).
 * opening + sales − sales returns − purchases + purchase returns − payments received + payments made
 */
export function partyBalance(p: BalanceParts): number {
  return round2(p.openingBalance + p.sale - p.saleReturn - p.purchase + p.purchaseReturn - p.paidIn + p.paidOut);
}

export interface LedgerSource {
  date: string;
  createdAt: string;
  kind: "OPENING" | VoucherKindForBalance | "PAYMENT_IN" | "PAYMENT_OUT";
  ref: string;
  amount: number; // always positive
  notes: string;
  id: string;
}

export interface PartyLedgerRow extends LedgerSource {
  /** Increases what they owe us. */
  debit: number;
  /** Decreases what they owe us. */
  credit: number;
  balance: number;
}

export function ledgerSign(kind: LedgerSource["kind"]): 1 | -1 {
  if (kind === "OPENING") return 1;
  if (kind === "PAYMENT_IN") return -1;
  if (kind === "PAYMENT_OUT") return 1;
  return BALANCE_SIGN[kind];
}

/**
 * Sort entries chronologically and compute a running balance.
 * `openingBalance` (signed) becomes the first row when non-zero. Rows before `from` are folded into a
 * "Balance b/f" opening row so the running balance stays correct for a date-filtered view.
 */
export function buildPartyLedger(openingBalance: number, entries: LedgerSource[], from?: string, to?: string): PartyLedgerRow[] {
  const sorted = [...entries].sort((a, b) =>
    a.date === b.date ? (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)) : a.date.localeCompare(b.date),
  );
  let bal = round2(openingBalance);
  const rows: PartyLedgerRow[] = [];
  let carried = false;
  const pushOpening = (date: string, label: string) => {
    rows.push({
      id: "opening",
      date,
      createdAt: "",
      kind: "OPENING",
      ref: label,
      amount: Math.abs(bal),
      notes: "",
      debit: bal > 0 ? bal : 0,
      credit: bal < 0 ? -bal : 0,
      balance: bal,
    });
  };
  if (!from && bal !== 0) pushOpening(sorted[0]?.date ?? "", "Opening balance");
  for (const e of sorted) {
    if (to && e.date > to) break;
    const signed = ledgerSign(e.kind) * Math.abs(e.amount);
    if (from && e.date < from) {
      bal = round2(bal + signed);
      continue;
    }
    if (from && !carried) {
      carried = true;
      if (bal !== 0) pushOpening(from, "Balance b/f");
    }
    bal = round2(bal + signed);
    rows.push({ ...e, amount: Math.abs(e.amount), debit: signed > 0 ? Math.abs(e.amount) : 0, credit: signed < 0 ? Math.abs(e.amount) : 0, balance: bal });
  }
  if (from && !carried && bal !== 0) pushOpening(from, "Balance b/f");
  return rows;
}

/** wa.me phone: digits only, Indian 10-digit numbers get 91 prefixed. Null if unusable. */
export function waPhone(phone: string): string | null {
  let d = phone.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export function reminderMessage(partyName: string, due: number, business: string): string {
  const amt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(due);
  return `Namaste ${partyName}, this is a gentle reminder from ${business} that ${amt} is pending on your account. Kindly arrange the payment at your earliest convenience. Thank you!`;
}

export function whatsappLink(phone: string, text: string): string | null {
  const p = waPhone(phone);
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : null;
}

/** Cash vs bank bucket for a payment / expense mode. */
export function bucketOf(mode: string): "cash" | "bank" {
  return mode === "CASH" ? "cash" : "bank";
}

export interface CashFlow {
  date: string;
  mode: string;
  /** + money in, − money out */
  amount: number;
}

export interface CashDay {
  date: string;
  cashIn: number;
  cashOut: number;
  bankIn: number;
  bankOut: number;
}

export interface CashSummary {
  openingCash: number;
  openingBank: number;
  closingCash: number;
  closingBank: number;
  days: CashDay[];
}

/** Cash book over [from, to]; flows before `from` form the opening balances. */
export function summarizeCash(flows: CashFlow[], from?: string, to?: string): CashSummary {
  let openingCash = 0;
  let openingBank = 0;
  const byDay = new Map<string, CashDay>();
  for (const f of flows) {
    if (to && f.date > to) continue;
    const b = bucketOf(f.mode);
    if (from && f.date < from) {
      if (b === "cash") openingCash += f.amount;
      else openingBank += f.amount;
      continue;
    }
    const d = byDay.get(f.date) ?? { date: f.date, cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0 };
    if (b === "cash") {
      if (f.amount >= 0) d.cashIn += f.amount;
      else d.cashOut -= f.amount;
    } else if (f.amount >= 0) d.bankIn += f.amount;
    else d.bankOut -= f.amount;
    byDay.set(f.date, d);
  }
  const days = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, cashIn: round2(d.cashIn), cashOut: round2(d.cashOut), bankIn: round2(d.bankIn), bankOut: round2(d.bankOut) }));
  const closingCash = round2(openingCash + days.reduce((s, d) => s + d.cashIn - d.cashOut, 0));
  const closingBank = round2(openingBank + days.reduce((s, d) => s + d.bankIn - d.bankOut, 0));
  return { openingCash: round2(openingCash), openingBank: round2(openingBank), closingCash, closingBank, days };
}

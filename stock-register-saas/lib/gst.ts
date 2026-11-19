// Pure GST maths for bills. No imports, so Node can run the unit tests directly
// and the browser can show live totals with exactly the server's numbers.

export const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
  "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal",
] as const;

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const r4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

export interface LineInput {
  qty: number;
  /** Price per unit before tax. */
  rate: number;
  discountPct?: number;
  /** Discount in ₹ on the whole line (before tax). When > 0 it wins over discountPct. */
  discountAmt?: number;
  taxRate?: number;
}

export interface LineResult {
  taxable: number;
  tax: number;
  amount: number;
  /** ₹ discount actually applied (2 dp). */
  discount: number;
  /** Discount as % of qty × rate (4 dp), derived when the ₹ amount was given. */
  discountPct: number;
}

/**
 * The discount on one line, from either a ₹ amount or a %, as both numbers.
 * ₹ wins when > 0. Clamped to 0..gross so a line can never go negative.
 */
export function lineDiscount(qty: number, rate: number, discountPct = 0, discountAmt = 0): { amount: number; pct: number } {
  const gross = qty * rate;
  if (gross <= 0) return { amount: 0, pct: 0 };
  if (discountAmt > 0) {
    const amount = r2(Math.min(discountAmt, gross));
    return { amount, pct: r4((amount / gross) * 100) };
  }
  const pct = Math.min(100, Math.max(0, discountPct));
  return { amount: r2((gross * pct) / 100), pct: r4(pct) };
}

export function calcLine(l: LineInput, gstEnabled = true): LineResult {
  const gross = l.qty * l.rate;
  const d = lineDiscount(l.qty, l.rate, l.discountPct ?? 0, l.discountAmt ?? 0);
  const taxable = r2(gross - d.amount);
  const tax = gstEnabled ? r2((taxable * Math.max(0, l.taxRate ?? 0)) / 100) : 0;
  return { taxable, tax, amount: r2(taxable + tax), discount: d.amount, discountPct: d.pct };
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Inter-state supply (IGST) when both states are known and differ.
 * Unknown state on either side -> treated as intra-state (CGST + SGST).
 */
export function isInterState(businessState: string | null | undefined, placeOfSupply: string | null | undefined): boolean {
  const a = norm(businessState);
  const b = norm(placeOfSupply);
  return a !== "" && b !== "" && a !== b;
}

export interface Totals {
  subtotal: number; // sum of taxable values
  discount: number; // total discount given on lines
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
  lines: LineResult[];
}

export function calcTotals(lines: LineInput[], opts: { gstEnabled: boolean; interState: boolean; roundOff?: boolean }): Totals {
  const results = lines.map((l) => calcLine(l, opts.gstEnabled));
  const subtotal = r2(results.reduce((a, l) => a + l.taxable, 0));
  const gross = r2(lines.reduce((a, l) => a + l.qty * l.rate, 0));
  const tax = r2(results.reduce((a, l) => a + l.tax, 0));
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (opts.interState) igst = tax;
  else {
    cgst = r2(tax / 2);
    sgst = r2(tax - cgst);
  }
  const exact = r2(subtotal + tax);
  const total = opts.roundOff === false ? exact : Math.round(exact);
  return { subtotal, discount: r2(gross - subtotal), cgst, sgst, igst, roundOff: r2(total - exact), total, lines: results };
}

// ---------- Amount in words (Indian numbering) ----------

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", rest ? twoDigits(rest) : ""].filter(Boolean).join(" ");
}

function integerWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${integerWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(" ");
}

/** e.g. 1234.5 -> "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only" */
export function amountInWords(amount: number): string {
  const neg = amount < 0;
  const abs = Math.abs(r2(amount));
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  const words = `Rupees ${integerWords(rupees)}${paise ? ` and ${twoDigits(paise)} Paise` : ""} Only`;
  return neg ? `Minus ${words}` : words;
}

// ---------- Voucher kinds ----------

export type VoucherKind =
  | "SALE" | "SALE_RETURN" | "PURCHASE" | "PURCHASE_RETURN"
  | "QUOTATION" | "SALES_ORDER" | "PURCHASE_ORDER" | "CHALLAN";

export const VOUCHER_KINDS: VoucherKind[] = [
  "SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN", "QUOTATION", "SALES_ORDER", "PURCHASE_ORDER", "CHALLAN",
];

export const KIND_LABEL: Record<VoucherKind, string> = {
  SALE: "Sales invoice",
  SALE_RETURN: "Sales return",
  PURCHASE: "Purchase bill",
  PURCHASE_RETURN: "Purchase return",
  QUOTATION: "Quotation",
  SALES_ORDER: "Sales order",
  PURCHASE_ORDER: "Purchase order",
  CHALLAN: "Delivery challan",
};

/** Number prefix per kind. SALE uses the business's invoicePrefix instead. */
export const KIND_PREFIX: Record<VoucherKind, string> = {
  SALE: "INV",
  SALE_RETURN: "SR",
  PURCHASE: "PB",
  PURCHASE_RETURN: "PR",
  QUOTATION: "QT",
  SALES_ORDER: "SO",
  PURCHASE_ORDER: "PO",
  CHALLAN: "DC",
};

/** Stock effect of a kind: OUT, IN or none. */
export function stockEffect(kind: VoucherKind): "IN" | "OUT" | null {
  if (kind === "SALE" || kind === "PURCHASE_RETURN" || kind === "CHALLAN") return "OUT";
  if (kind === "PURCHASE" || kind === "SALE_RETURN") return "IN";
  return null;
}

/** Which kinds each kind may be converted into. */
export const CONVERSIONS: Partial<Record<VoucherKind, VoucherKind[]>> = {
  QUOTATION: ["SALES_ORDER", "SALE"],
  SALES_ORDER: ["SALE"],
  PURCHASE_ORDER: ["PURCHASE"],
  CHALLAN: ["SALE"],
};

/** Purchase-side kinds use the supplier view (cost rates). */
export function isPurchaseSide(kind: VoucherKind): boolean {
  return kind === "PURCHASE" || kind === "PURCHASE_RETURN" || kind === "PURCHASE_ORDER";
}

export function formatNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

// ---------- Editing (owner only) ----------

/** Kinds the owner may edit after saving. Extend this list to allow editing other bills. */
export const EDITABLE_KINDS: VoucherKind[] = ["SALE"];

/** Why a voucher can't be edited, or null if it can. */
export function editBlockReason(kind: VoucherKind, status: string, sourceKind: VoucherKind | null): string | null {
  if (!EDITABLE_KINDS.includes(kind)) return `${KIND_LABEL[kind]}s can't be edited. Cancel it and create a new one.`;
  if (status === "CANCELLED") return "This bill is cancelled and can't be edited.";
  if (status === "CONVERTED") return "This bill was converted into another document and can't be edited.";
  if (sourceKind === "CHALLAN") return "This bill was made from a delivery challan (the stock moved with the challan), so it can't be edited. Cancel it and convert the challan again.";
  return null;
}

/**
 * Net stock a voucher has currently moved, per item + godown, from its ledger entries
 * (original entries plus any edit reversals). Positive = stock added, negative = removed.
 */
export function netStockEffect(entries: { itemId: string; godownId: string; qtyIn: number; qtyOut: number }[]): {
  itemId: string;
  godownId: string;
  qty: number;
}[] {
  const map = new Map<string, { itemId: string; godownId: string; qty: number }>();
  for (const e of entries) {
    const key = `${e.itemId}|${e.godownId}`;
    const cur = map.get(key) ?? { itemId: e.itemId, godownId: e.godownId, qty: 0 };
    cur.qty = Math.round((cur.qty + e.qtyIn - e.qtyOut) * 1000) / 1000;
    map.set(key, cur);
  }
  return [...map.values()].filter((x) => x.qty !== 0);
}

// ---------- Payments at billing (split payment + finance) ----------

export const BILL_PAYMENT_MODES = ["CASH", "CARD", "UPI", "BANK", "CHEQUE", "FINANCE"] as const;
export type BillPaymentMode = (typeof BILL_PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABEL: Record<BillPaymentMode, string> = {
  CASH: "Cash",
  CARD: "Card",
  UPI: "UPI",
  BANK: "Bank transfer",
  CHEQUE: "Cheque",
  FINANCE: "Finance",
};

/** Consumer-durable financiers shown in the FINANCE picker. "Other" lets the user type a name. */
export const FINANCIERS = [
  "Bajaj Finserv",
  "HDFC Bank",
  "HDB Financial Services",
  "TVS Credit",
  "Home Credit",
  "IDFC FIRST Bank",
  "ICICI Bank",
  "Kotak Mahindra Bank",
  "Samsung Finance+",
  "Axis Bank",
] as const;

export const MAX_BILL_PAYMENTS = 6;

export interface BillPaymentInput {
  mode: BillPaymentMode;
  /** For FINANCE: the disbursement amount. */
  amount: number;
  reference?: string;
  financier?: string;
  paymentInfo?: string;
  scheme?: string;
}

/**
 * Check the payments taken with a sales invoice. Returns an error message, or null when OK.
 * - every row > 0; FINANCE rows need financier, payment info and scheme
 * - paid (plus payments already recorded later against the bill) can't exceed the total
 * - a walk-in bill (no party) with payments must be paid in full
 */
export function paymentError(
  rows: BillPaymentInput[],
  opts: { total: number; hasParty: boolean; otherPaid?: number },
): string | null {
  if (rows.length > MAX_BILL_PAYMENTS) return `Use at most ${MAX_BILL_PAYMENTS} payment modes on one bill`;
  for (const [i, p] of rows.entries()) {
    const n = rows.length > 1 ? ` (payment ${i + 1})` : "";
    if (!BILL_PAYMENT_MODES.includes(p.mode)) return `Choose a payment mode${n}`;
    if (!(p.amount > 0)) return p.mode === "FINANCE" ? `Enter the finance disbursement amount${n}` : `Enter the amount for ${PAYMENT_MODE_LABEL[p.mode]}${n}`;
    if (p.mode === "FINANCE") {
      if (!p.financier?.trim()) return `Choose the financier (Bajaj, HDFC…) for the finance payment${n}`;
      if (!p.paymentInfo?.trim()) return `Enter the finance payment info (loan / agreement / DO number)${n}`;
      if (!p.scheme?.trim()) return `Enter the finance scheme details (EMIs, down payment…)${n}`;
    }
  }
  const paid = r2(rows.reduce((a, p) => a + p.amount, 0));
  const other = r2(opts.otherPaid ?? 0);
  if (paid + other > opts.total + 0.005)
    return other > 0
      ? `Payments (₹${paid}) plus ₹${other} already received come to more than the bill total (₹${opts.total})`
      : `Payments (₹${paid}) are more than the bill total (₹${opts.total})`;
  if (!opts.hasParty && rows.length > 0 && Math.abs(paid - opts.total) > 0.005)
    return "A walk-in sale must be fully paid. Pick a customer to sell on credit.";
  return null;
}

const inrWhole = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** "CARD 5,000 · UPI 4,000 · CASH 1,000" / "FINANCE (Bajaj Finserv) 60,000 · CASH 20,000" */
export function paymentSummary(rows: { mode: string; amount: number; financier?: string }[]): string {
  return rows
    .map((p) => `${p.mode}${p.mode === "FINANCE" && p.financier ? ` (${p.financier})` : ""} ${inrWhole(p.amount)}`)
    .join(" · ");
}

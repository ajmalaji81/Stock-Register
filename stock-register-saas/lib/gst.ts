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

export interface LineInput {
  qty: number;
  /** Price per unit before tax. */
  rate: number;
  discountPct?: number;
  taxRate?: number;
}

export interface LineResult {
  taxable: number;
  tax: number;
  amount: number;
}

export function calcLine(l: LineInput, gstEnabled = true): LineResult {
  const gross = l.qty * l.rate;
  const disc = Math.min(100, Math.max(0, l.discountPct ?? 0));
  const taxable = r2(gross * (1 - disc / 100));
  const tax = gstEnabled ? r2((taxable * Math.max(0, l.taxRate ?? 0)) / 100) : 0;
  return { taxable, tax, amount: r2(taxable + tax) };
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

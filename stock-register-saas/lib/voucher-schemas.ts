import { z } from "zod";
import { BILL_PAYMENT_MODES, INDIAN_STATES, MAX_BILL_PAYMENTS, VOUCHER_KINDS } from "./gst";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
const text = (max: number) => z.string().trim().max(max).default("");

export const voucherKind = z.enum(VOUCHER_KINDS as [string, ...string[]]);

export const voucherLineSchema = z.object({
  itemId: z.string().min(1, "Choose an item"),
  description: text(200),
  qty: z.coerce.number().positive("Quantity must be more than 0").max(1e9),
  rate: z.coerce.number().min(0, "Rate must be 0 or more").max(1e10),
  discountPct: z.coerce.number().min(0, "Discount can't be negative").max(100, "Discount can't be more than 100%").default(0),
  /** ₹ discount on the line. When > 0 it is used and the % is worked out from it. */
  discountAmt: z.coerce.number().min(0, "Discount can't be negative").max(1e10).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(0),
});

/** One payment taken with a sales invoice (split payment). FINANCE details are checked in lib/gst.ts paymentError. */
export const billPaymentSchema = z.object({
  mode: z.enum(BILL_PAYMENT_MODES),
  amount: z.coerce.number().min(0).max(1e10),
  reference: text(80),
  financier: text(80),
  paymentInfo: text(120),
  scheme: text(200),
});

export const voucherCreateSchema = z.object({
  kind: voucherKind,
  date,
  partyId: z.string().optional().nullable(),
  godownId: z.string().min(1, "Choose a godown"),
  gstEnabled: z.boolean().default(true),
  placeOfSupply: text(60),
  notes: text(500),
  lines: z.array(voucherLineSchema).min(1, "Add at least one item").max(200),
  /** SALE only: how the customer paid at the counter (split across modes, incl. FINANCE). */
  payments: z.array(billPaymentSchema).max(MAX_BILL_PAYMENTS, `Use at most ${MAX_BILL_PAYMENTS} payment modes`).default([]),
  /** Older single-payment fields. SALE: turned into one payments row. PURCHASE: paid to the supplier. */
  paidNow: z.coerce.number().min(0).max(1e10).default(0),
  paymentMode: z.enum(BILL_PAYMENT_MODES).default("CASH"),
});

/**
 * Editing a saved bill (owner only): same fields as create minus kind / legacy payment fields.
 * `payments` omitted = keep the bill's current payments; an array (even empty) replaces them.
 */
export const voucherEditSchema = voucherCreateSchema
  .omit({ kind: true, paidNow: true, paymentMode: true, payments: true })
  .extend({ payments: z.array(billPaymentSchema).max(MAX_BILL_PAYMENTS).optional() });

export const voucherConvertSchema = z.object({
  to: voucherKind,
  date: date.optional(),
});

export const voucherListSchema = z.object({
  kind: z.string().optional(), // one kind or comma-separated kinds
  partyId: z.string().optional(),
  status: z.enum(["OPEN", "CONVERTED", "CLOSED", "CANCELLED"]).optional(),
  from: date.optional(),
  to: date.optional(),
  q: z.string().trim().max(100).optional(),
});

export const settingsSchema = z.object({
  businessName: text(120),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .refine((v) => v === "" || /^[0-9]{2}[A-Z0-9]{13}$/.test(v), "GSTIN must be 15 characters, e.g. 33ABCDE1234F1Z5")
    .default(""),
  address: text(300),
  state: z
    .string()
    .trim()
    .refine((v) => v === "" || (INDIAN_STATES as readonly string[]).includes(v), "Choose a state from the list")
    .default(""),
  phone: text(30),
  invoicePrefix: z
    .string()
    .trim()
    .max(10)
    .regex(/^[A-Za-z0-9/]*$/, "Prefix can only have letters, numbers and /")
    .default("INV"),
  invoiceTerms: text(1000),
  bankDetails: text(500),
});

export const salesReportSchema = z.object({
  from: date.optional(),
  to: date.optional(),
  side: z.enum(["sales", "purchases"]).default("sales"),
});

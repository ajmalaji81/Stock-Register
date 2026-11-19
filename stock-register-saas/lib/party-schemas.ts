import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
const text = (max: number) => z.string().trim().max(max).default("");
const amount = z.coerce.number().positive("Amount must be more than 0").max(1e11);

export const partyTypeSchema = z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]);
export const modeSchema = z.enum(["CASH", "CARD", "UPI", "BANK", "CHEQUE", "FINANCE"]);

export const partySchema = z.object({
  name: z.string().trim().min(1, "Party name is required").max(120),
  type: partyTypeSchema.default("CUSTOMER"),
  phone: text(20),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email")]).default(""),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .refine((v) => v === "" || /^[0-9A-Z]{15}$/.test(v), "GSTIN must be 15 letters/digits")
    .default(""),
  state: text(60),
  address: text(300),
  /** + they owe us (receivable), − we owe them (payable) */
  openingBalance: z.coerce.number().min(-1e11).max(1e11).default(0),
});

export const partyImportSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "No rows to import").max(2000, "Import at most 2000 parties at a time"),
});

export const partyQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["CUSTOMER", "SUPPLIER", "BOTH", "ALL"]).optional(),
  sort: z.enum(["name", "balance_desc", "balance_asc"]).optional(),
});

export const dateRangeSchema = z.object({
  from: date.optional(),
  to: date.optional(),
});

export const paymentSchema = z.object({
  partyId: z.string().min(1, "Choose a party"),
  direction: z.enum(["IN", "OUT"]),
  amount,
  mode: modeSchema.default("CASH"),
  date,
  reference: text(80),
  notes: text(300),
  voucherId: z.string().optional().nullable(),
});

export const paymentQuerySchema = z.object({
  partyId: z.string().optional(),
  direction: z.enum(["IN", "OUT"]).optional(),
  mode: modeSchema.optional(),
  from: date.optional(),
  to: date.optional(),
});

export const expenseSchema = z.object({
  category: z.string().trim().min(1, "Category is required").max(60),
  amount,
  mode: modeSchema.default("CASH"),
  date,
  notes: text(300),
});

export const expenseQuerySchema = z.object({
  category: z.string().trim().max(60).optional(),
  from: date.optional(),
  to: date.optional(),
});

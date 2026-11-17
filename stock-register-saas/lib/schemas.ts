import { z } from "zod";

const money = z.coerce.number().min(0, "Must be 0 or more").max(1e10);
const qty = z.coerce.number().positive("Quantity must be more than 0").max(1e9);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
const text = (max: number) => z.string().trim().max(max).default("");

export const itemSchema = z.object({
  name: z.string().trim().min(1, "Item name is required").max(120),
  sku: z.string().trim().min(1, "SKU / barcode is required").max(60),
  category: text(60),
  unit: z.string().trim().min(1, "Unit is required").max(20),
  purchasePrice: money,
  salePrice: money,
  minStockAlert: z.coerce.number().min(0).max(1e9),
  hsn: text(20),
  gstRate: z.coerce.number().min(0).max(100).default(0),
  openingQty: z.coerce.number().min(0).max(1e9).optional(),
  openingGodownId: z.string().optional(),
});

export const movementSchema = z.object({
  itemId: z.string().min(1, "Choose an item"),
  godownId: z.string().min(1, "Choose a godown"),
  type: z.enum(["IN", "OUT"]),
  qty,
  rate: money,
  party: text(120),
  remarks: text(300),
  date,
});

export const transferSchema = z.object({
  itemId: z.string().min(1, "Choose an item"),
  fromGodownId: z.string().min(1),
  toGodownId: z.string().min(1),
  qty,
  date,
  remarks: text(300),
});

export const godownSchema = z.object({
  name: z.string().trim().min(1, "Godown name is required").max(60),
});

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const ledgerQuerySchema = z.object({
  itemId: z.string().optional(),
  godownId: z.string().optional(),
  type: z.enum(["OPENING", "IN", "OUT", "TRANSFER_IN", "TRANSFER_OUT", "ADJUSTMENT"]).optional(),
  from: date.optional(),
  to: date.optional(),
});

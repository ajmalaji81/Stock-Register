import { z } from "zod";

const role = z.enum(["STORE_ADMIN", "SALES_PURCHASE", "SALES"], { message: "Choose a role" });
const godownIds = z.array(z.string().min(1)).max(200).default([]);

export const staffCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role,
  godownIds,
});

export const staffUpdateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80).optional(),
  role: role.optional(),
  godownIds: godownIds.optional(),
  active: z.boolean().optional(),
  /** Set to reset the password. */
  password: z.string().min(8, "Password must be at least 8 characters").max(200).optional(),
});

export const adjustmentSchema = z
  .object({
    itemId: z.string().min(1, "Choose an item"),
    godownId: z.string().min(1, "Choose a godown"),
    /** Physical count; the difference from current stock is posted. */
    newQty: z.coerce.number().min(0, "Count can't be negative").max(1e9).optional(),
    /** Or a signed change directly. */
    delta: z.coerce.number().min(-1e9).max(1e9).optional(),
    reason: z.string().trim().min(2, "Reason is required").max(300),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  })
  .refine((v) => (v.newQty === undefined) !== (v.delta === undefined), { message: "Give either the new count or the change, not both" });

export const activityQuerySchema = z.object({
  actorId: z.string().optional(),
  action: z.string().max(60).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  size: z.coerce.number().int().min(1).max(500).default(100),
});

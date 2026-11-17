// Roles and what each may do. Pure (no imports) so the browser can use it to hide buttons;
// the server is what actually enforces it (lib/actor.ts -> requirePermission).

export const PERMISSIONS = [
  "items.manage", // create / edit / delete items, bulk import
  "godowns.manage", // create / rename / delete godowns
  "stock.move", // manual Stock IN / OUT
  "stock.transfer", // godown-to-godown transfer
  "stock.adjust", // stock adjustment entries
  "sales.create", // sales bills + sales returns
  "purchases.create", // purchase bills + purchase returns
  "documents.manage", // quotations, sales orders, purchase orders, challans
  "parties.manage", // customers / suppliers
  "payments.manage", // record payments in / out
  "expenses.manage", // expenses
  "reports.view", // stock / sales / GST / profit reports, ledger
  "costs.view", // see purchase prices, stock value and profit
  "staff.manage", // add / edit staff
  "settings.manage", // business profile, invoice settings
  "billing.upgrade", // buy Lifetime Pro
  "activity.view", // activity timeline
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "OWNER" | "STORE_ADMIN" | "SALES_PURCHASE" | "SALES";
export type StaffRole = Exclude<Role, "OWNER">;

export const STAFF_ROLES: { role: StaffRole; label: string; summary: string }[] = [
  { role: "STORE_ADMIN", label: "Store admin", summary: "Everything except staff, business settings and payments for the app" },
  { role: "SALES_PURCHASE", label: "Sales & purchase operator", summary: "Bills, documents, parties, payments, stock IN/OUT and transfers" },
  { role: "SALES", label: "Sales operator", summary: "Sales bills, quotations, challans, customers and receipts. Cannot see purchase prices or profit" },
];

const ALL = new Set<Permission>(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: ALL,
  STORE_ADMIN: new Set(PERMISSIONS.filter((p) => p !== "staff.manage" && p !== "settings.manage" && p !== "billing.upgrade")),
  SALES_PURCHASE: new Set<Permission>([
    "stock.move", "stock.transfer", "sales.create", "purchases.create", "documents.manage",
    "parties.manage", "payments.manage", "reports.view", "costs.view",
  ]),
  SALES: new Set<Permission>(["sales.create", "documents.manage", "parties.manage", "payments.manage"]),
};

export function roleCan(role: Role, p: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(p);
}

export function roleLabel(role: Role): string {
  return role === "OWNER" ? "Owner" : STAFF_ROLES.find((r) => r.role === role)?.label ?? role;
}

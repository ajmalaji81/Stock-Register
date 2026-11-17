// Shared types used by the server, the browser app and the landing-page demo.

export type EntryType = "OPENING" | "IN" | "OUT" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUSTMENT";
/** TRIAL = free Pro features for the first 90 days after signup. */
export type Plan = "FREE" | "PRO" | "TRIAL";

/** "ALL" or a godown id. */
export type Scope = string;
export const ALL: Scope = "ALL";

export interface Godown {
  id: string;
  name: string;
}

export interface Item {
  id: string;
  name: string;
  sku: string;
  category: string;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  minStockAlert: number;
  hsn: string;
  /** GST percent, e.g. 18 */
  gstRate: number;
  /** godownId -> quantity */
  stock: Record<string, number>;
}

export interface LedgerEntry {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  godownId: string;
  godownName: string;
  type: EntryType;
  qtyIn: number;
  qtyOut: number;
  /** Balance of this item in this godown after the entry. */
  balance: number;
  /** Balance of this item across all godowns after the entry. */
  itemBalance: number;
  rate: number;
  party: string;
  remarks: string;
  date: string; // YYYY-MM-DD
  createdAt: string; // ISO
  transferId: string | null;
  /** Set when a bill created the entry: refType "VOUCHER", refId = voucher id. */
  refType?: string | null;
  refId?: string | null;
  actorName?: string;
}

export interface Limits {
  /** null = unlimited */
  maxItems: number | null;
  maxGodowns: number | null;
}

/** The signed-in person as the browser sees them (owner or staff). */
export interface ActorInfo {
  name: string;
  role: "OWNER" | "STORE_ADMIN" | "SALES_PURCHASE" | "SALES";
  isOwner: boolean;
  /** Permission names from lib/permissions.ts */
  permissions: string[];
  /** Godowns this person may use; null = all */
  godownIds: string[] | null;
  /** Profile picture as a data: URL, or null */
  avatar: string | null;
}

export interface Workspace {
  mode: "demo" | "live";
  actor: ActorInfo;
  user: { name: string; email: string; plan: Plan; trialEndsAt: string | null } | null;
  limits: Limits;
  godowns: Godown[];
  items: Item[];
}

export interface ItemInput {
  name: string;
  sku: string;
  category: string;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  minStockAlert: number;
  hsn?: string;
  gstRate?: number;
  /** Only used when creating. */
  openingQty?: number;
  openingGodownId?: string;
}

export interface MovementInput {
  itemId: string;
  godownId: string;
  type: "IN" | "OUT";
  qty: number;
  rate: number;
  party: string;
  remarks: string;
  date: string;
}

export interface TransferInput {
  itemId: string;
  fromGodownId: string;
  toGodownId: string;
  qty: number;
  date: string;
  remarks: string;
}

export interface LedgerFilter {
  itemId?: string;
  godownId?: string;
  type?: EntryType;
  from?: string;
  to?: string;
}

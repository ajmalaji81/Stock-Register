import type { ComponentType } from "react";
import type { Permission } from "@/lib/permissions";
import ActivitySection from "./ActivitySection";
import AdjustmentsSection from "./AdjustmentsSection";
import BillingReportsSection from "./BillingReportsSection";
import DocumentsSection from "./DocumentsSection";
import ExpensesSection from "./ExpensesSection";
import ImportSection from "./ImportSection";
import PartiesSection from "./PartiesSection";
import PurchasesSection from "./PurchasesSection";
import SalesSection from "./SalesSection";
import SettingsSection from "./SettingsSection";
import StaffSection from "./StaffSection";
import type { SectionProps } from "./types";

/** Core stock screens live in views.tsx; these are rendered by Workspace directly. */
export type CoreTab = "dashboard" | "items" | "ledger" | "reports" | "godowns";

export type SectionKey =
  | "sales" | "purchases" | "documents" | "parties" | "expenses" | "adjustments"
  | "import" | "billreports" | "staff" | "activity" | "settings";

export interface NavEntry {
  key: CoreTab | SectionKey;
  label: string;
  icon: string;
  group: "Stock" | "Billing" | "Money" | "Reports" | "Business";
  /** Visible only if the actor has ANY of these (empty = everyone). */
  anyOf: Permission[];
  /** Only works with a real account (hidden behind a sign-up prompt in the landing demo). */
  liveOnly?: boolean;
  component?: ComponentType<SectionProps>;
}

export const NAV: NavEntry[] = [
  { key: "dashboard", label: "Dashboard", icon: "▦", group: "Stock", anyOf: [] },
  { key: "items", label: "Items", icon: "📦", group: "Stock", anyOf: [] },
  { key: "ledger", label: "Stock ledger", icon: "📒", group: "Stock", anyOf: ["reports.view", "stock.move"] },
  { key: "adjustments", label: "Adjustments", icon: "⚖", group: "Stock", anyOf: ["stock.adjust"], liveOnly: true, component: AdjustmentsSection },
  { key: "godowns", label: "Godowns", icon: "🏬", group: "Stock", anyOf: ["godowns.manage"] },
  { key: "import", label: "Bulk import", icon: "⇪", group: "Stock", anyOf: ["items.manage", "parties.manage"], liveOnly: true, component: ImportSection },

  { key: "sales", label: "Sales", icon: "🧾", group: "Billing", anyOf: ["sales.create"], liveOnly: true, component: SalesSection },
  { key: "purchases", label: "Purchases", icon: "🛒", group: "Billing", anyOf: ["purchases.create"], liveOnly: true, component: PurchasesSection },
  { key: "documents", label: "Quotes & orders", icon: "📄", group: "Billing", anyOf: ["documents.manage"], liveOnly: true, component: DocumentsSection },

  { key: "parties", label: "Parties", icon: "👥", group: "Money", anyOf: ["parties.manage", "payments.manage"], liveOnly: true, component: PartiesSection },
  { key: "expenses", label: "Expenses", icon: "💸", group: "Money", anyOf: ["expenses.manage"], liveOnly: true, component: ExpensesSection },

  { key: "reports", label: "Stock reports", icon: "📊", group: "Reports", anyOf: ["reports.view"] },
  { key: "billreports", label: "Sales & GST", icon: "₹", group: "Reports", anyOf: ["reports.view"], liveOnly: true, component: BillingReportsSection },

  { key: "staff", label: "Staff", icon: "🧑‍💼", group: "Business", anyOf: ["staff.manage"], liveOnly: true, component: StaffSection },
  { key: "activity", label: "Activity", icon: "🕒", group: "Business", anyOf: ["activity.view"], liveOnly: true, component: ActivitySection },
  { key: "settings", label: "Settings", icon: "⚙", group: "Business", anyOf: ["settings.manage"], liveOnly: true, component: SettingsSection },
];

export const NAV_GROUPS: NavEntry["group"][] = ["Stock", "Billing", "Money", "Reports", "Business"];

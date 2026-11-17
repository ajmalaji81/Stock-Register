"use client";

import VoucherBook from "../billing/VoucherBook";
import type { SectionProps } from "./types";

export default function PurchasesSection(props: SectionProps) {
  return (
    <VoucherBook
      props={props}
      title="Purchases"
      subtitle="Supplier bills that add stock to the godown, plus returns that send it back."
      tabs={[
        { kind: "PURCHASE", label: "Purchase bills" },
        { kind: "PURCHASE_RETURN", label: "Purchase returns" },
      ]}
    />
  );
}

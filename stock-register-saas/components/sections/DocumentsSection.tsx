"use client";

import VoucherBook, { type BookTab } from "../billing/VoucherBook";
import type { SectionProps } from "./types";

export default function DocumentsSection(props: SectionProps) {
  const tabs: BookTab[] = [
    { kind: "QUOTATION", label: "Quotations" },
    { kind: "SALES_ORDER", label: "Sales orders" },
    { kind: "CHALLAN", label: "Delivery challans" },
    // Purchase orders show supplier prices, so only roles that can see costs get them.
    ...(props.can("costs.view") ? [{ kind: "PURCHASE_ORDER", label: "Purchase orders" } as BookTab] : []),
  ];
  return (
    <VoucherBook
      props={props}
      title="Quotes, orders & challans"
      subtitle="Quotations and orders don't move stock; a delivery challan sends goods out. Convert any of them into a bill in one tap."
      tabs={tabs}
    />
  );
}

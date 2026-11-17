"use client";

import VoucherBook from "../billing/VoucherBook";
import type { SectionProps } from "./types";

export default function SalesSection(props: SectionProps) {
  return (
    <VoucherBook
      props={props}
      title="Sales"
      subtitle="GST invoices that take stock out of the godown, plus returns that bring it back."
      tabs={[
        { kind: "SALE", label: "Sales invoices" },
        { kind: "SALE_RETURN", label: "Sales returns" },
      ]}
    />
  );
}

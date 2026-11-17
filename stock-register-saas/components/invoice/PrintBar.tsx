"use client";

import Link from "next/link";

/** Screen-only toolbar above a printable invoice. */
export default function PrintBar({ id, format, token }: { id: string; format: "a4" | "t58" | "t80"; token?: string }) {
  const href = (f: string) => `/print/voucher/${id}?format=${f}${token ? `&t=${encodeURIComponent(token)}` : ""}`;
  const pill = (f: "a4" | "t58" | "t80", label: string) => (
    <Link
      href={href(f)}
      className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${format === f ? "bg-ink text-paper" : "border-2 border-ink/20 bg-paper"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-center gap-2 border-b-2 border-ink/10 bg-surface px-3 py-3 print:hidden">
      {pill("a4", "A4")}
      {pill("t80", "Thermal 80mm")}
      {pill("t58", "Thermal 58mm")}
      <button
        onClick={() => window.print()}
        className="btn-3d btn-edge-in rounded-lg bg-in px-4 py-1.5 text-sm font-bold text-white"
      >
        🖨 Print / Save PDF
      </button>
    </div>
  );
}

import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const font = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });

export const metadata: Metadata = {
  title: "GodownBook — Godown Stock, GST Billing & Khata",
  description:
    "GodownBook: stock across shop and godowns, GST bills that move stock, party ledgers, expenses, staff access, low-stock alerts and printable reports.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0f0c" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={font.variable}>
      <body className="font-sans">{children}</body>
    </html>
  );
}

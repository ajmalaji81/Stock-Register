import Link from "next/link";
import { headers } from "next/headers";
import { currentUser } from "@/lib/auth";
import { countryFromHeaders, formatUsd, priceFor } from "@/lib/ppp";
import DemoPanel from "@/components/DemoPanel";
import IsoGodown from "@/components/IsoGodown";
import Logo from "@/components/Logo";
import Pricing from "@/components/Pricing";

type Tone = "in" | "out" | "low" | "ink" | "brand";

const FEATURE_GROUPS: { title: string; blurb: string; items: [string, Tone, string, string][] }[] = [
  {
    title: "Stock",
    blurb: "Know what's on every shelf, in every godown.",
    items: [
      ["🏬", "in", "Godowns & transfers", "Run Main Shop, Godown A and Godown B side by side. Move stock between them with a two-sided entry that always balances."],
      ["📒", "ink", "Stock khata", "Every IN and OUT with date, party, rate and remarks, plus a running balance after each line. History can't be quietly rewritten."],
      ["⚠️", "low", "Low-stock alerts", "Set a minimum per item and see what needs reordering the moment you open the app."],
    ],
  },
  {
    title: "Billing",
    blurb: "Bills that move stock for you.",
    items: [
      ["🧾", "in", "GST invoices", "CGST / SGST / IGST worked out from HSN and tax rate. Print on A4 or a thermal printer, or send the bill on WhatsApp."],
      ["📝", "ink", "Quotes, orders & challans", "Send a quotation, take an order or dispatch on a delivery challan, then turn it into a bill in one tap."],
      ["↩️", "out", "Returns & profit per bill", "Sales and purchase returns put stock back where it belongs. See the margin on every bill you make."],
    ],
  },
  {
    title: "Money & team",
    blurb: "Who owes you, what you spent, who did what.",
    items: [
      ["🤝", "in", "Parties & receivables", "Customers and suppliers with their own ledger. See dues at a glance and send a WhatsApp reminder."],
      ["💸", "out", "Payments & expenses", "Record money in and out by cash, bank or UPI. Track rent, salary and transport by category."],
      ["👥", "ink", "Staff roles & godown access", "Give staff their own login, limit them to certain godowns and hide purchase prices. Every action is logged."],
    ],
  },
];

const STEPS: [string, string][] = [
  ["Add items & godowns", "Type them in or import a spreadsheet. Opening stock goes straight into the khata."],
  ["Record stock and bills", "Stock IN, OUT, transfer, or make a bill — stock updates itself."],
  ["Read the reports", "Stock summary, low stock, item ledger, sales and GST. Export CSV or save as PDF."],
];

const FAQ: [string, string][] = [
  ["How does the free trial work?", "Every new account gets all Pro features for 90 days. After that you can stay on the Free plan (5 items, 2 godowns) or pay once for Lifetime Pro. Nothing you entered is ever deleted."],
  ["Is it really a one-time payment?", "Yes. Lifetime Pro is a single payment with no subscription and no renewal."],
  ["Why is the price different in my country?", "We use fair, purchasing-power-based pricing. Your discount is applied automatically based on where you are."],
  ["Can it make GST bills?", "Yes. Add your GSTIN and each item's HSN and tax rate, and bills split tax into CGST/SGST or IGST automatically."],
  ["Can someone edit old entries?", "No. Mistakes are fixed with a new entry, so your khata always adds up and has a full history."],
  ["Is the demo above real?", "It's the actual stock register running in your browser with sample data. Nothing you do there is saved to our servers."],
];

const TILE: Record<Tone, string> = {
  in: "bg-brand-soft text-in",
  out: "bg-out/12 text-out",
  low: "bg-low/15 text-low",
  ink: "bg-surface text-ink",
  brand: "bg-brand text-ink",
};

export default async function Home() {
  const [user, h] = await Promise.all([currentUser(), headers()]);
  const price = priceFor(countryFromHeaders(h));
  const startHref = user ? "/app" : "/signup";

  return (
    <div className="min-h-full overflow-x-hidden">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-ink/10 bg-paper/85 backdrop-blur-md print:hidden">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Logo />
          <nav className="flex items-center gap-2 text-sm font-semibold sm:gap-5">
            <a href="#features" className="hidden hover:text-in md:inline">Features</a>
            <a href="#demo" className="hidden hover:text-in sm:inline">Live demo</a>
            <a href="#pricing" className="hidden hover:text-in sm:inline">Pricing</a>
            {user ? (
              <Link href="/app" className="btn-3d btn-edge-ink mb-1 rounded-xl bg-ink px-3 py-2 text-paper">Open my book</Link>
            ) : (
              <>
                <Link href="/login" className="px-1">Log in</Link>
                <Link href="/signup" className="btn-3d btn-edge-ink mb-1 rounded-xl bg-ink px-3 py-2 text-paper">Start free</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-dots print:hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-6 px-4 pb-12 pt-10 sm:pt-14 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
          <div>
            <p className="icon-tile mb-4 rounded-full bg-paper px-3 py-1 text-xs font-bold uppercase tracking-wide text-in">
              Godown · Shop · Billing · Khata
            </p>
            <h1 className="text-4xl font-bold leading-[1.04] tracking-tight sm:text-6xl">
              Every bag, box and bill.{" "}
              <span className="relative whitespace-nowrap">
                <span className="relative z-10">One book.</span>
                <span aria-hidden className="absolute inset-x-0 bottom-1 z-0 h-3 rounded bg-brand/35 sm:h-4" />
              </span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink/75">
              GodownBook keeps stock across your shop and godowns, makes GST bills that move stock for you, and tracks who owes what — from any phone.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href={startHref} className="btn-3d btn-edge-in mb-1 rounded-xl bg-in px-5 py-3 font-bold text-white">
                {user ? "Open my book" : "Start 90-day free Pro trial"}
              </Link>
              <a href="#demo" className="btn-3d btn-edge-ghost mb-1 rounded-xl border-2 border-ink bg-paper px-5 py-3 font-bold">
                Try the live demo ↓
              </a>
            </div>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-ink/70">
              <li>✓ No card needed</li>
              <li>✓ Works on any phone</li>
              <li>✓ Lifetime from {formatUsd(price.amountCents)}</li>
            </ul>
          </div>

          <div className="relative">
            <IsoGodown />
            <div className="card-3d float absolute left-0 top-4 px-3 py-2 text-sm sm:left-2">
              <div className="text-xs font-bold uppercase tracking-wide text-ink/55">Stock IN</div>
              <div className="font-bold text-in">+20 Bags · Rice 25kg</div>
            </div>
            <div className="card-3d float float-delay absolute bottom-6 right-0 px-3 py-2 text-sm sm:right-2">
              <div className="text-xs font-bold uppercase tracking-wide text-ink/55">Bill #1042</div>
              <div className="font-bold text-out">−6 Bags · ₹12,900</div>
            </div>
            <div className="card-3d-dark float absolute bottom-24 left-2 hidden px-3 py-2 text-sm sm:block">
              <div className="text-xs font-bold uppercase tracking-wide text-paper/60">Stock value</div>
              <div className="font-bold">₹4,52,300</div>
            </div>
          </div>
        </div>
      </section>

      {/* Live demo */}
      <section id="demo" className="scroll-mt-20 py-12 print:py-0">
        <div className="mx-auto max-w-6xl px-4 print:px-0">
          <div className="mb-5 print:hidden">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Live demo — click everything</h2>
            <p className="text-ink/70">A sample shop with two godowns. Add stock, sell, transfer, export. Limited to 5 items; billing, parties and staff come with your account.</p>
          </div>
          <div className="card-3d overflow-hidden print:rounded-none print:border-0">
            <DemoPanel />
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20 bg-dots py-14 print:hidden">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">Everything a paper register and bill book do. None of the mistakes.</h2>
          <div className="mt-10 space-y-10">
            {FEATURE_GROUPS.map((g) => (
              <div key={g.title}>
                <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
                  <h3 className="text-xl font-bold">{g.title}</h3>
                  <p className="text-sm text-ink/60">{g.blurb}</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map(([icon, tone, title, body]) => (
                    <article key={title} className="card-3d tilt p-5">
                      <span aria-hidden className={`icon-tile h-12 w-12 text-2xl ${TILE[tone]}`}>{icon}</span>
                      <h4 className="mt-4 font-bold">{title}</h4>
                      <p className="mt-1 text-sm text-ink/70">{body}</p>
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-sm text-ink/60">Plus: bulk item import, stock adjustments, sales & GST reports, CSV export and print / save as PDF on every report.</p>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-14 print:hidden">
        <h2 className="mb-8 text-3xl font-bold tracking-tight">Up and running in an afternoon</h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="card-3d flex gap-4 p-5">
              <span aria-hidden className="icon-tile h-12 w-12 bg-ink text-xl text-brand">{i + 1}</span>
              <div>
                <h3 className="font-bold">{title}</h3>
                <p className="mt-1 text-sm text-ink/70">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-20 bg-dots py-14 print:hidden">
        <div className="mx-auto max-w-3xl px-4">
          <h2 className="text-3xl font-bold tracking-tight">Pay once. Use it forever.</h2>
          <p className="mb-8 mt-2 text-ink/70">Every new account gets a 90-day Pro trial. After that, stay on Free or pay once for Lifetime Pro.</p>
          <Pricing
            price={price}
            freeCta={
              <Link href={startHref} className="btn-3d btn-edge-ghost mb-1 block rounded-xl border-2 border-ink bg-paper py-2.5 text-center font-semibold">
                {user ? "Open my book" : "Start free trial"}
              </Link>
            }
            proCta={
              <Link href={user ? "/upgrade" : "/signup"} className="btn-3d btn-edge-in mb-1 block rounded-xl bg-brand py-3 text-center font-bold text-ink">
                {user ? "Get Lifetime Pro" : "Start free, upgrade anytime"}
              </Link>
            }
          />
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-4 py-14 print:hidden">
        <h2 className="mb-6 text-3xl font-bold tracking-tight">Questions</h2>
        <div className="space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="card-3d group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold">
                {q}
                <span aria-hidden className="icon-tile h-7 w-7 shrink-0 bg-surface text-sm transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-ink/75">{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-4 pb-14 print:hidden">
        <div className="card-3d-dark mx-auto flex max-w-6xl flex-col items-start gap-5 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold sm:text-3xl">Close the paper register for good.</h2>
            <p className="mt-1 text-paper/70">90 days of every Pro feature, free. No card.</p>
          </div>
          <Link href={startHref} className="btn-3d btn-edge-in mb-1 shrink-0 rounded-xl bg-brand px-6 py-3 font-bold text-ink">
            {user ? "Open my book" : "Start free trial"}
          </Link>
        </div>
      </section>

      <footer className="border-t border-ink/10 px-4 py-8 text-sm text-ink/60 print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <Logo />
          <span>© {new Date().getFullYear()} GodownBook · Payments secured by Dodo Payments</span>
        </div>
      </footer>
    </div>
  );
}

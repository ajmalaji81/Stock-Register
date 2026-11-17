import type { ReactNode } from "react";
import { formatUsd, type PppPrice } from "@/lib/ppp";

const FREE = ["First 90 days: every Pro feature", "Then up to 5 items & 2 godowns", "Stock IN / OUT / Transfer", "Ledger, reports, CSV & PDF"];
const PRO = ["Unlimited items", "Unlimited godowns & transfers", "Everything in Free", "All future updates", "Pay once — no subscription"];

function List({ items, tick }: { items: string[]; tick: string }) {
  return (
    <ul className="mt-4 space-y-2 text-sm">
      {items.map((t) => (
        <li key={t} className="flex gap-2">
          <span aria-hidden className={`font-bold ${tick}`}>✓</span>
          {t}
        </li>
      ))}
    </ul>
  );
}

export function PriceTag({ price }: { price: PppPrice }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-4xl font-bold">{formatUsd(price.amountCents)}</span>
        {price.discountPct > 0 && <span className="text-lg text-ink/50 line-through">{formatUsd(price.baseCents)}</span>}
        <span className="text-sm text-ink/60">one time</span>
      </div>
      {price.discountPct > 0 && price.country && (
        <p className="mt-2 inline-block rounded-md bg-in/12 px-2 py-1 text-xs font-bold text-in">
          {price.discountPct}% fair-price discount for {price.country} applied automatically
        </p>
      )}
      <p className="mt-2 text-xs text-ink/60">Charged in your local currency at checkout where available.</p>
    </div>
  );
}

export default function Pricing({ price, proCta, freeCta }: { price: PppPrice; proCta: ReactNode; freeCta: ReactNode }) {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="card-3d tilt flex flex-col p-6">
        <h3 className="text-lg font-bold">Free</h3>
        <div className="mt-2 text-4xl font-bold">$0</div>
        <List items={FREE} tick="text-in" />
        <div className="mt-auto pt-6">{freeCta}</div>
      </div>
      <div className="card-3d-dark tilt relative flex flex-col p-6">
        <span className="icon-tile absolute -top-3 right-5 rounded-full bg-brand px-3 py-1 text-xs font-bold text-ink">BEST VALUE</span>
        <h3 className="text-lg font-bold">Lifetime Pro</h3>
        <div className="mt-2 [&_.text-in]:text-brand [&_.text-ink\/50]:text-paper/50 [&_.text-ink\/60]:text-paper/60">
          <PriceTag price={price} />
        </div>
        <List items={PRO} tick="text-brand" />
        <div className="mt-auto pt-6">{proCta}</div>
      </div>
    </div>
  );
}

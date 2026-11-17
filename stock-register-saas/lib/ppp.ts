// Purchasing-power-parity pricing for the one-time Lifetime Pro purchase.
// The country comes ONLY from a header your host sets (Vercel / Cloudflare), never from
// anything the visitor can choose, so the discount can't be picked by hand.

const TIERS: { multiplier: number; countries: string[] }[] = [
  // ~60% off
  { multiplier: 0.4, countries: ["IN", "PK", "BD", "NP", "LK", "MM", "KH", "LA", "NG", "GH", "KE", "UG", "TZ", "ET", "EG", "ZW", "ZM", "MW", "MZ", "RW", "SN", "CM", "CI", "AF", "BT", "MV", "UZ", "KG", "TJ"] },
  // ~50% off
  { multiplier: 0.5, countries: ["ID", "PH", "VN", "MA", "DZ", "TN", "BO", "PY", "HN", "NI", "GT", "SV", "UA", "MD", "GE", "AM", "AZ", "MN", "JO", "LB", "IQ", "IR", "SY", "YE"] },
  // ~30% off
  { multiplier: 0.7, countries: ["BR", "MX", "AR", "CO", "PE", "CL", "EC", "TR", "ZA", "TH", "MY", "RU", "BY", "KZ", "RS", "BA", "MK", "AL", "ME", "RO", "BG", "DO", "JM", "PA", "CR", "UY", "CN"] },
];

export interface PppPrice {
  country: string | null;
  baseCents: number;
  amountCents: number;
  discountPct: number;
}

export function basePriceCents(): number {
  const n = Number(process.env.LIFETIME_PRICE_CENTS ?? 2900);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 2900;
}

export function countryFromHeaders(h: Headers): string | null {
  const dev = process.env.PPP_DEV_COUNTRY?.trim();
  if (dev && process.env.NODE_ENV !== "production") return dev.toUpperCase();
  const name = (process.env.PPP_COUNTRY_HEADER || "x-vercel-ipcountry").toLowerCase();
  const v = h.get(name)?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1" ? v : null;
}

export function priceFor(country: string | null): PppPrice {
  const baseCents = basePriceCents();
  const tier = country ? TIERS.find((t) => t.countries.includes(country)) : undefined;
  const multiplier = tier?.multiplier ?? 1;
  // Round to whole dollars-ish, never below $1.
  const amountCents = Math.max(100, Math.round((baseCents * multiplier) / 100) * 100);
  return { country, baseCents, amountCents, discountPct: Math.round((1 - amountCents / baseCents) * 100) };
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

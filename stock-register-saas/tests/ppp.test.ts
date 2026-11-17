import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { countryFromHeaders, priceFor } from "../lib/ppp.ts";

const KEYS = ["LIFETIME_PRICE_CENTS", "PPP_COUNTRY_HEADER", "PPP_DEV_COUNTRY", "NODE_ENV"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

function setEnv(vars: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) delete env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
}

test("priceFor(null) and unknown countries pay the base price", () => {
  setEnv({ LIFETIME_PRICE_CENTS: "2900" });
  assert.deepEqual(priceFor(null), { country: null, baseCents: 2900, amountCents: 2900, discountPct: 0 });
  assert.equal(priceFor("US").amountCents, 2900);
  assert.equal(priceFor("ZZ").amountCents, 2900);
});

test("India gets the 40% tier, rounded to a whole dollar", () => {
  setEnv({ LIFETIME_PRICE_CENTS: "2900" });
  const p = priceFor("IN");
  assert.equal(p.amountCents, 1200); // 2900 * 0.4 = 1160 -> $12
  assert.equal(p.amountCents % 100, 0);
  assert.equal(p.discountPct, 59);
  assert.equal(priceFor("BR").amountCents, 2000); // 0.7 tier: 2030 -> $20
});

test("invalid base price falls back to 2900", () => {
  setEnv({ LIFETIME_PRICE_CENTS: "abc" });
  assert.equal(priceFor(null).baseCents, 2900);
});

test("countryFromHeaders reads the configured header only", () => {
  setEnv({ NODE_ENV: "production" });
  assert.equal(countryFromHeaders(new Headers({ "x-vercel-ipcountry": "in" })), "IN");
  assert.equal(countryFromHeaders(new Headers({ "cf-ipcountry": "IN" })), null);

  setEnv({ NODE_ENV: "production", PPP_COUNTRY_HEADER: "CF-IPCountry" });
  assert.equal(countryFromHeaders(new Headers({ "cf-ipcountry": "BR" })), "BR");
  assert.equal(countryFromHeaders(new Headers({ "x-vercel-ipcountry": "IN" })), null);
});

test("countryFromHeaders ignores XX, T1 and garbage", () => {
  setEnv({ NODE_ENV: "production" });
  for (const v of ["XX", "T1", "IND", "1N", "", "I N"]) {
    assert.equal(countryFromHeaders(new Headers({ "x-vercel-ipcountry": v })), null, `value ${JSON.stringify(v)}`);
  }
  assert.equal(countryFromHeaders(new Headers()), null);
});

test("PPP_DEV_COUNTRY overrides outside production only", () => {
  setEnv({ NODE_ENV: "development", PPP_DEV_COUNTRY: "in" });
  assert.equal(countryFromHeaders(new Headers({ "x-vercel-ipcountry": "US" })), "IN");

  setEnv({ NODE_ENV: "production", PPP_DEV_COUNTRY: "IN" });
  assert.equal(countryFromHeaders(new Headers({ "x-vercel-ipcountry": "US" })), "US");
  assert.equal(countryFromHeaders(new Headers()), null);
});

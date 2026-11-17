# CLAUDE.md - Project Rules

GodownBook is a stock, GST billing and khata SaaS for Indian shops, godowns and small warehouses.
- **Stock:** multi-godown stock and transfers, an immutable stock ledger, adjustments, low-stock alerts and reports.
- **Billing:** GST bills, returns, quotations, orders and challans, printable invoices.
- **Money:** parties and payments, expenses, cash book.
- **Team:** staff roles and an activity log.
- **Pricing:** a 90-day Pro trial, then Free or a one-time Lifetime Pro purchase via Dodo Payments with PPP pricing.

> The `agents/`, `skills/` and `.claude/commands/` folders came from the FastAPI template this folder started from. They **do not apply** to this codebase.

---

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript 5
- **Styling:**
  - Tailwind CSS v4: `@theme` tokens and the soft-3D classes are in `app/globals.css`.
  - Space Grotesk font via `next/font`.
- **Database:** Prisma 6 + SQLite (`prisma/dev.db`); can be switched to Postgres/Supabase.
- **Auth:**
  - Email + password (bcryptjs).
  - The session is an HS256 JWT (jose) in the httpOnly cookie `sr_session`, with `{ sub, kind: "owner" | "staff" }`.
- **Validation:** zod schemas in `lib/*schemas.ts`.
- **Payments:**
  - Dodo Payments SDK (`dodopayments`) for checkout.
  - `standardwebhooks` for webhook verification.

---

## Project Structure

```
app/
  page.tsx                   Landing: isometric 3D hero (IsoGodown), live demo, features, pricing (PPP), FAQ
  login/, signup/            Auth pages
  app/page.tsx               Signed-in app (currentActor -> AppShell -> Workspace)
  upgrade/, upgrade/success/ Lifetime Pro checkout + confirmation (polls /api/me)
  print/voucher/[id]/        Printable invoice: A4 / t58 / t80; ?t=<share token> for public sale links
  api/                       auth, me, workspace, items(+import), godowns, movements, transfers, adjustments,
                             ledger, vouchers(+cancel/convert), settings, reports/sales, parties(+ledger/import),
                             payments(+reverse), expenses, cashbook, staff, activity, checkout, webhooks/dodo
components/
  Workspace.tsx              App shell: grouped sidebar (wide) / bottom tab bar + More sheet (narrow), location
                             switcher, plan badge, modals, toasts. Container-query based (also runs in the demo frame)
  views.tsx, modals.tsx      Core stock screens (Dashboard, Items, Ledger, Reports, Godowns) + Item/Stock/Transfer forms
  sections/registry.ts       NAV entries: key, label, icon, group, anyOf permissions, liveOnly, component
  sections/types.ts          SectionProps { ws, scope, scopeName, version, refresh, notify, can }
  sections/*Section.tsx      Sales, Purchases, Documents, BillingReports, Settings, Parties, Expenses,
                             Staff, Activity, Import, Adjustments
  billing/, parties/, staff/, invoice/   Section helpers (API clients, editors, forms, print bar)
  ui.tsx                     Design system: Button, Field, Input, Select, Modal, Stat, Badge, Empty, Card,
                             SectionHeader, IconTile, Tabs, money/qty formatters, downloadCsv
  IsoGodown.tsx, Logo.tsx, Pricing.tsx, AppShell.tsx, DemoPanel.tsx, Auth*.tsx, UpgradeButton.tsx
lib/
  actor.ts                   Session -> Actor (accountId, owner, role, godownIds, can); requireActor,
                             requirePermission, assertCan, assertGodownAccess, actorInfo
  permissions.ts             PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES (pure; browser-safe)
  activity.ts                logActivity(db, actor, "area.verb", detail)
  stock-service.ts           loadWorkspace, applyStockEntry (THE stock mutation path), items, godowns,
                             movements, transfers, listLedger
  voucher-service.ts         Bills/documents: create, cancel (reversal), convert, list, share tokens, reports
  gst.ts                     Pure GST math, states, number prefixes, stock effect per kind, amount in words
  party-service.ts, money.ts Parties, balances, party ledger, payments, expenses, cash book (money.ts is pure)
  staff-service.ts, import.ts Staff accounts; pure CSV/TSV parser + column mapping
  engine.ts                  Pure stock rules + in-memory demo register (import type only)
  store.ts                   StockStore: apiStore (HTTP) and createDemoStore (localStorage)
  plans.ts                   FREE / PRO / DEMO limits, 90-day trial (effectivePlan, trialDaysLeft)
  ppp.ts, dodo.ts            PPP price tiers + country header; Dodo client
  auth.ts, db.ts, http.ts    Session cookie, Prisma client, handle() route wrapper
  types.ts, schemas.ts, *-schemas.ts
prisma/schema.prisma         User (+ business profile, plan, trial), Godown, Item (+hsn, gstRate), Stock,
                             LedgerEntry (+refType/refId/actorName), Party, Voucher, VoucherLine, PartyPayment,
                             Expense, StaffMember, ActivityLog, Payment, WebhookEvent
tests/                       node:test unit tests (engine, gst, party/money, import, permissions, plans, ppp)
```

---

## Architecture rules

- **Scope everything by account.** Every query on business data filters by `actor.accountId`, the owner's `User.id`. Staff act on the owner's account. Another account's record returns 404.
- **Authorise on the server.** Start routes with `requirePermission("…")`, or call `requireActor()` and then `assertCan()`. Call `assertGodownAccess(actor, godownId)` for anything tied to a godown, and filter lists by `actor.godownIds`. UI hiding is only cosmetic.
- **Stock changes only via `applyStockEntry(tx, actor, …)`**, inside `prisma.$transaction`.
  - It covers bills, returns, cancellations, adjustments and opening stock.
  - Never update `Stock.quantity` directly.
  - Removals are conditional atomic updates, so stock can't go negative.
- **Immutable history.**
  - Ledger entries, vouchers and payments are never edited or deleted.
  - Cancel a voucher to post reversing entries; reverse a payment with an opposite payment.
  - Items used on vouchers can't be deleted.
- **Calculate money on the server.** Voucher totals come from `lib/gst.ts`; never trust totals sent by the client. Within a state the tax is CGST + SGST, between states IGST, and the total rounds to the nearest rupee.
- **Hide costs.** Without `costs.view`, strip purchase price, cost rate, cost total, stock value and profit from responses, and hide purchase-side documents.
- **Log every change.** Every mutation calls `logActivity(tx, actor, "area.verb", detail)` inside the same transaction. Add new action labels to `ACTION_LABELS` in `components/sections/ActivitySection.tsx`.
- **Enforce plan limits on the server.**
  - Use `assertWithinLimit` with `limitsFor(actor.owner)`, which returns 402 with code `LIMIT`.
  - Staff need `effectivePlan(owner)` to be PRO or TRIAL.
- **Validate every request.** Validate every body and query with zod. Wrap handlers in `handle()` from `lib/http.ts`. Throw `StockError(message, status, code)` for expected failures.
- **Next 16:** route `params` is a `Promise`; use `await params`.

## UI rules

- **New screens:**
  - Add a `components/sections/XSection.tsx` that takes `SectionProps`.
  - Register it in `components/sections/registry.ts` with `anyOf` permissions, and set `liveOnly: true` if the demo can't run it.
  - Call `props.refresh()` after anything that changes items, godowns or stock.
- **Responsive layout:** the workspace is a CSS container, so use container-query variants (`@lg:`, `@2xl:`, `@4xl:`) inside it, not `sm:` / `lg:`. It also renders inside the landing-page demo frame.
- **Components and styles:**
  - Use the `ui.tsx` components and the 3D classes: `card-3d`, `card-3d-dark`, `tilt`, `well`, `icon-tile`, `table-3d`, `pop-in`.
  - Buttons get the raised 3D style from `Button`.
  - Green means stock or money in, red means out, amber means low stock.
- **Accessibility and print:**
  - Respect `prefers-reduced-motion`, and keep focus-visible rings.
  - Use `print:hidden` on chrome; tables print flat.
- Format money with `money()` (INR) and quantities with `qty()`.

## Code rules

- TypeScript: no `any`.
- Quantities round to 3 decimal places (`round3`), money to 2 (`round2`). Both are stored as SQLite `Float`.
- No secrets in code; read them from env. Never log passwords or tokens.
- Keep pure modules (`engine.ts`, `gst.ts`, `money.ts`, `import.ts`, `permissions.ts`, `plans.ts`, `ppp.ts`) free of DB and React imports (`import type` only), so `npm test` can run them directly.

---

## Commands

```bash
npm run dev         # http://localhost:3000
npm run build       # production build
npm run typecheck   # tsc --noEmit
npm test            # node:test unit tests in tests/
npm run db:push     # apply prisma/schema.prisma (stop the dev server first on Windows)
npm run db:studio   # browse data
```

---

## Environment Variables

See `.env.example`.

```env
DATABASE_URL="file:./dev.db"
AUTH_SECRET=""                    # 32+ random chars; also signs invoice share tokens
NEXT_PUBLIC_APP_URL="http://localhost:3000"
DODO_PAYMENTS_API_KEY=""
DODO_PAYMENTS_ENVIRONMENT="test_mode"   # or live_mode
DODO_WEBHOOK_SECRET=""
DODO_PRODUCT_ID=""
LIFETIME_PRICE_CENTS="2900"       # USD cents before PPP
PPP_COUNTRY_HEADER="x-vercel-ipcountry"
PPP_DEV_COUNTRY=""                # dev only, e.g. IN
```

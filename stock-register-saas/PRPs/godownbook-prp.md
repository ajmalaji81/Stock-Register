# PRP: GodownBook

> Implementation blueprint, kept in sync with the code as built. The product definition is in `INITIAL.md`, and the coding rules are in `CLAUDE.md`.

---

## METADATA

| Field | Value |
|-------|-------|
| **Product** | GodownBook (formerly StockRegister) |
| **Type** | SaaS (web, mobile-first) |
| **Version** | 2.0 |
| **Updated** | 2026-11-17 |
| **Complexity** | High |

---

## OVERVIEW

GodownBook is a stock, GST billing and khata book for Indian shops and godowns. Its value is that stock, bills, parties and staff all live in one place: an always-correct stock balance, GST bills that move stock, and party balances that add up.

Pricing is a 90-day Pro trial, then Free (5 items, 2 godowns, no staff) or a one-time Lifetime Pro purchase with PPP pricing through Dodo Payments.

---

## TECH STACK

| Layer | Technology |
|-------|------------|
| App | Next.js 16 App Router, React 19, TypeScript |
| UI | Tailwind v4 + soft-3D design system (`components/ui.tsx`, `app/globals.css`), Space Grotesk |
| Data | Prisma 6 + SQLite (switchable to Postgres) |
| Auth | bcryptjs + jose JWT cookie; owner and staff sessions |
| Validation | zod |
| Payments | Dodo Payments SDK + Standard Webhooks |
| Tests | node:test on pure modules |

---

## DATA MODEL (`prisma/schema.prisma`)

- **User** (the account owner):
  - plan (`FREE` / `PRO`), proSince, trialEndsAt
  - business profile: businessName, gstin, address, state, phone, invoicePrefix, invoiceTerms, bankDetails
- **Godown**, **Item** (sku unique per account; hsn, gstRate), **Stock** (item × godown quantity).
- **LedgerEntry:** type OPENING / IN / OUT / TRANSFER_IN / TRANSFER_OUT / ADJUSTMENT; qtyIn, qtyOut, balance, itemBalance, rate, party, remarks, transferId, refType + refId (the voucher), actorName, date.
- **Party:** CUSTOMER / SUPPLIER / BOTH, phone, gstin, state, openingBalance (+ receivable).
- **Voucher:**
  - kind: SALE / PURCHASE / SALE_RETURN / PURCHASE_RETURN / QUOTATION / SALES_ORDER / PURCHASE_ORDER / CHALLAN
  - number (unique per account + kind), status OPEN / CONVERTED / CLOSED / CANCELLED
  - interState, taxes (cgst / sgst / igst), roundOff, total, costTotal, sourceId
- **VoucherLine:** qty, rate, discountPct, taxRate, taxable, tax, amount, costRate.
- **PartyPayment** (direction IN / OUT, mode, optional voucherId), **Expense**.
- **StaffMember:** belongs to the owner; email unique, role, godownIds JSON, active.
- **ActivityLog**, **Payment** (Dodo payments), **WebhookEvent** (idempotency).

---

## CORE MECHANISMS

1. **Actor scoping** (`lib/actor.ts`): the session (owner or staff) resolves to `{ accountId, owner, role, godownIds, can() }`. Every query uses `accountId`. Routes use `requirePermission` and `assertGodownAccess`.
2. **Permissions** (`lib/permissions.ts`): 17 permissions and the roles OWNER, STORE_ADMIN, SALES_PURCHASE and SALES. The server enforces them, and the UI hides nav entries and buttons using `ws.actor.permissions`.
3. **Stock mutation** (`applyStockEntry` in `lib/stock-service.ts`):
   - The only way stock changes. It checks godown access, does a conditional atomic decrement (no negatives) and writes the ledger entry, all inside the caller's transaction.
   - Transfers move both sides first, so the paired entries carry the same all-godown total.
4. **Vouchers** (`lib/voucher-service.ts` + `lib/gst.ts`):
   - Totals are calculated on the server: discount, then GST. Within a state the tax is CGST + SGST, between states IGST (business state vs party state). The total is rounded to the nearest rupee.
   - Stock effect by kind:
     - SALE, PURCHASE_RETURN and CHALLAN take stock OUT.
     - PURCHASE and SALE_RETURN put stock IN.
     - Quotations and orders don't move stock.
     - Converting a challan to a sale doesn't move stock again.
   - Cancel reverses the stock entries. Bills are never edited.
   - A signed share token (HMAC with `AUTH_SECRET`) gives a public link to a sale-side invoice.
5. **Party balance** (`lib/money.ts`): opening + SALE − SALE_RETURN − PURCHASE + PURCHASE_RETURN − payments IN + payments OUT, counting only vouchers that aren't cancelled. It's computed with grouped queries.
6. **Plans** (`lib/plans.ts`): `effectivePlan(owner)` → PRO / TRIAL / FREE. `limitsFor` caps items and godowns on FREE with a 402 `LIMIT` error. Staff accounts need PRO or TRIAL.
7. **Cost hiding:** without `costs.view`, purchase prices, cost rates, stock value, profit and purchase-side documents are removed from responses.
8. **Audit:** `logActivity` runs inside every mutation's transaction.
9. **Demo:** the landing page runs the real stock UI against an in-browser register (`lib/engine.ts` + `createDemoStore`). Business sections show a sign-up prompt.

---

## MODULES → FILES

| Module | API | UI |
|---|---|---|
| Auth, plans, checkout | `api/auth/*`, `api/me`, `api/checkout`, `api/webhooks/dodo` | `login`, `signup`, `upgrade`, `upgrade/success` |
| Stock | `api/workspace`, `api/items` (+`[id]`, `import`), `api/godowns`, `api/movements`, `api/transfers`, `api/adjustments`, `api/ledger` | `views.tsx`, `modals.tsx`, `AdjustmentsSection`, `ImportSection` |
| Billing & GST | `api/vouchers` (+`[id]`, `cancel`, `convert`), `api/settings`, `api/reports/sales`, page `print/voucher/[id]` | `SalesSection`, `PurchasesSection`, `DocumentsSection`, `BillingReportsSection`, `SettingsSection`, `components/billing/*` |
| Parties & money | `api/parties` (+`[id]`, `ledger`, `import`), `api/payments` (+`reverse`), `api/expenses`, `api/cashbook` | `PartiesSection`, `ExpensesSection`, `components/parties/*` |
| Team | `api/staff` (+`[id]`), `api/activity` | `StaffSection`, `ActivitySection` |
| Shell & design | — | `Workspace.tsx` (sidebar / bottom tab bar, container queries), `sections/registry.ts`, `ui.tsx`, `globals.css`, `IsoGodown.tsx`, landing `app/page.tsx` |

---

## VALIDATION GATES

| Gate | Command |
|------|---------|
| Types | `npm run typecheck` |
| Unit tests | `npm test` (engine, gst, party/money, import, permissions, plans, ppp) |
| Build | `npm run build` |
| Smoke | `npm run dev`, then sign up and run: item → bill → stock drops → party balance → payment → cancel → stock restored; staff login with a restricted role; signed webhook → PRO |

---

## OUT OF SCOPE / NEXT

- **Not built yet:**
  - Manufacturing / BOM / job work
  - e-invoice (IRN) and e-way bill generation
  - `.xlsx` import
  - Offline mode and an Android app
  - Password reset, Google login, email verification
  - Batch / expiry tracking
  - Approval workflow for staff entries
- **Possible:** store money as integer paise instead of Float.

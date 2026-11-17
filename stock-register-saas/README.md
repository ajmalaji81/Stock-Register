# GodownBook

Stock, GST billing and khata for shops, godowns and small warehouses.
- **Stock:** track stock across the shop and every godown, with an immutable ledger.
- **Bills:** raise GST bills that move stock automatically.
- **Money:** keep party balances and payments, record expenses, and read the cash book.
- **Staff:** give staff role-based access limited to their godowns.

New accounts get every Pro feature free for 90 days. After that, stay on Free or pay once for **Lifetime Pro** through Dodo Payments, with the price set fairly for each country (PPP).

Built with Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Prisma 6 + SQLite, and Dodo Payments.

---

## Features

### Stock
- **Godowns and transfers.** Multiple godowns, a location switcher that includes **All Locations**, and godown-to-godown transfers.
- **Item master.** Each item has a name, SKU or barcode, category, unit, purchase and sale price, minimum-stock alert, HSN code and GST rate, plus a quantity breakdown per godown.
- **Stock ledger (khata).**
  - Every entry is recorded: OPENING, IN, OUT, TRANSFER, ADJUSTMENT, and entries posted by bills.
  - Each entry shows the date, party, quantity, rate, remarks, who made it, and the running balance (per godown and across all godowns).
  - Entries are immutable.
- **Stock adjustments.** Enter either a physical count or a +/− change, with a required reason.
- **Dashboard.** Stock value, SKU count, low-stock alerts, today's IN vs OUT, and quick IN / OUT / Transfer buttons.
- **Stock reports.** Stock summary, low stock and item-wise ledger, each with CSV export and print / save as PDF.

### Billing and GST
- **Documents.** Sales bills, purchase bills, sales and purchase returns, quotations, sales orders, purchase orders and delivery challans.
- **Convert.** Quotation → sales order or sale; sales order → sale; purchase order → purchase; challan → sale. A challan's stock moves only once.
- **GST.**
  - Totals are calculated on the server: line discount %, GST %, and CGST + SGST within a state or IGST between states (business state vs party state).
  - The total is rounded to the nearest rupee, and the amount is written out in words in lakh/crore.
- **Stock effect.** Bills move stock automatically. If any line doesn't have enough stock, the whole bill is refused.
- **Cancel.** Cancelling reverses the bill's stock entries. Bills are never edited or deleted.
- **Printable invoice.**
  - Sizes: A4, 58 mm thermal and 80 mm thermal.
  - Shows the business header, GSTIN, HSN, tax breakup, bank details and terms.
  - A WhatsApp share link uses a signed token, so the customer can open a sale invoice without logging in.
- **Pay at billing time.** Record a payment received or paid when you create a sale or purchase.
- **Sales and GST reports.**
  - Sales and purchase registers.
  - A GSTR-1-style summary by rate and HSN, split into B2B and B2C.
  - Profit by item, party and bill (only for roles that can see costs).
- **Business settings.** Name, GSTIN, address, state, phone, invoice prefix, terms and bank details.

### Parties, payments and expenses
- **Customers and suppliers.** Each party shows its balance: receivable (+) or payable (−). Totals appear at the top.
- **Party ledger.** Opening balance, bills, returns and payments, with a running balance, CSV export and print.
- **Payments.** Received (IN) or paid (OUT), by cash, bank, UPI or cheque. A payment is never deleted; undo it with a reversal entry.
- **WhatsApp reminders.** A link with the amount due and your business name.
- **Expenses.** By category, with monthly totals. An expense can only be deleted on the day it was recorded.
- **Cash book.** Opening and closing cash and bank, with day-wise movement.

### Team
- **Profile pictures.** Owners and staff can upload their own photo from **My profile** (click your avatar in the header). The browser crops it to a square and shrinks it to 256×256 JPEG before upload; it is stored in the database as a small data URL (PNG/JPEG/WebP only, max ~110 KB). Shown in the header and on staff cards. API: `GET/PATCH /api/profile`.
- **Staff logins.** Staff work under the owner's account. Each person gets a role and, optionally, a list of godowns they can use. Staff need Pro or the trial.
- **Activity timeline.** Who did what, filterable and exportable to CSV.
- **Bulk import.** Load items or parties from CSV or from cells pasted out of Excel, with a preview and a result for each row.

### Product
- **Landing page.**
  - A pure-CSS isometric 3D godown scene and feature sections.
  - A **live demo**: the real stock UI running in the browser with sample data (stock features only; billing and the rest need an account).
  - Pricing adjusted per country, and an FAQ.
- **Soft-3D look.** Raised cards, tilt on hover, raised 3D buttons, a sidebar on wide screens and a bottom tab bar on phones. Animations turn off when the device asks for reduced motion, and printouts are flat.

---

## Plans

| Plan | Items | Godowns | Staff | Where data lives |
|------|-------|---------|-------|------------------|
| Demo (landing page) | 5 | 3 | — | The visitor's browser (localStorage); stock features only |
| Pro trial (first 90 days of every new account) | Unlimited | Unlimited | Yes | Server database |
| Free (after the trial) | 5 | 2 | No | Server database |
| Lifetime Pro (one-time payment) | Unlimited | Unlimited | Yes | Server database |

How the plan logic works (`lib/plans.ts`):
- `User.trialEndsAt` is set at signup to 90 days later (`TRIAL_DAYS`).
- `effectivePlan()` returns `PRO` (bought), `TRIAL` (still running) or `FREE`.
- When the trial ends nothing is deleted: existing items and godowns keep working, and only creating more than the Free limits is blocked (HTTP 402, code `LIMIT`).
- On Free, staff can't be created or reactivated.

---

## Roles and permissions

The owner has every permission. Staff get one role (`lib/permissions.ts`). The server enforces permissions; the UI only hides what a role can't use.

| Permission | Store admin | Sales & purchase operator | Sales operator |
|---|:-:|:-:|:-:|
| `items.manage`: items and bulk item import | ✓ | | |
| `godowns.manage` | ✓ | | |
| `stock.move`: manual Stock IN / OUT | ✓ | ✓ | |
| `stock.transfer` | ✓ | ✓ | |
| `stock.adjust` | ✓ | | |
| `sales.create`: sales bills and returns | ✓ | ✓ | ✓ |
| `purchases.create`: purchase bills and returns | ✓ | ✓ | |
| `documents.manage`: quotations, orders, challans | ✓ | ✓ | ✓ |
| `parties.manage` | ✓ | ✓ | ✓ |
| `payments.manage` | ✓ | ✓ | ✓ |
| `expenses.manage` | ✓ | | |
| `reports.view` | ✓ | ✓ | |
| `costs.view`: purchase prices, stock value, profit | ✓ | ✓ | |
| `activity.view` | ✓ | | |
| `staff.manage` | | | |
| `settings.manage` | | | |
| `billing.upgrade`: buy Lifetime Pro | | | |

What restricted staff see:
- **Godown access:** a staff member assigned to specific godowns only sees and uses those godowns.
- **Hidden costs:** without `costs.view`, purchase prices, stock value, cost rates and profit are removed from API responses, and purchase-side documents are hidden.

---

## Quick start

Requires Node.js 20.9+.

```bash
npm install
```

npm 11 blocks package install scripts unless they're approved. Prisma needs them to download its engine, and the approval is already recorded in `package.json` under `allowScripts`. If npm still asks, run:

```bash
npm install-scripts approve prisma @prisma/client @prisma/engines
npm rebuild prisma @prisma/engines @prisma/client
```

Create your env file and a session secret:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into AUTH_SECRET
```

Create the database and start the app:

```bash
npm run db:push
npm run dev
```

Open http://localhost:3000.
- The demo works immediately.
- Sign up to use the real app; new accounts start on the 90-day trial.
- Checkout needs the Dodo setup below.

On Windows, stop the dev server before running `npm run db:push` or `prisma generate`, because the Prisma engine file is locked while it runs.

### Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests in `tests/` (Node test runner, TypeScript run directly) |
| `npm run db:push` | Apply `prisma/schema.prisma` |
| `npm run db:studio` | Browse the database |

---

## Dodo Payments setup

1. **Create a product** in the Dodo dashboard: a **one-time** payment product, for example "GodownBook Lifetime Pro".
2. **Make it Pay-What-You-Want**, with a minimum price **at or below the cheapest PPP price**. The default cheapest price is $12, which is 40% of $29.
   - The app sends the country-adjusted `amount` with each checkout.
   - If the product is *not* PWYW, Dodo ignores `amount` and charges the fixed price, so PPP silently stops working.
3. *(Optional)* **Enable adaptive pricing** so buyers pay in their local currency. The app pre-fills the billing country when it knows it.
4. **Create a webhook** pointing to `<NEXT_PUBLIC_APP_URL>/api/webhooks/dodo`, subscribed to `payment.succeeded`, and copy its signing secret.
5. **Set env vars** in `.env`:

   ```env
   DODO_PAYMENTS_API_KEY="..."
   DODO_PAYMENTS_ENVIRONMENT="test_mode"   # live_mode in production
   DODO_WEBHOOK_SECRET="whsec_..."
   DODO_PRODUCT_ID="pdt_..."
   NEXT_PUBLIC_APP_URL="https://your-domain"
   ```

The payment flow:
1. The owner clicks **Get Lifetime Pro**, and `POST /api/checkout` creates a Dodo checkout session with `metadata.userId`. This is owner-only (`billing.upgrade`).
2. The buyer pays, and Dodo calls the webhook.
3. The app verifies the signature and sets the user to `PRO`.
4. `/upgrade/success` sees the new plan and confirms.

The webhook is idempotent, so retries are safe. To test webhooks locally, expose port 3000 with a tunnel such as ngrok or cloudflared, and use that URL in step 4.

### PPP pricing

- **Base price:** `LIFETIME_PRICE_CENTS` (default `2900` = $29).
- **Tiers** live in `lib/ppp.ts`:
  - 60% off, for example IN, PK, BD, NG, KE
  - 50% off, for example ID, PH, VN, UA
  - 30% off, for example BR, MX, TR, ZA

  Prices round to whole dollars, with a minimum of $1.
- **Country source:** the country comes **only** from the header your host sets, named by `PPP_COUNTRY_HEADER` (Vercel: `x-vercel-ipcountry`, Cloudflare: `cf-ipcountry`). Visitors can't pick it.
- **Caveat:** if the app isn't deployed behind a host that sets *and overwrites* that header, a visitor can send the header themselves and get the discount.
- **Local testing:** set `PPP_DEV_COUNTRY=IN`. It's ignored in production.

---

## API overview

Every route except auth, the webhook and the shared print link needs a session. Requests are validated with zod, and errors come back as `{ error, code? }`. The permission names match the table above. "Signed in" means any owner or active staff member, with the data still filtered to their godowns and cost visibility.

| Method | Path | Permission |
|---|---|---|
| POST | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout` | none (login accepts the owner or active staff) |
| GET | `/api/me`, `/api/workspace`, `/api/ledger` | signed in |
| POST | `/api/items` · PATCH/DELETE `/api/items/[id]` · POST `/api/items/import` | `items.manage` |
| POST | `/api/godowns` · PATCH/DELETE `/api/godowns/[id]` | `godowns.manage` |
| POST | `/api/movements` | `stock.move` |
| POST | `/api/transfers` | `stock.transfer` |
| GET/POST | `/api/adjustments` | `stock.adjust` |
| GET | `/api/vouchers` · `/api/vouchers/[id]` | signed in (only the kinds and godowns the role may see) |
| POST | `/api/vouchers` · `/api/vouchers/[id]/cancel` | depends on the kind: `sales.create`, `purchases.create` or `documents.manage` |
| POST | `/api/vouchers/[id]/convert` | the create permission for both the source and target kind |
| GET / PUT | `/api/settings` | GET signed in; PUT `settings.manage` |
| GET | `/api/reports/sales?side=sales\|purchases` | `reports.view` (purchases also need `costs.view`) |
| GET | `/api/parties` · `/api/parties/[id]` · `/api/parties/[id]/ledger` | `parties.manage` or `payments.manage` |
| POST | `/api/parties` · PATCH/DELETE `/api/parties/[id]` · POST `/api/parties/import` | `parties.manage` |
| GET/POST | `/api/payments` · POST `/api/payments/[id]/reverse` | `payments.manage` |
| GET/POST | `/api/expenses` · DELETE `/api/expenses/[id]` (same day only) | `expenses.manage` |
| GET | `/api/cashbook` | `reports.view` or `payments.manage` |
| GET/POST | `/api/staff` · PATCH/DELETE `/api/staff/[id]` | `staff.manage`, plus Pro or trial to create or reactivate |
| GET | `/api/activity` | `activity.view` |
| POST | `/api/checkout` | `billing.upgrade` |
| POST | `/api/webhooks/dodo` | Standard Webhooks signature |
| page | `/print/voucher/[id]?format=a4\|t58\|t80[&t=token]` | same account, or a valid share token (sale-side documents only) |

---

## Architecture

- **One account, many actors.**
  - All business rows hang off the owner's `User.id`. `lib/actor.ts` resolves the session, owner or staff, into an `Actor` with `accountId`, `role`, `godownIds` and `can()`.
  - Every query filters by `actor.accountId`. Another account's record returns 404.
- **Permissions on the server.**
  - Routes use `requirePermission()` / `assertCan()` and `assertGodownAccess()`.
  - The browser gets `actor.permissions` only to hide buttons and nav entries.
- **One way to change stock.**
  - `applyStockEntry(tx, actor, …)` in `lib/stock-service.ts` is the only stock mutation path for manual entries, bills, returns, cancellations and adjustments. Transfers use the same internal atomic update.
  - Removals are conditional atomic updates (`quantity >= qty`), so concurrent requests can't push stock below zero.
- **Immutable records.**
  - Ledger entries, bills and payments are never edited.
  - Cancelling a bill posts reversing stock entries, and a payment is undone with a reversal payment.
- **Server-calculated money.** The browser sends only items, quantities, rates, discount % and GST %. `lib/gst.ts`, a pure module, calculates every total.
- **Cost hiding.** Without `costs.view`, purchase prices, cost rates, stock value and profit are stripped from responses (`loadWorkspace`, `listLedger`, voucher and report services).
- **Audit trail.** Every mutation calls `logActivity()` inside its transaction.
- **One UI, two backends.**
  - The stock screens talk to a `StockStore` (`lib/store.ts`). The app uses `apiStore` (HTTP), and the landing demo uses an in-browser register built on `lib/engine.ts`.
  - Business screens are section components (`components/sections/*`) listed in `components/sections/registry.ts`.
- **Plan upgrades only via the verified webhook.** Upgrades are idempotent, using `WebhookEvent` and the unique `Payment.dodoPaymentId`.

---

## Moving to Postgres / Supabase

1. In `prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`.
2. Set `DATABASE_URL` to your Postgres or Supabase connection string.
3. Run `npm run db:push`.

The stock logic uses conditional atomic updates, so it stays correct under concurrency on Postgres too.

---

## Known limitations

- **Imports:** CSV or text pasted from Excel only. `.xlsx` isn't read; save it as "CSV UTF-8" first.
- **GST filing:** no e-invoice (IRN) or e-way bill generation, and no GSTR filing. Reports are summaries for your accountant.
- **Missing features:** no offline mode, no manufacturing / BOM / job work, no password reset, and no Google login.
- **Rounding:** quantities and money are stored as floats and rounded to 3 decimals (quantity) and 2 decimals (money).
- **List limits:** the ledger view loads at most the 2,000 most recent matching entries. Voucher lists are capped at 500 and party lists at 2,000, so use date filters for older history.
- **Entry order:** running balances follow the order entries were recorded, not the entered date, so back-dated entries show the balance at the time they were recorded.
- **Deleting items:** an item that appears on any bill can't be deleted. Deleting an item that has no bills also deletes its ledger history.
- **Landing demo:** covers stock features only; billing, parties, staff and the rest need an account.
- **Share links:** invoice share links use a signed token, but anyone holding the link can view that sale invoice.
- **Currency:** prices display in INR (₹), while the Lifetime price is charged in USD.
- **Trial abuse:** a new trial can be had by signing up with a new email. There's no email verification.

---

## Project layout

```
app/                 pages (landing, auth, /app, /upgrade, /print/voucher/[id]) and API routes (app/api/**)
components/          Workspace (app shell + nav), views/modals (stock screens), ui.tsx (3D design system),
                     sections/* (business screens + registry), billing/, parties/, staff/, invoice/, IsoGodown
lib/                 actor, permissions, activity, stock-service, voucher-service, party-service, staff-service,
                     gst, money, import, engine, plans, ppp, dodo, schemas
prisma/schema.prisma User, Godown, Item, Stock, LedgerEntry, Party, Voucher, VoucherLine, PartyPayment,
                     Expense, StaffMember, ActivityLog, Payment, WebhookEvent
tests/               node:test unit tests (engine, gst, money/party, import, permissions, plans, ppp)
```

The `agents/`, `skills/` and `.claude/commands/` folders came from the FastAPI template this project started from. They don't apply to this codebase.

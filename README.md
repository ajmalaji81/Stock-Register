# Stock Register → GodownBook

This repository holds **GodownBook**, a stock register for Indian shops, godowns and small warehouses. It covers stock, GST billing, the khata (ledger) and staff.

It started as a "stock register" exercise and grew into a full SaaS app:

- **Stock:** multi-godown stock, transfers and an immutable ledger
- **Billing:** GST bills and invoices
- **Money:** parties, payments and expenses
- **Team:** staff roles
- **Payments:** sold as a one-time Lifetime Pro purchase through Dodo Payments

The app lives in [`stock-register-saas/`](stock-register-saas/). Its README is the full manual: features, setup, API reference, architecture and limitations.

---

## Repository layout

| Path | What it is |
|---|---|
| [`stock-register-saas/`](stock-register-saas/) | **The GodownBook app** (Next.js 16, React 19, TypeScript, Tailwind v4, Prisma + SQLite, Dodo Payments) |
| `stock-register-saas/README.md` | Full product and developer documentation |
| `stock-register-saas/CLAUDE.md` | Coding rules and architecture notes for AI-assisted development |
| `stock-register-saas/INITIAL.md`, `stock-register-saas/PRPs/godownbook-prp.md` | Product definition and implementation blueprint |

---

## What GodownBook does

- **Stock:**
  - Godowns and transfers between them, with an "All Locations" view.
  - An item master with HSN codes and GST rates.
  - A stock ledger (khata) with running balances.
  - Stock adjustments, low-stock alerts, and reports with CSV export and print / save as PDF.
- **Billing and GST:**
  - Sales and purchase bills that move stock automatically, plus returns.
  - Quotations, orders and delivery challans that convert into bills.
  - GST split as CGST + SGST within a state, or IGST between states.
  - Printable A4 and thermal invoices that can be shared on WhatsApp.
  - Sales, GST and profit reports.
- **Money:**
  - Customers and suppliers, with what each owes you or you owe them.
  - A ledger per party, payments in and out, and WhatsApp payment reminders.
  - Expenses and a cash and bank book.
- **Team:**
  - Staff logins with three roles: Store admin, Sales & purchase, and Sales.
  - Each staff member can be limited to chosen godowns.
  - Purchase prices and profit are hidden from the Sales role.
  - An activity timeline, and bulk CSV import of items and parties.
- **Plans:**
  - A live demo on the landing page, with no signup.
  - Every new account gets a 90-day free Pro trial.
  - After the trial: Free (5 items, 2 godowns) or a one-time **Lifetime Pro** purchase.
  - The Lifetime Pro price is adjusted by country (purchasing-power parity).
- **Design:**
  - A soft-3D UI with a pure-CSS isometric warehouse on the landing page.
  - Mobile-first layout: a sidebar on desktop and a bottom tab bar on phones.

---

## Quick start

Requirements: **Node.js 20.9+** (developed on Node 24) and npm.

```bash
cd stock-register-saas
npm install                 # npm 11 may ask to approve Prisma's install scripts; they are pre-approved in package.json
cp .env.example .env        # then set AUTH_SECRET (see below)
npm run db:push             # creates the SQLite database
npm run dev                 # http://localhost:3000
```

Generate `AUTH_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open http://localhost:3000. Try the demo on the landing page, or click **Start 90-day free Pro trial** to create an account. Then fill in **Settings** (business name, state and GSTIN) before making bills: the invoices and the GST split depend on them.

Payments are optional for local use. To enable checkout, follow the Dodo Payments setup in [`stock-register-saas/README.md`](stock-register-saas/README.md).

---

## Useful commands

Run these inside `stock-register-saas/`:

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit tests (stock engine, GST, parties, plans, permissions, CSV import) |
| `npm run db:push` | Apply `prisma/schema.prisma` to the database |
| `npm run db:studio` | Browse the data in Prisma Studio |

On Windows, stop the dev server before running `db:push` or `prisma generate`, because the running server locks Prisma's engine file.

---

## Status

- **Built and verified:**
  - Typecheck, unit tests and the production build pass.
  - Two automated end-to-end runs passed against the API: billing and parties (108 checks), and staff, roles and stock (52 of 53, the miss being a fault in the test itself).
- **Not done yet:**
  - Hands-on browser testing of every screen.
  - Excel `.xlsx` import (CSV only for now).
  - E-invoice and e-way bill generation.
  - Offline mode, and manufacturing / BOM.
  - Password reset and Google login.
  - Docker and deployment configuration.
- **Before going live:**
  - Configure Dodo Payments (a Pay-What-You-Want product so country pricing works, plus the webhook).
  - Deploy behind Vercel or Cloudflare so the visitor-country header can't be forged.
  - Consider moving from SQLite to Postgres.

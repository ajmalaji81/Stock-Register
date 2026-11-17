# INITIAL.md - GodownBook

> Product definition as built. See `PRPs/godownbook-prp.md` for the implementation blueprint.

---

## PRODUCT

**Name:** GodownBook

**Description:** An online stock, GST billing and khata book for Indian retail shops, wholesalers, distributors and anyone who keeps stock in godowns.
- **Stock:** track it across the shop and godowns, with an immutable ledger.
- **Billing:** raise GST bills that move stock, then print or share them on WhatsApp.
- **Money:** track what each party owes, record payments and expenses.
- **Staff:** give each staff member role-based access limited to their godowns.

**Type:** SaaS. It runs as a web app on any phone or PC, with a live in-browser demo on the landing page.

**Monetization:**
- A 90-day free Pro trial for every new account.
- Then a Free plan (5 items, 2 godowns, no staff) or a one-time **Lifetime Pro** purchase through Dodo Payments.
- The Lifetime price is set fairly per country (PPP).

---

## TECH STACK

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16 App Router + React 19 + TypeScript |
| UI | Tailwind CSS v4, soft-3D design system (`ui.tsx`, `globals.css`), Space Grotesk |
| Database | Prisma 6 + SQLite (Postgres/Supabase-ready) |
| Auth | Email + password (bcryptjs), JWT session cookie (jose); owner and staff logins |
| Validation | zod |
| Payments | Dodo Payments one-time checkout + Standard Webhooks; PPP via Pay-What-You-Want amount |

---

## MODULES

### 1. Accounts, plans & staff
- **Signup and login.** Owner signup creates the "Main Shop" godown and starts the 90-day trial. Login accepts the owner or an active staff member.
- **Staff.** Three roles: Store admin, Sales & purchase operator, Sales operator. Each staff member can be limited to chosen godowns. Staff need Pro or the trial.
- **Activity timeline.** A record of every change.
- **Lifetime Pro.** Dodo checkout with PPP pricing; the webhook upgrades the account.

### 2. Stock
- **Models:** Godown, Item (incl. HSN and GST rate), Stock (item × godown), LedgerEntry.
- **Features:**
  - Items and godowns.
  - Stock IN and OUT, godown-to-godown transfers, and adjustments with a required reason.
  - An immutable ledger with running balances per godown and across all godowns.
  - Bulk import of items from CSV.
  - A dashboard and low-stock alerts.
  - Stock reports: summary, low stock and item-wise ledger, with CSV and print.

### 3. Billing & GST
- **Models:** Voucher, VoucherLine, plus the business profile on User.
- **Document kinds:** SALE, PURCHASE, SALE_RETURN, PURCHASE_RETURN, QUOTATION, SALES_ORDER, PURCHASE_ORDER, CHALLAN.
- **Convert and cancel:** documents convert into bills, and cancelling a bill posts reversing entries.
- **GST:**
  - Calculated on the server: CGST + SGST within a state, IGST between states.
  - The total is rounded to the nearest rupee, and the amount is printed in words.
- **Invoices:** printable in A4, 58 mm and 80 mm thermal; shareable on WhatsApp through a signed link.
- **Reports:** sales and purchase registers, a GSTR-1-style summary, and profit (for roles that can see costs).

### 4. Parties & money
- **Models:** Party, PartyPayment, Expense.
- **Party balances:** what each party owes you or you owe them, plus a party ledger and WhatsApp payment reminders.
- **Payments:** received and paid. A payment is undone with a reversal, never deleted.
- **Expenses:** grouped by category.
- **Cash book:** cash and bank totals.
- **Bulk import:** parties from CSV.

---

## MVP SCOPE (built)

- [x] Owner and staff auth, roles, godown-level access, activity log
- [x] Multiple godowns, transfers, adjustments, immutable stock ledger
- [x] GST bills, returns, quotations, orders, challans, convert and cancel
- [x] A4 and thermal invoices, WhatsApp share, GST and profit reports
- [x] Parties, balances, payments, reminders, expenses, cash book
- [x] Bulk CSV import of items and parties
- [x] 90-day trial, Free limits, Lifetime Pro via Dodo with PPP
- [x] Soft-3D responsive UI, landing page with a live demo

**Not built:** manufacturing / BOM, e-invoice / e-way bill generation, offline mode, `.xlsx` import, password reset / Google login.

---

## ACCEPTANCE CRITERIA

- [x] One account's data is never visible to another account, and staff see only their assigned godowns
- [x] Stock never goes negative, even with simultaneous requests
- [x] A bill that would go negative on any line is refused entirely
- [x] Bill totals and GST are calculated on the server
- [x] Roles without cost access never receive purchase prices or profit
- [x] Every change appears in the activity log
- [x] Unit tests pass (`npm test`), the code type-checks, and the production build succeeds

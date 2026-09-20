# Accounting Implementation Plan

Status of the phased build. Updated 2026-09-20.

## Decisions taken

- **Accounting lives in the CRM; inventory quantity stays in the ERP**, read
  over the existing `postgres_fdw` contract rather than duplicated.
- **The books are in Vyapar today.** Opening balances migrate from Vyapar
  exports with a parallel-run reconciliation.
- **Urvar is a registered regular GST taxpayer** — full CGST/SGST/IGST, place
  of supply and ITC are in scope. No rate is hardcoded without sign-off.

## Phase 1 — accounting foundation · **DONE**

Migration `20260920011115_accounting_foundation`, strictly additive.

- `Company`, `LedgerAccount`, `FinancialPeriod`, `JournalEntry`, `JournalLine`,
  `AccountMapping`, `DocumentSeries`, `TaxRate`
- `src/lib/accounting/` — `money`, `fiscal`, `company`, `account-map`,
  `numbering`, `chart-of-accounts`, `posting`
- `scripts/seed-accounting.ts` — 68 accounts, 24 mappings, 12 periods, 1
  unverified tax rate. Dry-run by default, idempotent.
- RBAC: 4 new modules, new `approve` action, all 5 roles filled,
  `assertCanApprove()` for separation of duties
- `logAudit()` accepts a transaction client; `prisma/seed.ts` wipe list
  repaired and guarded against running over a live ledger
- Vitest + 62 tests
- `/accounting`, `/accounting/journal`, `/accounting/periods`

**Verification:** `npm run lint` clean, `npm run build` clean (all three routes
registered), `npm test` 62/62, `prisma migrate status` no drift before or
after, seed idempotent on re-run, ledger empty after the test suite.

### Known deviations from the original plan

- `command` / `popover` / `calendar` shadcn primitives were **not** added.
  Phase 1's UI needs none of them; they are a Phase 2 prerequisite for invoice
  entry and should be added with the first form that needs one.
- The three divergent `inr()` formatters were **not** consolidated.
  `money.ts` exports a paise-accurate `formatInr()` used by all accounting UI,
  but `constants/labels.ts`'s `inr()` still pins `maximumFractionDigits: 0`
  across every CRM list view. Changing it alters displayed totals app-wide and
  belongs with Phase 2's financial reporting, not buried in a foundation
  commit.

## Phase 2 — sales invoicing and receivables · **DONE (core), gated for go-live**

Migration `20260920045650_sales_invoicing`, strictly additive: `OrderItem`,
`SalesInvoice`, `SalesInvoiceItem` (snapshotting `hsnCode`, `taxRatePercent`,
CGST/SGST/IGST and `taxableValue` at issue time — fixes R6), `Receipt`,
`ReceiptAllocation`, `CreditNote`, `CreditNoteItem` (schema only; posting not
yet wired — see below).

**Delivered:**
- `src/lib/accounting/tax.ts` — place-of-supply, the CGST/SGST vs IGST split,
  and per-line pricing, refusing an unverified `TaxRate` row rather than
  guessing (13 tests)
- `src/lib/accounting/invoicing.ts` — `createInvoiceFromOrder()` prices every
  line through the tax engine and posts a balanced entry in one transaction;
  supports partial invoicing via `quantityInvoiced` tracking; `cancelInvoice()`
  reverses rather than deletes and refuses while a receipt is allocated
  (11 tests)
- `src/lib/accounting/receipts.ts` — `recordReceipt()` allocates across
  invoices with an over-allocation guard, routes any unallocated remainder to
  `ADVANCE_FROM_CUSTOMER`, and keeps each invoice's DRAFT/POSTED/
  PARTIALLY_PAID/PAID status in step; `cancelReceipt()` reverses and reopens
  the invoice (10 tests)
- `src/lib/accounting/receivables.ts` — **closes R1.** `customerReceivable()`
  derives the true balance from posted AR lines; `syncCustomerOutstanding()`
  writes it back and is called automatically after every invoice/receipt
  post or cancel; `reconcileOutstandingAmounts()` is the audit report
  (8 tests). The customer edit form now renders `outstandingAmount` read-only
  once a customer has ledger history — it is set once as an opening balance on
  create, then ledger-derived from there.
- **Fixed R2** — `reports.ts`'s three scope-collision sites (leads, orders, rep
  leaderboard) rewritten through a new `scopedWhere()` primitive in
  `permissions.ts`, with 5 regression tests locking the composition in place
  so the bug class can't reappear silently.
- `/invoices`, `/invoices/[invoiceId]`, `/invoices/new` (from an order's
  "Raise Invoice" button on the quotation detail page); `/receipts`,
  `/receipts/[receiptId]`, `/receipts/new` with live outstanding-invoice
  lookup via `/api/customers/[customerId]/open-invoices`.
- `scripts/backfill-order-items.ts` — one-off, idempotent, applied: both real
  pre-Phase-2 orders (ORD-2026-0001, ORD-2026-0002) had zero `OrderItem` rows
  and are now backfilled from their linked `QuotationItem`s and invoiceable.

**109 tests total, up from 62.** Every one of the following was a real bug the
tests caught before it reached anything real:
- The same transaction-detection defect as Phase 1's posting service existed
  in `createInvoiceFromOrder`/`recordReceipt`/`cancelInvoice`/`cancelReceipt` —
  fixed the same way, by accepting an explicit `Prisma.TransactionClient`
  rather than sniffing for one.
- **Round-off polarity was backwards.** When rounding a total up increased it,
  the code debited `ROUND_OFF` instead of crediting it, producing an
  unbalanced entry on any invoice needing a round-off — caught by the first
  fractional-quantity test, not by inspection.

**Explicitly not done, and why:**
- `CreditNote` posting logic (the schema exists; nothing writes to it yet) —
  no live requirement to build against, since Urvar has no invoices to credit
  against yet.
- The GST tax-invoice PDF template — the detail page renders everything the
  PDF would need, but the PDF itself needs `@react-pdf/renderer` work that is
  cosmetic, not load-bearing, and was deprioritised behind the posting
  correctness above.
- Centralising the three quotation write paths (R8) — untouched; still three
  places create an Order, none of which yet call `createInvoiceFromOrder`.
- AR ageing report — `customerReceivable()` gives the number; a dated buckets
  view is straightforward but not yet built.

**Go-live gate, unchanged and still blocking:**
- `Company.gstin`, address and bank details are still null — they print on a
  tax invoice and nothing here will invent them.
- HSN classification for all four products needs accountant sign-off,
  especially Liquid Humic Acid at `3101` (the one seeded `TaxRate` row is
  `isVerified: false`, and `resolveTaxRate()` refuses to price from it until
  that changes).
- The 25 kg vs 5 kg pack-size disagreement must be resolved.

The code is real and tested against synthetic fixtures and now against the
two real orders in production; **switching it on for a customer-facing
invoice is still Urvar's data task, not an engineering one.**

## Phase 3 — purchases and expenses · **DONE (core)**

Migration `20260920053955_purchases_and_expenses`, strictly additive:
`PurchaseInvoice` gains 9 nullable/defaulted columns (status, posting link,
CGST/SGST/IGST split), plus three new tables — `SupplierPayment`,
`SupplierPaymentAllocation`, `Expense` — and two new enums.

**Scope decision, made explicit up front:** `PurchaseInvoice` already existed
(the OCR-intake "photograph a supplier's invoice" flow) and is extended in
place rather than duplicated into a new `SupplierBill` model — it already is
that document. **PO and GRN are deliberately not built.** Neither concept
exists anywhere in this schema, unlike the sales side where `Order` already
existed before Phase 2 started; inventing a purchase-order/goods-receipt
workflow with zero evidenced current usage would be speculative scope, not a
gap-fill, and the brief's own rule against a second source of truth cuts the
same way here as it did for choosing not to duplicate `PurchaseInvoice`.

**Delivered:**
- `src/lib/accounting/purchase-posting.ts` — `postPurchaseInvoice()` is a
  deliberately separate step from creating the invoice (unlike the sales
  side, which posts at creation): OCR-extracted data is captured as `DRAFT`
  first, a person reviews it, and only then does it post. Splits the header's
  one blended `taxAmount` into CGST+SGST or IGST from `Supplier.state` vs
  `Company.state`, refusing to post while the supplier's state is unset
  rather than guessing (7 tests, including a rounding-drift fold so the split
  always sums exactly to the header figure).
- `src/lib/accounting/supplier-payments.ts` — `recordSupplierPayment()`
  mirrors `receipts.ts` exactly, direction reversed: allocates across
  invoices with an over-allocation guard, routes any unallocated remainder to
  `ADVANCE_TO_SUPPLIER` (8 tests).
- `src/lib/accounting/payables.ts` — `supplierPayable()` derives AP the same
  way `receivables.ts` derives AR (5 tests).
- `src/lib/accounting/expenses.ts` — a **separate, simpler path** for
  immediately-paid outgo (rent, electricity, a courier bill) that never
  touches a supplier ledger: `DRAFT → SUBMITTED → APPROVED`, where approval
  and posting happen in the same step (documented on `ExpenseStatus` — this
  is genuinely different from `PurchaseInvoice`, not a shortcut). This is
  where `assertCanApprove()`'s separation-of-duties check gets its first real
  exercise: a submitter cannot approve their own expense unless they hold the
  Super Admin exemption (11 tests).
- New `expenses` RBAC module, finance-only like `purchases`, with `approve`
  filled for all 5 roles. Tightened `purchases.delete` and `expenses.delete`
  to `"none"` for **every** role including `SUPER_ADMIN` — `PurchaseInvoice`
  can now carry a `postedEntryId` into the immutable ledger, so the
  pre-existing `purchases: FULL` grant for Super Admin would have let it
  delete a ledger-linked row, which every other financial module already
  refuses (regression test added).
- One small, real gap closed along the way: no supplier edit UI existed at
  all, and OCR never extracts a supplier's state. Rather than build full
  supplier CRUD, `setSupplierStateAction` + an inline form on the invoice
  detail page fills the one field posting actually needs.
- `/purchases/[invoiceId]` (didn't exist before — the list page had unlinked
  rows), `/supplier-payments`, `/supplier-payments/[paymentId]`,
  `/supplier-payments/new`, `/expenses`, `/expenses/[expenseId]`,
  `/expenses/new`, with `/api/suppliers/[supplierId]/open-invoices` for
  payment allocation.
- Fixed two audit-log filter gaps found while doing this pass: `SalesInvoice`
  and `Receipt` (Phase 2's own `logAudit()` call sites) were never added to
  the filterable entity-type list either.

**33 new tests (142 total).** No new transaction-detection or round-off bugs
this time — `expenses.ts` was designed with the optional-`tx` pattern from
the start based on Phase 2's lesson, and the round-off-fold logic in
`postPurchaseInvoice` (correcting an odd-paisa drift into SGST) passed on
first run.

**Explicitly not done:**
- Purchase orders and goods-receipt notes — see the scope decision above.
- AP ageing report UI — `supplierPayable()` gives the number; a dated
  buckets view is straightforward but not yet built, matching AR ageing's
  same deferral in Phase 2.
- Per-line HSN/rate capture on purchase invoices — the OCR schema in
  `purchases/actions.ts` asks for one blended tax figure, not a rate or HSN
  per line, so ITC is split proportionally rather than computed line-by-line
  the way sales tax is. A true fix means extending the OCR extraction
  schema, not something to improvise in the posting layer.
- Expense receipt/bill attachment — `File` already has a
  `relatedPurchaseInvoiceId` pattern to copy, but wiring it up wasn't done.

## Phase 4 — inventory and costing (done, 2026-09-20)

Two decisions were needed before building, both confirmed explicitly rather
than defaulted:

1. **Costing method: CRM-side weighted average**, not a costed ERP view. Cost
   is derived from `PurchaseInvoiceItem` (`src/lib/accounting/costing.ts`),
   which excludes GST by construction (`lineTotal` is the pre-tax taxable
   value) — the right basis for a registered regular taxpayer claiming ITC.
2. **On-hand quantity stays out of scope.** Checked the live `urvar_crm`
   database directly: `postgres_fdw` was never installed and no foreign
   tables exist, so the ERP quantity contract (`phase2-erp-views.sql`/
   `phase2-crm-fdw.sql` in `D:\urvar-erp`) is still just two `.sql` files, not
   a live capability. Wiring it means installing `postgres_fdw` in production,
   fixing two pre-existing bugs in those files first (the user mapping targets
   role `postgres` while the CRM actually connects as `urvar_app`, and
   `crm_reader_dev_pw` is hardcoded in a checked-in SQL file), and touching a
   second live application's database — out of scope for a CRM feature
   session. A human enters on-hand quantity instead (physical count or an ERP
   report), same as Vyapar/Tally require without a perpetual stock ledger.

**What this makes the costing model.** Purchases already post their full
value to the P&L `Purchases` account at posting time
(`purchase-posting.ts`, unchanged) — a periodic system, not perpetual. So
Phase 4 adds a periodic **closing-stock valuation** rather than a per-invoice
COGS posting: `StockValuation` + `StockValuationLine`
(`src/lib/accounting/stock-valuation.ts`), one per `FinancialPeriod`. Posting
one does two things in the same step: reverses the immediately preceding
period's valuation (dated at this period's start, via the existing
`reverseJournalEntry`'s `reversalDate` escape hatch — built for exactly this
"the earlier period may already be closed" case) so last period's closing
stock becomes this period's opening stock, then posts Dr
`INVENTORY_FINISHED_GOODS` / Cr `COGS` for this period's value. Both accounts
were forward-provisioned in Phase 1's chart of accounts specifically for this.

A line's cost is the computed weighted average unless a manual override is
given; a product with neither is refused outright — never defaulted to zero
or another product's rate. `SalesInvoiceItem` also gained a nullable,
informational-only `estimatedUnitCost`/`estimatedCostAmount` snapshot (never
posted to the ledger) so a per-invoice margin figure is visible without
waiting for period close; the invoice detail page shows it gated behind
`accounting` read access, the same reason `purchases` is hidden from sales
roles.

UI: `/accounting/inventory` (list), `/accounting/inventory/new` (draft a
valuation), `/accounting/inventory/[valuationId]` (review, post, cancel).
23 new tests (`tests/costing.test.ts`, `tests/stock-valuation.test.ts`).

## Phase 5 — GST and reports

GSTR-1/3B-oriented registers, Trial Balance, General Ledger, P&L, Balance
Sheet, cash and bank books. All derived from posted journal lines, never from
independent calculations. Requires accountant review.

## Phase 6 — CRM integration

Customer financial summary, role-aware sales visibility, overdue context on
follow-ups, read-only AI agent financial context. Requires explicit
authorization before the voice agent reads any balance.

## Vyapar migration

Runs alongside Phase 2. Masters and balances migrate; history does not.

1. **Masters** — Vyapar parties matched against existing `Customer` rows by
   phone, then GSTIN, then fuzzy name. Never blind-inserted; conflicts need a
   human decision.
2. **Opening balances** — one dated journal entry, contra to
   `OPENING_BALANCE_EQUITY`.
3. **Open items** — each unpaid invoice imported individually with its real
   Vyapar number and outstanding, flagged as an opening item. Net per-party
   balances are not enough for ageing or allocation.

**An opening invoice posts to AR and Opening Balance Equity, never revenue** —
that income was recognised in Vyapar and is already in a filed GSTR.

**Cut over on 1 April.** Invoice series restart per FY anyway, so a 1 April
cut-over lets `DocumentSeries` begin at 1 with no chance of colliding with
Vyapar's numbering — it deletes the risk rather than managing it.

Acceptance is reconciliation: imported AR equals Vyapar's All Parties Report
receivable total on the cut-over date to the paisa, same for AP, every open
invoice matches per-invoice, and the post-import trial balance equals the
accountant's signed opening trial balance. Then one month of parallel running.

## Open questions

**Management:** the cut-over date; who may close a period and whether a user
may approve a payment they created; whether a month of parallel running is
acceptable; who signs the opening trial balance.

**Accountant:** state(s) of registration and the GSTIN to print; correct HSN
and rate per product; whether e-invoicing (IRN) and e-way bills apply at
Urvar's turnover; whether freight and packing are part of taxable value or a
separate supply; reverse-charge applicability by supplier category.

No claim of legal GST compliance is made in code, docs or UI until these are
answered.

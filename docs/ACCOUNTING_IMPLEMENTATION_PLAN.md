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

## Phase 5 — GST and reports (done, 2026-09-20)

`src/lib/accounting/financial-reports.ts` — six read-only functions, all
derived from posted `JournalLine` rows, never an independent calculation:
`trialBalance`, `generalLedger` (doubles as the cash book or bank book when
pointed at `CASH_ON_HAND`/`BANK_DEFAULT` — no separate implementation),
`profitAndLoss`, `balanceSheet`, `gstTaxSummary` (output vs. input tax
straight off the `GST_OUTPUT_*`/`GST_INPUT_*` ledger accounts), and
`gstOutwardSupplyRegister` (line-level HSN detail from `SalesInvoiceItem`,
for GSTR-1 preparation).

One correctness point that would have been a real bug: `JournalEntry.status`
flips to `REVERSED` on the original entry once it's reversed, but the
original still genuinely happened — filtering reports to `status: "POSTED"`
only would silently drop everything the original posted before its reversal
date. Every function here filters by `entryDate` only, never by status
(except excluding the unused `DRAFT`), and `tests/financial-reports.test.ts`
has a dedicated case proving a reversed entry nets to zero only *after* the
reversal date, not before.

`balanceSheet` folds cumulative Income − Expenses since inception into Equity
as "Current Earnings" (this system has no year-end closing entry that moves
P&L into Retained Earnings), which is also a self-check: Assets = Liabilities
+ Equity is guaranteed by the posting service's own debit=credit invariant,
and the report returns a `balances` boolean the UI surfaces as a visible
warning if it's ever false.

No claim of GST compliance is made anywhere in the UI — the GST registers
page states explicitly that it is for return preparation only, not a filed
return, and shows the company's GSTIN (still unset) and the HSN-verification
caveat inline. Nothing here required a schema change or a migration: purely
additive read paths over Phases 1-4's existing data.

UI: `/accounting/reports` (hub) plus `trial-balance`, `ledger`,
`profit-and-loss`, `balance-sheet`, `gst` — all plain server-rendered pages
with a native GET-query-param date filter, no Server Actions or client
JavaScript needed since nothing here writes. 11 new tests
(`tests/financial-reports.test.ts`).

## Phase 6 — CRM integration (done, 2026-09-20)

**A real, pre-existing bug found and fixed first.** Both `customerReceivable()`
and `supplierPayable()` filtered `entry: { status: "POSTED" }`. When an
invoice is cancelled, `reverseJournalEntry` flips the ORIGINAL entry's status
to `REVERSED` and posts a new mirror entry — the filter excluded the
original's real debit/credit while still counting the reversal's, leaving
every cancelled invoice's effect as a phantom balance instead of netting to
zero. Same bug class as the point-in-time filtering fix in Phase 5's
`financial-reports.ts`, found here because the new account-status feature
below builds directly on `customerReceivable()`. Fixed in both functions
(filter out only `DRAFT`, never actually written), with a regression test in
each of `tests/receivables.test.ts` and `tests/payables.test.ts`. Checked
production directly: zero `SalesInvoice`/`PurchaseInvoice` rows exist yet, so
no real balance was ever actually corrupted by this — the fix is preventive.

**`customerAccountStatus()`** (`src/lib/accounting/receivables.ts`) is the one
place "what can a customer be told about their account" is defined —
outstanding balance, credit limit, overdue invoices with days-overdue, and
last payment. Both the customer detail page and the voice agent's new tool
call it, so the two surfaces can never disagree.

**Customer detail page**: an Overdue / Last Payment section, gated behind
`accounting` read access (not just `customers` read) the same reason invoice
margin is gated in Phase 4 — it's ledger detail, not the plain
`outstandingAmount` column already visible to sales roles.

**Follow-ups**: fixed a real pre-existing bug — `FollowUp.customerId` has
existed since the model was created, but the list query only ever included
`lead`, so a customer-linked follow-up silently rendered "—" instead of the
customer's name. Fixed alongside adding a lightweight outstanding-balance
indicator (the already-synced `Customer.outstandingAmount` column, not a
per-row ledger query against a 200-row paginated list).

**AI agent financial context — the piece requiring explicit authorization.**
Asked the user directly, since the plan's own gate required it, and grounded
the question in what the codebase actually does: the voice agent's
`ToolContext` had no `customerId` at all, and there is **no caller-identity
verification anywhere in the calling stack** — every AI call is outbound,
dialed to a Lead's number on file, so "who is this call ostensibly with" was
never established. The user chose the fuller option: the agent may state real
figures. Built as `get_account_status`
(`voice-agent/tools/crm-tools.ts`), gated behind `AI_FINANCIAL_DISCLOSURE_ENABLED`
(default `"false"`, fail-closed like every other AI-write flag) — a schema
the model doesn't even see when off, same pattern as `create_quotation`.

Even with the flag on, the tool independently refuses whenever
`ctx.customerId` is unset. That id is resolved exactly once, in
`server.ts`, from `Customer.sourceLeadId` — an authoritative conversion
record, never a phone-number or name-based guess — so a Lead who has never
actually become a paying Customer gets "no linked account," not a guess. The
residual risk is real and documented rather than hidden: whoever physically
answers the dialed phone is presumed to be that Lead/Customer, the same
assumption every ordinary business call already makes, weaker than a PIN or
OTP but the strongest signal available without new verification
infrastructure. Every actual disclosure is audit-logged (`AuditLog`,
`action: "VIEW"`, tied to the `callId`) — viewing a customer's financial data
was not tracked anywhere before this. `"VIEW"` was also missing from the
audit-logs page's `ACTIONS` filter array — the same "the row existed and was
unfilterable" gap this plan already caught twice before (Phase 2's
`SalesInvoice`/`Receipt`, Phase 3's `SupplierPayment`/`Expense`/`Supplier`) —
fixed proactively this time.

The system prompt only mentions the tool at all when the flag is on, and
instructs the model to never state a figure it wasn't handed by the tool's
actual response. `npm run eval:agent` was run after the prompt/tool change
(flag off, matching what ships): 70/71 and 70/71 checks on the two providers,
both failures pre-existing scheduling-tool ambiguity unrelated to this
change. No scripted eval scenario exercises `get_account_status` itself —
noted as a coverage gap, not exercised because the harness has no "customer
asks about their balance" scenario today.

## Phase 7 — closing deferred gaps (done, 2026-09-20)

Not a pre-planned phase — the plan only ever defined Phases 1-6. When asked
to "continue to phase 7," there was no such phase to continue, so this was
put to the user directly rather than guessed at; the answer was to close the
engineering-only items deferred across Phases 1-6, leaving out the two that
carry real production or scope risk (below).

**Two small additive schema changes**, both correctness gaps rather than new
features: `CreditNote.cancelledAt` (every other posted document already had
one; CreditNote was missing it since Phase 2) and
`SalesInvoiceItem.quantityCredited` (mirrors `OrderItem.quantityInvoiced`
exactly — without it a second credit note against the same line has no way
to know a first one already used up part of the quantity).

**`src/lib/accounting/credit-notes.ts`** — `createCreditNote()`/
`cancelCreditNote()`, deferred from Phase 2 ("no live invoices to credit
against yet"). Built as an engine tested against synthetic fixtures, same as
everything else in this system before real transaction volume existed. Each
line's tax is proportional to the *original* invoice line's own priced
amounts, never re-resolved from the current `TaxRate` — a credit note must
reference the rate the original supply was taxed at. UI: a "New Credit Note"
dialog on the invoice detail page, `/credit-notes/[creditNoteId]` for detail
and cancellation. 7 new tests.

**AR/AP ageing reports** (`accountsReceivableAgeing()`/
`accountsPayableAgeing()` in `financial-reports.ts`, `/accounting/reports/
ar-ageing` and `/ap-ageing`) — `customerReceivable()`/`supplierPayable()`
already gave the totals; this buckets them by age (Current, 1-30, 31-60,
61-90, 90+). AR ages from `SalesInvoice.dueDate`; AP ages from
`PurchaseInvoice.invoiceDate` since that model has no due-date field at
all — documented in the UI rather than silently assuming a payment term. 3
new tests.

**Audit-log filter gap, found again.** `CreditNote` and `StockValuation`
(Phase 4) had never been added to the audit-logs page's `ENTITY_TYPES`
array — the same "the row existed and was unfilterable" pattern caught in
Phases 2, 3 and 6. Fixed alongside this pass.

**Explicitly left out, with reasoning, not silently skipped:**
- **Centralizing the three quotation write paths (R8)** — `quotations/
  actions.ts`, the public unauthenticated accept-token route, and the voice
  agent's `create_quotation` tool each still create an `Order` independently.
  This is a refactor of three live, production-traffic-bearing paths (one of
  them the only unauthenticated write endpoint in the app) for the sake of a
  future invoicing hook that doesn't have a concrete use case yet — real
  regression risk for no immediate payoff, unlike the items above which were
  all pure additions.
- **Per-line HSN/rate capture on purchase invoices** — still one blended
  header `taxAmount` from OCR, so ITC is still split proportionally rather
  than computed line-by-line. Fixing it means extending the Sarvam Vision
  extraction schema in `purchases/actions.ts` *and* adding columns to
  `PurchaseInvoiceItem` *and* reworking `postPurchaseInvoice()`'s tax split —
  three coupled changes to an already-shipped, working intake flow, not a
  same-shape addition like credit notes were.
- **GST tax-invoice PDF template** — still cosmetic, not load-bearing; the
  invoice detail page already renders everything the PDF would need.
- **Expense receipt/bill attachment** — `File` already has a
  `relatedPurchaseInvoiceId`-style pattern to copy, still not wired up.

10 new tests (7 credit-notes + 3 ageing), **192 total**.

## Phase 8 — Vyapar report-parity and itemised expenses (done, 2026-09-24)

Two reference screens from the user, not a pre-planned phase: a screenshot
of Vyapar's Accounts → Reports menu tree, and a screenshot of Vyapar's
Expense entry screen. The ask was to check this system's own coverage
against both and close real gaps.

### Part B — itemised expense entry (built first; Part A's Expense Item
Report depends on it)

`Expense` was a flat single amount with one category, posting two journal
lines. The reference screen needs line items, a GST toggle, transportation,
round-off and an attachment. Additive migration
`20260924133732_expense_line_items`: new `ExpenseItem` model (mirrors
`SalesInvoiceItem`'s shape) and new `Expense` columns
(`isGstApplicable`, `claimInputCredit`, `subtotal`,
`cgstAmount`/`sgstAmount`/`igstAmount`, `transportAmount`, `roundOff`), plus
`File.relatedExpenseId` for the attachment — following `File`'s existing
`relatedXId`-per-entity-type convention, not a `fileId` on `Expense`. One new
`AccountKey`, `FREIGHT_INWARD` → `5310` (the account already existed in the
seed; only the mapping key was missing).

**This is the first code path in the system that ever posts to
`GST_INPUT_*`.** Purchases post straight to the P&L Purchases account with
no tax split (a pre-existing gap, noted below), so `gstTaxSummary()`'s
input-credit column was structurally zero before this. It no longer is.

Two decisions, put to the user rather than assumed:
- **Per-line tax % is picked directly** (a 0/5/12/18/28 dropdown), not
  resolved through `resolveTaxRate()`'s verified-HSN gate. On a sale, the
  rate is a classification decision the company is liable for; on an
  expense, it is a transcription of what the supplier's own bill already
  shows, and most expense lines (rent, courier, electricity) carry no HSN at
  all.
- **Input Tax Credit is opt-in, `claimInputCredit` default false.** Unclaimed
  tax folds into the category account as part of the cost — the correct
  treatment for a blocked credit (Sec 17(5): staff welfare, motor vehicles,
  etc.) — rather than every GST expense silently claiming credit by default.

**A real balance bug, caught by the test suite before it shipped:** the
CGST/SGST split was originally computed only `if (claimInputCredit && tax >
0)`. With the flag off, `cgstAmount`/`sgstAmount` stayed zero while `amount`
(used for the payment credit) still included the tax — the category debit
and payment credit silently disagreed and `postJournalEntry` threw. Fixed:
the split is now always computed once there is tax; `claimInputCredit` only
decides *where* it posts, never whether it is recorded. Documented in
`expenses.ts` so it isn't reintroduced.

Tax split for a claimed credit is always intra-state (CGST+SGST) — expense
entry captures no supplier state/place-of-supply the way sales invoicing
does, and the overwhelming majority of operating expenses are bought
locally. **A genuinely inter-state expense claiming ITC is a known gap**,
tracked here rather than silently mis-posted as IGST.

Round-off posts to `ROUND_OFF`, mirror-image of `invoicing.ts`'s direction:
there AR is *debited* the rounded total, so rounding up *credits*
`ROUND_OFF`; here the payment account is *credited* the rounded total, so
rounding up *debits* it instead. Covered by tests in both directions — the
single easiest thing to get backwards in this change.

`createExpense()`/`approveExpense()` in `expenses.ts`; UI is
`expenses/new/new-expense-form.tsx` (line-item table, GST toggle, ITC
checkbox, transportation, live totals preview — all recomputed
authoritatively server-side, never trusted from the client) plus a new
`uploadExpenseAttachmentAction()` mirroring `purchases/actions.ts`'s
upload-then-link pattern, and the `api/documents/[fileId]` route gained an
`expenses`-gated authorization branch for the new attachment. The legacy
flat-amount path (no items, `amount` entered directly) is untouched and
still posts exactly as before — 21 tests in `tests/expenses.test.ts` (11
pre-existing + 10 new), including one exercising the legacy path unchanged.
This also closes the "Expense receipt/bill attachment" item Phase 7 left
deferred.

### Part A — report gaps

~20 new read-only functions in `financial-reports.ts`, same rules as
everything already there (derived from posted `JournalLine`/document rows,
never an independent recomputation), plus 17 new pages under
`accounting/reports/`, and the hub page (`accounting/reports/page.tsx`)
reorganized from a flat 7-card grid into sections mirroring Vyapar's own
categories now that the count is ~24.

**A planning correction, caught by reading the schema instead of assuming:**
the original plan sketch for Party Statement assumed `JournalEntry` had no
party reference and would need reconstructing from documents directly, the
way `accountsReceivableAgeing` does. `JournalLine.partyType`/`partyId` in
fact exists, is indexed, and is already populated by every AR/AP posting
path (`invoicing.ts`, `credit-notes.ts`, `receipts.ts`,
`supplier-payments.ts`, `purchase-posting.ts`, `opening-balances.ts`).
`partyStatement()` is therefore a true ledger sub-account statement — the
same shape as `generalLedger()`, scoped to a party instead of an account —
not a document-level reconstruction. A customer statement is debit-normal
(what they owe grows with debits, mirroring AR_TRADE); a supplier statement
is credit-normal (mirroring AP_TRADE). Tested both directions plus the
opening-balance boundary.

**Built:** `dayBook` (all accounts, chronological — Day Book/All
Transactions), `cashFlowSummary` (cash+bank movement bucketed by cause,
explicitly not a formal operating/investing/financing statement),
`salesAgeingByInvoice` (bill-wise, unlike AR Ageing's per-customer net),
`billWiseProfit` (per-invoice estimated margin, flags a null cost line
rather than treating it as zero — tested), `partyStatement`,
`partyWiseProfitAndLoss`, `allPartiesSummary`, `partyReportByItem`,
`hsnSummary` (aggregates `gstOutwardSupplyRegister` by HSN),
`itemWiseProfitAndLoss`, `itemCategoryWiseProfitAndLoss`, `itemWiseDiscount`
and `discountReport` (both recompute discount from quantity × unitPrice ×
discountPercent — the same formula `tax.ts`'s `priceLine()` uses, never a
stored standalone figure), `expenseCategoryReport`, `expenseItemReport`
(needs Part B's `ExpenseItem`), and `accountGroupBalances`/
`cashOnHandBalance` (generic parent-group balance reader, backing Bank
Report, and the combined Cash/Bank/Fixed-Assets/Loans page).

**A genuine finding, not assumed:** "Loan Accounts" and "Fixed Assets" were
expected to need new chart-of-accounts groups. Reading `chart-of-accounts.ts`
found both already seeded — Fixed Assets (`1200`: Plant & Machinery,
Furniture & Fixtures, Vehicles, Accumulated Depreciation) and Loans (`2210`,
under Long-term Liabilities `2200`) — so `accountGroupBalances()` reads them
directly with zero schema or seed changes. The user had a Tally XML export
ready to cross-check naming/structure against, in case new groups were
needed; since none were, it wasn't used for this piece.

**Discovered while testing, not a code bug but worth recording:**
`createInvoiceFromOrder()` hardcodes `discountPercent: 0` on every line — no
current UI path ever sets a per-line discount on a sales invoice. `Item Wise
Discount`/`Discount Report` are therefore correct but currently vacuous
against real production data; the aggregation formula was verified by
setting `discountPercent` directly in the test rather than through the
(nonexistent) write path.

**Explicitly not built, documented rather than faked:**
- **Stock Summary / Stock Detail / Item Detail / Low Stock Summary** — restated
  from Phase 4: on-hand quantity lives in `urvar_erp`, reachable only via a
  `postgres_fdw` link that was drafted (`phase2-crm-fdw.sql`) but never
  installed. A real infra dependency, not a report gap.
- **SAC Report** — not applicable; Urvar sells physical goods (HSN), not
  services.
- **GSTR-2** — blocked on data capture, not a report to write:
  `PurchaseInvoiceItem` has no `hsnCode` and no line-level tax split at all
  (just qty/unitPrice/lineTotal), and `PurchaseInvoice` captures no supplier
  GSTIN. An inward-supply/ITC register needs that captured at intake first.
- **GSTR-9** — an annual return aggregating a full FY of filed GSTR-1/3B
  under accountant sign-off, the same territory this doc's own "Open
  questions → Accountant" section already reserves, not something to
  synthesize from internal registers.
- **Loan repayment schedules / depreciation engine** — genuinely new
  functionality (interest schedules, depreciation methods), not a report
  gap; `accountGroupBalances` only ever shows the balance that's there.

12 new tests in `tests/report-extras.test.ts`, plus 10 new in
`tests/expenses.test.ts` for Part B. **221 total.**

## Phase 9 — cash, bank, loans and fixed assets: the write side (done, 2026-09-24)

Phase 8 shipped a read-only report for Cash on Hand, Bank Accounts, Fixed
Assets and Loan Accounts. The user's follow-up was the obvious one: how do
you actually *change* those balances? Before this phase the honest answer was
"you can't" — `1122`, `1210`-`1230`, `1290` and `2210` had never been written
to by anything except the Vyapar opening-balance migration, and the only
cash/bank-touching UI (Receipt, Expense, Supplier Payment) had a hardcoded
picker limited to `1110`/`1121`.

Four user decisions shaped this phase: record all three (cash/bank
movements, loan accounts, fixed assets); build **both** guided plain-language
forms and a raw manual journal-entry escape hatch; build **full registers
with schedules**, not just ledger postings; depreciation method is **WDV
(written-down/reducing-balance)**.

### Architecture: sub-ledger vs. account-per-item, decided per entity

Loans and fixed assets sit at opposite ends of the same axis. A loan gets its
**own `LedgerAccount`**, created under a new `2220 Loan Accounts` group (never
`2210` — that account already carries 3 real postings, ₹1,79,958, from the
Vyapar migration, so it was left untouched rather than converted into a
group) — few, named, lender-specific, reconciled against an external
statement, the same way a bank account is. A fixed asset is a **sub-ledger
row** against the shared category accounts (`1210`/`1220`/`1230`) and the
existing contra account `1290 Accumulated Depreciation`, following the
codebase's own AR/AP precedent (`1130`/`2110` are single control accounts;
per-customer/supplier detail lives in `JournalLine.partyType`/`partyId`) —
one `LedgerAccount` per asset would make the chart of accounts unreadable
within a year. `PartyType` is `CUSTOMER|SUPPLIER` only, so traceability for
both loans and assets comes from `JournalEntry.sourceType`+`sourceId`
pointing at the register row instead — six additive enum values on
`JournalSourceType` (`CASH_BANK_TRANSFER`, `LOAN`, `LOAN_REPAYMENT`,
`FIXED_ASSET`, `DEPRECIATION`, `ASSET_DISPOSAL`).

Every write follows the existing document→posting pattern exactly: create
the business record, then a separate posting step emits the balanced entry
and stores `postedEntryId`; cancellation calls `reverseJournalEntry()` and
stamps `cancelledAt`. Nothing outside `posting.ts` writes `JournalLine`.

### New models

`CashBankTransaction` (deposit/withdrawal/transfer/bank charge/interest
income/cash-count adjustment — `src/lib/accounting/cash-bank.ts`), `Loan` +
`LoanRepayment` (`src/lib/accounting/loans.ts`, schedule math in
`loan-schedule.ts`), `FixedAsset` + `DepreciationEntry`
(`src/lib/accounting/fixed-assets.ts`, WDV math in `depreciation.ts`). New
accounts: `5700`/`5710` Finance Costs/Interest Expense, `4920` Gain/(Loss) on
Asset Disposal, `5800` Cash Short/(Over), `2220` Loan Accounts — three new
`AccountKey`s (`INTEREST_EXPENSE`, `ASSET_DISPOSAL_GAIN_LOSS`,
`CASH_SHORT_OVER`).

**`emiAmount` is entered, not computed.** The lender's sanction letter states
it; `loan-schedule.ts`'s `suggestEmi()` (closed-form, `Prisma.Decimal.pow()`
directly since `(1+r)^n` is a ratio, never routed through `money.ts`'s
paise-scale `round()`) is offered only as a form default, never stored or
used to generate the amortisation. Only the per-instalment split is derived
(`interest = round(outstanding × rate/12/100)`, `principal = emi − interest`)
— the one piece of math that has to be exactly right — and the **final
instalment is the residual**, not the formula EMI, which is what guarantees
the loan account lands on exactly `0.00` regardless of accumulated rounding.
WDV depreciation mirrors this: `charge = openingWdv × rate%`, floored at
`salvageValue`, with the final year's charge taking the whole remainder
rather than leaving a sub-rupee tail forever. Neither schedule is stored —
both are derived at read/post time from the loan's or asset's own terms, so
neither can drift from them.

**On-credit asset purchase — a corrected design, not `Cr AP_TRADE`.** Posting
`Dr Asset / Cr AP_TRADE` directly from the register would create a payable
with no `PurchaseInvoice` behind it, and `accountsPayableAgeing()`
reconstructs AP entirely from `PurchaseInvoice` rows — that credit would sit
in the trial balance forever and never appear in AP ageing or the supplier's
statement, the same class of silent divergence Phases 6 and 7 each already
caught once. Instead `FixedAsset.sourcePurchaseInvoiceId` (`@@unique` — one
invoice backs at most one asset) links to an already-`POSTED`/
`PARTIALLY_PAID`/`PAID` invoice, and the asset's own posting is a pure
**reclassification**: `Dr Asset (12xx) / Cr PURCHASES (5200)`, no new AP or
GST line, since the invoice already tracked both. Capitalised cost may not
exceed the invoice's subtotal, and `paidFromAccountId`/
`sourcePurchaseInvoiceId` are mutually exclusive.

### Two bugs caught by test-writing discipline before shipping

Both were the identical bug class, in two different models:
`LoanRepayment.@@unique([loanId, installmentNumber])` and
`DepreciationEntry.@@unique([fixedAssetId, financialYear])` each contradicted
their own schema comment's stated intent. Rows are never deleted (only
`cancelledAt`-stamped), so a hard DB unique on a "which instalment/year is
this" key means a **cancelled** row still occupies the constraint —
re-posting the same instalment number or financial year after a legitimate
cancellation would throw `Unique constraint failed` forever. The first was
caught by design review before running anything; the second was caught by an
actual failing test. Both fixed identically: `@@unique` → `@@index`, with
"at most one ACTIVE row for this key" enforced in application code
(`findFirst({ ..., cancelledAt: null })`) inside the same transaction as the
insert — two follow-up migrations,
`20260924223537_loan_repayment_no_hard_unique` and
`20260924225448_depreciation_entry_no_hard_unique`, both index-only.

A third bug, same session: `disposeFixedAsset()` called native
`Decimal.isPositive()`/`isNegative()` directly instead of `money.ts`'s
wrapped versions. Native `isPositive()` returns `true` for zero (it means
"not negative," not "greater than zero"), so a disposal at exactly carrying
amount pushed an extra zero-value posting line, which `postJournalEntry`
correctly refused. Fixed by using `money.ts`'s `isPositive`/`isNegative`
(which wrap `greaterThan(0)`/`lessThan(0)` specifically), the same trap
`money.ts`'s own module comment already warns about.

### Two Phase 8 bugs fixed ahead of this build

Found and fixed in `financial-reports.ts` before any Phase 9 schema work,
with regression tests in `report-extras.test.ts`: `accountGroupBalances()`
signed each child account by its own `normalBalance` instead of the parent
group's, so a contra account (`1290`) *added* to its group instead of netting
it down; `cashFlowSummary()` only ever resolved the two `AccountMapping`
defaults (`CASH_ON_HAND`/`BANK_DEFAULT`), silently excluding every other bank
account (e.g. `1122` Bank – Flipkart Settlement).

### UI

Three new sections under `/accounting`, all gated on the `accounting` module
(invisible to the three sales roles, same as the rest of this area) and
added to the sidebar (`nav.ts`) and the audit-log entity/action filters
(`LedgerAccount`, `CashBankTransaction`, `Loan`, `LoanRepayment`,
`FixedAsset`, `DepreciationEntry`; action `DISPOSE`) in this same phase, not
deferred like earlier phases' filter gaps:

- **Cash & Bank** (`accounting/cash-bank`) — balances (reusing Phase 8's
  `cashOnHandBalance`/`accountGroupBalances`), a guided form for each of the
  six movement types, cancel-with-reason per row.
- **Loans** (`accounting/loans`) — register list with live outstanding
  balance; a detail page recording instalments (principal/interest split
  computed server-side, never trusted from the client) with a running
  repayment history, cancel-with-reason per instalment, and a whole-loan
  cancel (refused once any repayment exists, mirroring "corrections are
  reversals, applied in order").
- **Fixed Assets** (`accounting/fixed-assets`) — register list with cost /
  accumulated depreciation / net book value; a detail page posting one
  financial year's WDV charge at a time, disposing (gain/loss computed and
  posted automatically), and cancelling (refused once depreciation exists).

Also added: a manual journal entry escape hatch (`accounting/journal/new`) —
date, narration, N debit/credit lines with a live balance check, party
attribution for `AR_TRADE`/`AP_TRADE` lines, idempotent via a client-minted
UUID token — and a **Reverse** button on the journal list, the first UI path
ever to call `reverseJournalEntry()` (previously only reachable from library
document-cancel flows). It refuses to reverse anything except `MANUAL`/
`OPENING_BALANCE` entries, pointing elsewhere for every other source type so
a document's own status can't desync from its ledger effect. Chart-of-accounts
management (`account-actions.ts` — create/rename/activate, no delete,
`code` immutable once posted against) also shipped as an action layer this
phase, called internally by `createLoan()` to create each loan's own account.

267 tests passing (up from 221 at the end of Phase 8) — `tests/cash-bank`
coverage lives inside `ledger-accounts.test.ts`/`loans.test.ts`/
`fixed-assets.test.ts`/`depreciation.test.ts`/`loan-schedule.test.ts`.

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
separate supply; reverse-charge applicability by supplier category; which
expense categories are blocked credits under Sec 17(5) so `claimInputCredit`
is ticked correctly rather than left to a submitter's guess (Phase 8);
whether the Income Tax Act's half-rate-in-year-of-acquisition rule (asset
used under 180 days) and block-of-assets computation should apply instead of
Phase 9's per-asset, full-rate WDV — this system explicitly makes no tax
depreciation claim either way; depreciation rate per asset class; whether
loan interest should accrue monthly or only be recognised on payment (Phase 9
recognises it on payment, inside the EMI split).

No claim of legal GST compliance is made in code, docs or UI until these are
answered.

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

## Phase 2 — sales invoicing and receivables · **NEXT**

Models: `SalesInvoice`, `SalesInvoiceItem` (snapshotting `hsnCode`, `taxRate`,
CGST/SGST/IGST and `taxableValue` at issue time), `Receipt`,
`ReceiptAllocation`, `CreditNote`, `OrderItem`.

Work:
- Order → Invoice with line items; partial invoicing
- `src/lib/accounting/tax.ts` — place-of-supply resolution and the CGST/SGST vs
  IGST split, refusing unverified `TaxRate` rows
- Receipts with allocation; over-allocation refused; over-payment to advances
- **Derive `Customer.outstandingAmount`** from posted AR lines and make the
  field read-only (closes R1, and makes the AI's existing credit check honest)
- **Fix R2** — rewrite `reports.ts` filter composition to
  `{ AND: [scopeWhere(...), filters] }`. Prerequisite, not a follow-up.
- Centralise the three quotation write paths (R8) and the four copies of the
  quotation territory-scope override
- GST tax-invoice PDF with per-line HSN and tax columns, seller GSTIN, place of
  supply, round-off. Fixes the existing template's `colGst`/`item.unit` bug.
- Customer ledger and AR ageing, both derived from posted lines

**Blockers before go-live, not before build:**
- `Company.gstin`, address and bank details are null and nothing will invent
  them
- HSN classification for all four products needs accountant sign-off,
  especially Liquid Humic Acid at `3101`
- The 25 kg vs 5 kg pack-size disagreement must be resolved

## Phase 3 — purchases and expenses

PO → GRN → `SupplierBill` → `SupplierPayment`, expense approval workflow,
supplier ledger, AP ageing, ITC tracking. This is where the `approve` action
gets its first real use.

## Phase 4 — inventory and costing · **blocked on a decision**

The ERP exposes quantity but not cost. Either extend the ERP view contract with
a costed view (cross-repo change) or derive a weighted average in the CRM from
`PurchaseInvoiceItem`. Decide before building; the valuation method must be
explicit and consistent, never mixed silently.

Also fix, when wiring the FDW: the user mapping targets role `postgres` while
the CRM connects as `urvar_app`, and `crm_reader_dev_pw` is hardcoded in a
checked-in SQL file.

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

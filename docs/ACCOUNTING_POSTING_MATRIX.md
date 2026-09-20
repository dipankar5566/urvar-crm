# Accounting Posting Matrix

The debit/credit treatment for every transaction type. This is the contract
`src/lib/accounting/posting.ts` enforces and the reference for adding a new
document type.

Account names below are **mapping keys**, not account codes — see
`src/lib/accounting/account-map.ts`. Never hardcode a code or an id at a call
site; resolve the key.

## Rules that apply to every row

1. Total debits equal total credits, compared exactly as Decimals. No epsilon.
2. Both `debit` and `credit` are non-negative; exactly one is non-zero per
   line. A negative amount is never used to mean "the other side".
3. Every posting carries an `idempotencyKey` of the form
   `${sourceType}:${sourceId}:${revision}`. Re-posting the same key is a no-op
   that returns the existing entry.
4. Nothing posts into a `CLOSED` or `LOCKED` period.
5. Corrections are reversals. No posted row is ever updated or deleted.
6. AR and AP lines carry `partyType`/`partyId` so a customer or supplier
   balance is derivable without a stored balance column.

## Phase 1 — implemented

### Manual journal entry
Whatever the user enters, subject to the rules above. `sourceType: MANUAL`,
`sourceId: null`.

### Reversal
`sourceType: REVERSAL`, `sourceId` = the original entry id. Every line of the
original with `debit` and `credit` swapped; party attribution preserved. The
original is marked `REVERSED` and linked via `reversesEntryId`.

## Phase 2 — sales side · implemented (`src/lib/accounting/invoicing.ts`, `receipts.ts`)

### Sales invoice, intra-state (place of supply = seller's state)

| Account | Dr | Cr |
|---|---|---|
| `AR_TRADE` (party: customer) | Invoice total | |
| `SALES_REVENUE` | | Taxable value |
| `FREIGHT_RECOVERED` | | Freight, if charged |
| `GST_OUTPUT_CGST` | | CGST (half the rate) |
| `GST_OUTPUT_SGST` | | SGST (half the rate) |
| `ROUND_OFF` | either side | Sub-rupee adjustment |

### Sales invoice, inter-state

Identical, except the two output lines collapse into one:

| Account | Dr | Cr |
|---|---|---|
| `GST_OUTPUT_IGST` | | IGST (the full rate) |

Place of supply is the customer's state; the comparison is against
`Company.state`. This is why `Company.state` must be correct before go-live —
it silently decides CGST+SGST vs IGST on every invoice.

### Customer receipt

| Account | Dr | Cr |
|---|---|---|
| `BANK_DEFAULT` or `CASH_ON_HAND` | Amount received | |
| `AR_TRADE` (party: customer) | | Amount allocated to invoices |
| `ADVANCE_FROM_CUSTOMER` (party: customer) | | Unallocated remainder |

The split is what makes over-payment safe: anything not allocated to a
specific invoice lands in advances rather than driving a receivable negative.

### Credit note (sales return or correction) — schema exists, posting not yet wired

| Account | Dr | Cr |
|---|---|---|
| `SALES_RETURNS` | Taxable value | |
| `GST_OUTPUT_CGST` / `SGST` / `IGST` | Tax reversed | |
| `AR_TRADE` (party: customer) | | Credit note total |

`SALES_RETURNS` is a contra-revenue account (normal balance DEBIT) so gross
sales stays visible rather than being netted away.

### Opening balance — migrated from Vyapar

| Account | Dr | Cr |
|---|---|---|
| `AR_TRADE` (party: customer) | Outstanding on the opening invoice | |
| `OPENING_BALANCE_EQUITY` | | Same amount |

**The contra side is equity, never revenue.** That income was recognised in
Vyapar and already sits in a filed GSTR; posting it to `SALES_REVENUE` would
double-count the year's sales and corrupt the GST registers. Opening invoices
are flagged so they are excluded from output tax registers for the same
reason. `OPENING_BALANCE_EQUITY` should net to zero once the opening trial
balance is complete.

## Phase 3 — purchase side · implemented (`src/lib/accounting/purchase-posting.ts`, `supplier-payments.ts`, `expenses.ts`)

### Supplier bill (`postPurchaseInvoice()`)

| Account | Dr | Cr |
|---|---|---|
| `PURCHASES` | Header subtotal | |
| `GST_INPUT_CGST` + `GST_INPUT_SGST` (intra-state) or `GST_INPUT_IGST` (inter-state) | Header tax, split from Supplier.state vs Company.state | |
| `AP_TRADE` (party: supplier) | | Bill total |

Everything debits `PURCHASES` today — `INVENTORY_*` is not used, since the
costing decision is deferred to Phase 4 (see below). The tax split is
proportional from one header figure, not computed line-by-line: the OCR
intake schema captures a single blended `taxAmount`, not a rate or HSN per
line, unlike the sales side's `TaxRate`-driven per-line split. Posting refuses
when the supplier has no state on file rather than guessing intra- vs
inter-state.

### Supplier payment (`recordSupplierPayment()`)

| Account | Dr | Cr |
|---|---|---|
| `AP_TRADE` (party: supplier) | Amount allocated | |
| `ADVANCE_TO_SUPPLIER` (party: supplier) | Unallocated remainder | |
| The chosen cash/bank `LedgerAccount` | | Amount paid |

Mirrors `Receipt` exactly, direction reversed. Refuses to allocate against a
`DRAFT` (unposted) or `CANCELLED` invoice, and refuses to allocate more than
an invoice's true outstanding amount (derived from posted lines, never a
stored balance).

### Expense (`approveExpense()`) — a deliberately different shape

| Account | Dr | Cr |
|---|---|---|
| The submitter's chosen expense category account | Amount | |
| The chosen cash/bank `LedgerAccount` | | Amount |

No GST input line and no AP line: `Expense` is scoped to immediately-paid
outgo — rent, electricity, a courier bill — that never carries an ongoing
balance for a party. Outgo that should be tracked against a specific supplier
over time is a `PurchaseInvoice`, which already has full AP tracking; adding
that here would duplicate it. Approval and posting are the same step by
design (see `ExpenseStatus` in the schema) — there is no
`APPROVED-but-unpaid` state to represent.

## Phase 4 — inventory · implemented (`src/lib/accounting/stock-valuation.ts`)

Periodic, not perpetual: `PURCHASES` still takes the full debit at posting
time (unchanged from Phase 3), so `StockValuation` is a period-end adjustment,
not a per-invoice entry. On-hand quantity is entered by a person (physical
count or an ERP report) — the ERP's `postgres_fdw` contract for reading it
live has never been wired into the production database (checked directly:
no foreign tables exist), so this stays out of scope rather than guessed at.

### Closing-stock valuation (`postStockValuation()`)

| Account | Dr | Cr |
|---|---|---|
| `INVENTORY_FINISHED_GOODS` | This period's closing value | |
| `COGS` | | This period's closing value |

Before posting the above, if an earlier period already has a POSTED
valuation, its entry is reversed first — dated at **this period's start**,
via `reverseJournalEntry()`'s `reversalDate` parameter (built for exactly
this "the original period may already be closed" case) — so last period's
closing stock becomes this period's opening stock, the standard
trading-account roll-forward:

| Account | Dr | Cr |
|---|---|---|
| `COGS` | Previous period's closing value | |
| `INVENTORY_FINISHED_GOODS` | | Previous period's closing value |

Unit cost per line is a weighted average of `PurchaseInvoiceItem` history
(`costing.ts`) as of the valuation date, or an explicit manual override. A
product with neither is refused — the system never invents a cost. Cancelling
a POSTED valuation reverses it the same way and is refused once a later
period's valuation has already superseded it (unwind in period order, same
rule every other reversal-based document here follows).

### Per-invoice margin snapshot — informational only, never posted

`SalesInvoiceItem.estimatedUnitCost`/`estimatedCostAmount` are set at invoice
creation from the same weighted-average function, purely for display (the
invoice detail page, gated behind `accounting` read access). They never
appear in any `JournalLine` — COGS reaches the ledger only through the
period-end valuation above.

## Adding a transaction type

1. Add the case to this table first, and get it reviewed by the accountant.
2. Add any new mapping key to `ACCOUNT_KEYS` and `DEFAULT_ACCOUNT_MAPPINGS`.
3. Build the lines and call `postJournalEntry(input, tx)` from inside the
   transaction that writes the document, so the two commit together.
4. Add a test asserting the entry balances and hits the accounts this table
   says it should.

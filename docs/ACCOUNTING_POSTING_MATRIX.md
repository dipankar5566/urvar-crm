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

## Phase 3 — purchase side (designed, not yet built)

### Supplier bill (goods for resale, ITC claimable)

| Account | Dr | Cr |
|---|---|---|
| `PURCHASES` or `INVENTORY_*` | Taxable value | |
| `GST_INPUT_CGST` / `SGST`, or `GST_INPUT_IGST` | Input tax | |
| `AP_TRADE` (party: supplier) | | Bill total |

Whether the debit is `PURCHASES` (expense) or `INVENTORY_*` (asset) depends on
the costing decision deferred to Phase 4. Not every purchase is an expense —
that classification is per-line, not per-bill.

### Supplier payment

| Account | Dr | Cr |
|---|---|---|
| `AP_TRADE` (party: supplier) | Amount allocated | |
| `ADVANCE_TO_SUPPLIER` (party: supplier) | Unallocated remainder | |
| `BANK_DEFAULT` or `CASH_ON_HAND` | | Amount paid |

### Expense

| Account | Dr | Cr |
|---|---|---|
| The mapped expense account | Net amount | |
| `GST_INPUT_*` | Input tax, where claimable | |
| `BANK_DEFAULT` / `CASH_ON_HAND` / `AP_TRADE` | | Total |

## Phase 4 — inventory (blocked on a decision)

COGS needs cost, and the ERP's two exposed views
(`erp_foreign.v_stock_available`, `v_product_catalog`) carry quantity only.
Either the ERP view contract gains a costed view, or the CRM derives a
weighted average from `PurchaseInvoiceItem`. Until that is settled, the
`INVENTORY_*` and `COGS` accounts exist and take no postings.

Intended shape once decided:

| Event | Dr | Cr |
|---|---|---|
| Goods received | `INVENTORY_*` | `AP_TRADE` |
| Goods despatched | `COGS` | `INVENTORY_FINISHED_GOODS` |
| Production output | `INVENTORY_FINISHED_GOODS` | `INVENTORY_RAW_MATERIAL` + direct costs |

## Adding a transaction type

1. Add the case to this table first, and get it reviewed by the accountant.
2. Add any new mapping key to `ACCOUNT_KEYS` and `DEFAULT_ACCOUNT_MAPPINGS`.
3. Build the lines and call `postJournalEntry(input, tx)` from inside the
   transaction that writes the document, so the two commit together.
4. Add a test asserting the entry balances and hits the accounts this table
   says it should.

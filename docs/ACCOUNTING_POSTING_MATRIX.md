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

### Credit note (`createCreditNote()`) — implemented (Phase 7)

| Account | Dr | Cr |
|---|---|---|
| `SALES_RETURNS` | Taxable value | |
| `GST_OUTPUT_CGST` / `SGST` / `IGST` / `CESS` | Tax reversed | |
| `ROUND_OFF` | either side | Sub-rupee adjustment (mirror image of the sales-invoice polarity — AR moves the opposite direction here) |
| `AR_TRADE` (party: customer) | | Credit note total |

`SALES_RETURNS` is a contra-revenue account (normal balance DEBIT) so gross
sales stays visible rather than being netted away. Every line's tax is
**proportional to the original invoice line's own priced amounts**, never
re-resolved from the current `TaxRate` — a credit note must reference the
rate the original supply was actually taxed at, not whatever rate is in
effect on the day it's issued. `SalesInvoiceItem.quantityCredited` (added
this phase) tracks how much of each line has already been credited, so a
second credit note against the same line can't exceed what was ever sold.
Posts at creation, like a sales invoice; cancellation reverses the entry and
releases the credited quantity back onto the invoice line.

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

## Vyapar parity: bank accounts and cash/bank adjustments (2026-10-25)

Source: `docs/VYAPAR_PARITY_SPEC.md` §2.1–2.2. Implemented in `src/lib/accounting/bank-accounts.ts` and `cash-bank.ts`.

| Event | Dr | Cr | sourceType | Idempotency key |
|---|---|---|---|---|
| Bank account opening balance (positive) | Bank ledger (new child of 1120) | `OPENING_BALANCE_EQUITY` (3300) | OPENING_BALANCE | `BANK_OPENING:<bankAccountId>:<revision>` |
| Bank account opening balance (overdraft, negative) | `OPENING_BALANCE_EQUITY` | Bank ledger | OPENING_BALANCE | same |
| Opening balance changed | reversal of the previous revision, then the new figure under revision + 1 | | REVERSAL / OPENING_BALANCE | `BANK_OPENING:<id>:<n+1>` |
| `BANK_ADJ_INCREASE` (Vyapar 17) | Bank ledger | `BANK_ADJUSTMENT_EQUITY` (3420) | CASH_BANK_TRANSFER | `CASH_BANK_TRANSFER:<txnId>:1` |
| `BANK_ADJ_DECREASE` (Vyapar 18) | `BANK_ADJUSTMENT_EQUITY` | Bank ledger | CASH_BANK_TRANSFER | same |
| `CASH_ADJUSTMENT` OVERAGE / Add cash (Vyapar 19), default offset | `CASH_ON_HAND` | `CASH_ADJUSTMENT_EQUITY` (3410) | CASH_BANK_TRANSFER | same |
| `CASH_ADJUSTMENT` SHORTAGE / Reduce cash (Vyapar 20), default offset | `CASH_ADJUSTMENT_EQUITY` | `CASH_ON_HAND` | CASH_BANK_TRANSFER | same |

Rules:
- A bank adjustment must hit a child of 1120.
- A `CASH_ADJUSTMENT` offset is EXPENSE or EQUITY (e.g. 5800 Cash Short/Over, picked explicitly). Omitted, it defaults to 3410 (decision D4).
- Attaching details to an existing bank ledger (1121, 1122) posts nothing. Its opening balance is never managed through `BankAccount`; correct it by journal entry.

## Vyapar parity: cheques (2026-10-25)

Source: `docs/VYAPAR_PARITY_SPEC.md` §2.3, with the state machine confirmed by REA round 7: Vyapar has only open, transferred and reopen, with no bounce state. Implemented in `src/lib/accounting/cheques.ts`.

| Event | Dr | Cr | sourceType | Idempotency key |
|---|---|---|---|---|
| Receipt by cheque, held (deposit account = `UNDEPOSITED_CHEQUES` 1115) | `UNDEPOSITED_CHEQUES` | AR / Advance from customer (as any receipt) | RECEIPT | `RECEIPT:<id>:1` |
| Received cheque deposited | Bank (child of 1120) | `UNDEPOSITED_CHEQUES` | CHEQUE_TRANSFER | `CHEQUE_TRANSFER:<chequeId>:<revision>` |
| Supplier payment by cheque, held (payment account = `UNWITHDRAWN_CHEQUES` 2165) | AP / Advance to supplier | `UNWITHDRAWN_CHEQUES` | SUPPLIER_PAYMENT | `SUPPLIER_PAYMENT:<id>:1` |
| Issued cheque cleared | `UNWITHDRAWN_CHEQUES` | Bank | CHEQUE_TRANSFER | same as deposit |
| Reopen (deposited or cleared) | reversal of the transfer entry | | REVERSAL | n/a |

Rules:
- Only `method = CHEQUE` may use 1115 / 2165.
- A cheque deposited straight to a bank opens no Cheque record.
- Cancelling a receipt or payment whose cheque is OPEN marks the cheque CANCELLED; the document's own reversal clears the holding account.
- If the cheque is DEPOSITED or CLEARED, cancellation is refused until it is reopened. A bounced cheque is handled by reopen, then cancel receipt.
- A cheque cannot be deposited or cleared before its cheque date.

## Vyapar parity: loan fee, charges and top-up (2026-10-25)

Source: `docs/VYAPAR_PARITY_SPEC.md` §2.4, G7. Implemented in `src/lib/accounting/loans.ts` as `LoanTransaction`, distinct from the disbursement (`createLoan`) and an EMI (`recordLoanRepayment`).

| Event | Dr | Cr | sourceType | Idempotency key |
|---|---|---|---|---|
| Processing fee | `LOAN_PROCESSING_FEE` (5720) | Payment account (cash/bank) | LOAN_TRANSACTION | `LOAN_TRANSACTION:<id>:1` |
| Charges | `LOAN_CHARGES` (5730) | Payment account | LOAN_TRANSACTION | same |
| Top-up | Receiving account (cash/bank) | The loan's own account | LOAN_TRANSACTION | same |
| Cancel a fee/charge/top-up | reversal of the above | | REVERSAL | n/a |

Rules:
- A fee/charge never touches the loan's own balance — it is an expense of the period paid, not added to the debt (decision D6's default). A top-up does the opposite: same shape as the disbursement, increasing the balance.
- `outstandingPrincipal()` sums every non-cancelled `TOP_UP` into the balance alongside the original `principal`, so it still equals the loan account's own ledger balance to the paisa.
- A fee/charge is refused once the loan is CANCELLED; a top-up additionally requires the loan to still be ACTIVE (not CLOSED either).
- `allTransactionsReport()` (R3) shows a fee/charge as `paid`, a top-up as `received` — the same direction as a Payment-Out/loan-disbursement row.

## Vyapar parity: purchase GST data, two posting paths (2026-10-26)

Source: `docs/VYAPAR_PARITY_SPEC.md` §2.5, G14. Implemented in `src/lib/accounting/purchase-posting.ts`. `postPurchaseInvoice()` picks the path per invoice, never a mix within one:

| Path | Condition | Subtotal / Tax / Total posted | Per-line fields written |
|---|---|---|---|
| Line-priced | Every `PurchaseInvoiceItem.hsnCode` is set | Summed from each line's `priceLine()` result — **overrides** whatever was entered at intake | `taxRatePercent`, `taxableValue`, `cgstAmount`, `sgstAmount`, `igstAmount`, `cessAmount` on each item |
| Header-blended (original, unchanged) | Any line is missing `hsnCode` | Exactly as entered at intake — unchanged from before this step | None — stays null, "line tax unavailable" |

| Event | Dr | Cr | sourceType | Idempotency key |
|---|---|---|---|---|
| Supplier bill, line-priced | `PURCHASES` (summed taxable) + `GST_INPUT_CGST`/`SGST`/`IGST`/`CESS` (summed per line) | `AP_TRADE` | SUPPLIER_BILL | `PURCHASE_INVOICE:<id>:1` |
| Supplier bill, header-blended | `PURCHASES` (header subtotal) + `GST_INPUT_CGST`/`SGST`/`IGST` split from the one header `taxAmount` | `AP_TRADE` | SUPPLIER_BILL | same |

Rules:
- `supplierGstin`/`placeOfSupply` are frozen onto the invoice at posting from `Supplier.gstNumber`/`Supplier.state` — the same moment `isInterState` is decided, mirroring `SalesInvoice.customerGstin`'s own convention.
- A line-priced invoice resolves each line's rate via `resolveTaxRate(hsnCode, invoiceDate)` — the same "never invent a rate" rule the sales side enforces. A missing verified `TaxRate` row refuses the whole posting (`PurchasePostingError`), not just that line.
- `itcEligibility`/`isReverseCharge` are set at intake (`createPurchaseInvoice`), not at posting — they're facts about the transaction known up front, unlike the supplier-state-dependent fields above.
- The ledger posting itself does not vary by `itcEligibility` or `isReverseCharge` yet — every purchase's GST still posts in full to `GST_INPUT_*`. GSTR-3B (R15) computes the ITC-available/ineligible/reverse-charge split from `PurchaseInvoice` fields directly, not from the ledger, for exactly this reason.

## Vyapar parity: Other Income, and TDS on receipts/payments (2026-10-26)

Source: `docs/VYAPAR_PARITY_SPEC.md` §5 D8/D9, §3.2 R11, §3.3 R17. Implemented in `src/lib/accounting/other-income.ts` (new) and additively in `receipts.ts`/`supplier-payments.ts`.

**Other Income** — the Dr/Cr mirror of `Expense`'s posting, approved in `approveOtherIncome()`:

| Event | Dr | Cr | sourceType | Idempotency key |
|---|---|---|---|---|
| Other income approved, flat amount or itemised w/o GST | `depositAccountId` (full amount) | `categoryAccountId` (subtotal) | OTHER_INCOME | `OTHER_INCOME:<id>:1` |
| Other income approved, GST applicable | `depositAccountId` (full amount) | `categoryAccountId` (subtotal) + `GST_OUTPUT_CGST`/`SGST`/`IGST` (always output tax — no ITC-claim equivalent) | OTHER_INCOME | same |
| Round-off (either case) | if rounded down: `ROUND_OFF` (the shortfall) | if rounded up: `ROUND_OFF` (the excess) | — | — |
| Cancel (reverse) | `reverseJournalEntry()` on `postedEntryId` — a linked mirror entry, original untouched | OTHER_INCOME | — |

Rules:
- `categoryAccountId` must resolve to a postable `INCOME`-typed `LedgerAccount` (`approveExpense`'s own "not a grouping account"/"not an expense account" checks, mirrored for INCOME).
- Round-off sign is the mirror image of `expenses.ts`: rounding the total **up** credits `ROUND_OFF` (more came in than the lines summed to); rounding **down** debits it. `expenses.ts` does the opposite because money is flowing the other way.
- Self-approval follows the same `canSelfApprove(role)` exemption as every other approve-and-post document (`SUPER_ADMIN` only, today).

**TDS on receipts/payments** — additive to the existing postings in `receipts.ts`/`supplier-payments.ts`, not a new document type:

| Event | Dr | Cr | Notes |
|---|---|---|---|
| Receipt with `tdsDeducted > 0` | `depositAccountId` (cash actually received) + `TDS_RECEIVABLE` (1145, the withheld amount) | `AR_TRADE` (allocated) + `ADVANCE_FROM_CUSTOMER` (unallocated) | `tdsDeducted` extends the allocation cap to `amount + tdsDeducted` — it settles an invoice exactly like cash does |
| Supplier payment with `tdsDeducted > 0` | `AP_TRADE` (allocated) + `ADVANCE_TO_SUPPLIER` (unallocated) | `paymentAccountId` (cash actually paid) + `TDS_PAYABLE` (2140, the withheld amount) | Same cap-extension rule, Dr/Cr reversed |

Rules:
- `tdsDeducted` defaults to 0 on both `Receipt` and `SupplierPayment` — every pre-existing call site is unaffected; the full pre-step-6 test suite (354 tests) passed unmodified before any TDS test was added.
- Gated by `Company.tdsCaptureEnabled` (default `false`) — **a UI gate only**. Neither `recordReceipt()` nor `recordSupplierPayment()` checks the flag; a caller that passes `tdsDeducted` gets it posted regardless. The flag only controls whether the "new receipt"/"new supplier payment" forms show the field.
- TCS (`TCS_RECEIVABLE` 1146, `TCS_PAYABLE` 2141) exists as chart-of-accounts stubs only — nothing in this codebase posts to them. `tdsTcsReport()` reports all four accounts' balances regardless, so TCS simply shows zero until a future change adds a collection point on the sales side.

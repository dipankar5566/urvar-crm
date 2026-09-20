# Accounting Test Plan

## Running

```
npm test          # vitest run
npm run test:watch
```

182 tests across fifteen files (62 from Phase 1, 47 added in Phase 2, 33
added in Phase 3, 23 added in Phase 4, 11 added in Phase 5, 6 added in Phase
6). This is the repo's first automated test suite; everything outside
`src/lib/accounting/` still has no coverage — Phase 6's voice-agent tool
wiring is exercised only by `npm run eval:agent`, and even that harness has
no scripted scenario for `get_account_status` itself (see below).

## The constraint that shapes everything

There is no separate test database and there cannot be one. `DATABASE_URL`
points at the live `urvar_crm`, and the app role `urvar_app` has
`rolcreatedb = false` — the same cause as the `prisma migrate dev` P3014
failure documented in CLAUDE.md.

So integration tests run against the real schema and the real seeded chart of
accounts, with every write discarded. `tests/helpers/db.ts`'s `withRollback()`
runs the body inside an interactive transaction and unwinds it by throwing a
sentinel. The throw is unconditional — there is no path on which the
transaction commits. Document numbers allocated inside the body are released
with the rollback, so tests do not burn invoice serials.

**Every new accounting integration test must go through `withRollback()`.**

### This already caught a real bug

The first run left 19 journal entries committed in production. `postJournalEntry`
had been sniffing whether it was handed a transaction client by checking for
`$transaction`; in Prisma 7 the interactive client exposes that too, so the
check always said "not a transaction" and every caller-supplied `tx` was
ignored in favour of an independent transaction that committed regardless of
the caller's rollback.

That is not a test-only defect — it would have silently broken Phase 2's
"create the invoice and post it atomically". The tell was document numbers
advancing across supposedly rolled-back tests. The contract is now explicit
rather than sniffed, and the leaked rows were removed.

## Coverage

### `tests/money.test.ts` — 17 tests
Boundary coercion (strings, numbers, Decimals, null, `(500)`, `1,23,456.78`),
rejection of garbage rather than silent zero, exactness (`0.1 + 0.2 === 0.3`,
1000 x `0.10` summing to exactly `100.00`), division-by-zero refusal,
percentage maths holding full precision until an explicit round, half-away-
from-zero rounding, `roundToRupee` round-tripping, and Indian digit grouping.

### `tests/fiscal.test.ts` — 13 tests
FY boundaries (31 Mar vs 1 Apr), Jan–Mar belonging to the previous FY, period
numbering from April, chronological ordering within the FY, FY labels
(`2026-27`, and `2099-00`), month-end dates including a leap February, and
twelve contiguous periods with no gap or overlap.

### `tests/permissions.test.ts` — 14 tests
Matrix completeness across all roles/modules/actions; no role holds delete on
accounting, invoices or payments; sales roles get nothing on the ledger;
`assertCan` throws for a sales executive on every accounting action; scoped
read-only visibility of invoices/payments; separation of duties including the
Super Admin exemption; and `scopeWhere` still returning an impossible match for
`none` rather than an empty filter.

### `tests/posting.test.ts` — 18 tests
The invariants that make the ledger trustworthy:

| Invariant | Assertion |
|---|---|
| Entries balance | A 4-line entry posts; debits equal credits |
| Unbalanced rejected | Off by ₹0.01 throws, naming the difference |
| Zero-total rejected | Nothing to post |
| Minimum two lines | One-sided entry rejected |
| No negative amounts | Rejected, with the reason |
| One side per line | Both debit and credit on a line rejected |
| Leaf accounts only | Posting to a grouping account rejected |
| Mappings resolve | Missing mapping throws naming the key |
| Idempotency | Same key twice yields one entry, two lines, `alreadyPosted: true` |
| Closed period | Rejected |
| No period | Rejected |
| Reversal mirrors | Debits and credits swap; party attribution survives |
| Original immutable | Lines byte-identical before and after (`toEqual`) |
| Reversal nets to zero | Original + reversal sum to `0.00` |
| Single reversal | Second attempt rejected |
| Reason required | Blank reason rejected |
| Audit is transactional | Audit row visible inside the same transaction |
| Numbering gapless | Five consecutive serials, no duplicates |
| Trial balance | Sum of all debits minus credits is `0.00` |

## Not covered

- React components and pages. No component testing library is installed.
- The rest of the CRM — leads, quotations, calls, imports, the voice agent.
  Unchanged by this work and still validated by `lint` + `build` + manual use.
- Concurrency. The `UPDATE ... RETURNING` row lock is reasoned about and
  single-threaded-tested, but not exercised by parallel writers. `vitest` runs
  with `fileParallelism: false` because tests share one database and would
  deadlock on the `DocumentSeries` lock rather than fail informatively.
- `npm run eval:agent` was not run. It makes billable live LLM calls, and
  CLAUDE.md scopes it to changes in the voice agent's prompt or tools — neither
  changed here. The only shared file touched is `src/lib/audit.ts`, whose
  signature change is backwards-compatible, and the project-wide typecheck
  (which covers `voice-agent/**`) is clean.

## Phase 3 coverage (implemented)

### `tests/purchase-posting.test.ts` — 7 tests
Intra-state CGST+SGST split and a balanced entry; an odd-paisa rounding drift
folded into SGST so the split always sums exactly to the header tax figure
(this is the test analogous to Phase 2's round-off catch — it passed first
try, but is exactly the shape of bug that class of test exists to catch);
inter-state IGST; refusing to post while the supplier has no state; refusing
to re-post an already-posted invoice; cancellation reversing the entry; and
refusing to cancel while a payment is allocated.

### `tests/supplier-payments.test.ts` — 8 tests
Full and partial payment reaching PAID/PARTIALLY_PAID; refusing over-
allocation past the outstanding amount; refusing allocation against a DRAFT
(unposted) invoice; refusing cross-supplier allocation; a zero-amount guard;
over-payment routing to `ADVANCE_TO_SUPPLIER` with a balanced entry; and
cancellation reversing the entry and reopening the invoice.

### `tests/expenses.test.ts` — 11 tests
Creation validation (zero amount, non-EXPENSE category account, grouping
account refused); approval posting a balanced entry debiting the category and
crediting the payment account; refusing to approve a non-SUBMITTED expense;
**separation of duties** — a submitter cannot approve their own expense
unless they hold the Super Admin exemption, tested both ways; rejection
leaving no posting behind; and cancellation reversing an approved expense's
entry.

### `tests/payables.test.ts` — 5 tests
`supplierPayable()` at zero/full/partial/other-supplier states, mirroring
`receivables.test.ts` on the AR side; `allSupplierPayables()` listing only
suppliers with a non-zero balance.

### `tests/permissions.test.ts` additions — 2 tests
The new `expenses` module is invisible to sales roles and grants no delete
to any role, including `SUPER_ADMIN` — the same append-only rule as every
other ledger-touching module.

## Phase 4 coverage (implemented)

### `tests/costing.test.ts` — 9 tests
`weightedAverageCost()`: null with no purchase history; null while the only
purchase is DRAFT; a CANCELLED invoice ignored; a single purchase returned
exactly; multiple purchases at different price/quantity weighted correctly
(the arithmetic case that actually proves the formula, not just that it
returns *something*); PARTIALLY_PAID/PAID counted alongside POSTED; a
purchase dated after the as-of date excluded. `weightedAverageCosts()`
(batch): returns a cost only for products with history, keyed correctly;
empty input returns an empty map.

### `tests/stock-valuation.test.ts` — 14 tests
`createStockValuation()`: a manual unit cost computes value correctly; the
computed weighted average is used when no override is given (and stored at
its full 4dp precision, not the 2dp money scale — the assertion for this one
initially compared against the wrong scale and had to be fixed); a product
with neither purchase history nor a manual cost is refused; a duplicate
product in one valuation is refused; a second valuation for an
already-valued period is refused; a negative quantity is refused.
`deleteStockValuationDraft()`: a DRAFT deletes outright; a POSTED one is
refused (cancel it instead). `postStockValuation()`: posts a balanced Dr
Inventory / Cr COGS entry for the total value; refuses an empty valuation;
refuses posting the same valuation twice; **reverses the previous period's
posted valuation, dated at this period's start** — the roll-forward
mechanism this phase's design actually depends on, so it's tested directly
rather than assumed from the reversal primitive already being tested
elsewhere. `cancelStockValuation()`: reverses a posted valuation; refuses to
cancel one already superseded by a later period's posting.

## Phase 2 coverage (implemented)

### `tests/tax.test.ts` — 13 tests
`isInterState` case/whitespace tolerance, place-of-supply validation,
CGST+SGST vs IGST split, cess on top of either, and `priceLine` applying
discount before tax and refusing a non-positive quantity.

### `tests/invoicing.test.ts` — 11 tests
Balanced posting for intra- and inter-state sales, refusing an unpriced HSN or
an unverified tax rate, refusing an order with no lines, partial invoicing
across two calls with `quantityInvoiced` tracked correctly, refusing to
over-invoice, a fractional-quantity round-off case (this is the test that
caught the round-off polarity bug), and cancellation reversing the entry while
refusing when a receipt is already allocated.

### `tests/receipts.test.ts` — 10 tests
Full and partial payment reaching PAID/PARTIALLY_PAID correctly, the
over-allocation guard (both "more than one invoice's outstanding" and
"allocations exceed the receipt total"), refusing cross-customer allocation,
over-payment routing the remainder to `ADVANCE_FROM_CUSTOMER` with a balanced
entry, a pure on-account receipt with zero allocations, and cancellation
reversing the entry and reopening the invoice.

### `tests/receivables.test.ts` — 8 tests
`customerReceivable()` at zero/full/partial/multi-invoice/other-customer
states; `syncCustomerOutstanding()` writing the derived figure and being
idempotent; `reconcileOutstandingAmounts()` flagging a stale stored value
(the exact R1 scenario) and confirming a match after sync.

### `tests/permissions.test.ts` additions — 5 tests
Regression coverage for the R2 fix: `scopedWhere()` preserves both the scope
restriction and a colliding request filter as separate AND branches, for
`own`, `territory`, `none` and `all` scopes.

## Phase 5 coverage (implemented)

### `tests/financial-reports.test.ts` — 11 tests
`trialBalance()`: debit and credit columns sum equal and show the posted
amount on the correct side; a net-zero account is omitted. `generalLedger()`:
an opening balance computed from activity before the range carries forward
correctly into a running balance; **a reversed entry nets to zero only once
the reversal date has passed** — the case that would have caught a
status-based filtering bug before it shipped, not after. `profitAndLoss()`:
revenue from a real posted sales invoice appears correctly and rolls into net
profit; activity outside the date range is excluded. `balanceSheet()`:
Assets = Liabilities + Equity after a real posting (not asserted as an
assumption — computed and compared); cumulative net profit is folded into
equity as Current Earnings. `gstTaxSummary()`: output tax from a sales
invoice and input tax from a purchase invoice both compute correctly and net
to the right payable figure. `gstOutwardSupplyRegister()`: a posted invoice's
HSN and taxable value appear; a cancelled invoice is excluded.

## Phase 6 coverage (implemented)

### `tests/receivables.test.ts` / `tests/payables.test.ts` additions — 2 regression tests
The bug found while building this phase: `customerReceivable()`/
`supplierPayable()` filtered `entry: { status: "POSTED" }`, which excluded a
cancelled invoice's original (now `REVERSED`) entry while still counting its
reversal — each test posts an invoice, cancels it, and asserts the balance
nets to `0.00`, not the phantom negative the bug produced.

### `tests/receivables.test.ts` — `customerAccountStatus()`, 4 tests
No overdue invoices or payment history for a clean customer; a `POSTED`
invoice past its due date is flagged with the correct days-overdue and
outstanding amount; an invoice not yet past its due date is not flagged; the
last posted receipt appears as payment history.

Not covered by Vitest — voice-agent code has no unit-test harness, only
`npm run eval:agent`: the `get_account_status` tool's wiring (customerId
resolution from `Customer.sourceLeadId`, the `AI_FINANCIAL_DISCLOSURE_ENABLED`
gate, the audit-log write on disclosure). Verified manually by reading the
code path and by `npx tsc`/`npm run lint`/`npm run build` all passing; the
eval harness itself has no scripted "customer asks about their balance"
scenario, a real coverage gap worth closing before this flag is ever flipped
on in production.

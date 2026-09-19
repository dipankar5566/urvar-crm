# Accounting Test Plan

## Running

```
npm test          # vitest run
npm run test:watch
```

62 tests across four files. This is the repo's first automated test suite;
everything outside `src/lib/accounting/` still has no coverage.

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

## Phase 2 additions

Invoice totals reconciling to lines plus charges plus tax; a receipt refusing
to allocate beyond the outstanding amount; over-payment landing in advances;
customer balance equalling the sum of their ledger; AR ageing total equalling
the AR control-account balance; a cancelled invoice reversing rather than
deleting; and a regression test for the `reports.ts` scope-collision bug.

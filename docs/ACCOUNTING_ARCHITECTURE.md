# Accounting Architecture

How the accounting engine is put together, and why it is shaped this way.

## The central decision: posting is a service, not a side effect

A financial document — an invoice, a receipt, a bill — is a business record
that *describes* a transaction. Turning it into ledger movement is a separate,
centralized step.

`src/lib/accounting/posting.ts` is the only module in the codebase permitted to
write `JournalEntry` or `JournalLine`. Documents never write GL rows and never
carry a balance column; every balance is derived by summing posted lines.

This is what makes the invariants enforceable rather than aspirational. A
document cannot forget to balance, cannot slip a posting into a closed period,
and cannot post itself twice — because it is not the thing doing the posting.

The alternative most small systems reach for is a `balance` column on the
customer updated by each transaction. This codebase already demonstrates why
that fails: `Customer.outstandingAmount` is a hand-typed field that nothing
reconciles, and the AI voice agent's credit check reads it.

## Module map

| Module | Responsibility |
|---|---|
| `money.ts` | Decimal arithmetic. The only way amounts enter the ledger. |
| `fiscal.ts` | Indian FY arithmetic — 1 April to 31 March, periods 1-12 from April. |
| `company.ts` | Resolves the single selling legal entity. |
| `account-map.ts` | Named posting roles → ledger accounts. |
| `numbering.ts` | Gapless, per-FY document numbers under a row lock. |
| `chart-of-accounts.ts` | The starting CoA as plain data, plus default mappings. |
| `posting.ts` | `postJournalEntry()` / `reverseJournalEntry()`. |

`chart-of-accounts.ts` deliberately imports nothing from Prisma so the seed
runner under `scripts/` can pull it in by relative path — tsx does not resolve
the `@/` alias, the same constraint `prisma/seed.ts` works around.

## Money

Storage was already correct: every monetary column is `NUMERIC(p,2)`. The gap
was computation. The pre-existing `computeTotals()` in `quotations/actions.ts`
multiplies and sums in IEEE `number` and writes the result unrounded, letting
Postgres round on insert. Survivable for a quotation total; fatal for a ledger
where a posting is rejected unless debits equal credits exactly.

`money.ts` wraps `Prisma.Decimal` — decimal.js, re-exported by the generated
client, so no new dependency and no conversion step when reading a Decimal
column back. Values are coerced once at the boundary by `money()`, stay Decimal
throughout, and are rounded only where a rounding decision is actually being
made.

Two rounding operations exist, and they are different:

- `round()` — to paise. What most callers need.
- `roundToRupee()` — returns `{ rounded, adjustment }`. An Indian invoice total
  is customarily rounded to the nearest rupee with the difference shown as a
  Round Off line; returning both halves keeps that line derived rather than
  recomputed somewhere else and allowed to disagree.

## Idempotency

Every posting carries an `idempotencyKey`, unique in the database, composed as
`${sourceType}:${sourceId}:${revision}`. It is checked first, before any
validation, so a retry costs one indexed read and never re-validates against a
period that has closed in the meantime. A duplicate returns the existing entry
with `alreadyPosted: true` rather than throwing — that is the correct semantic
for a retried Server Action or a replayed webhook.

## Transaction handling

`postJournalEntry(input, tx?)` joins the caller's transaction when given one,
and opens its own otherwise. Creating an invoice and posting it must be atomic,
so Phase 2 will always pass `tx`.

An earlier version tried to detect at runtime whether it had been handed a
transaction client by checking for `$transaction`. In Prisma 7 the interactive
client exposes that too, so the check always said "not a transaction" and every
caller-supplied `tx` was silently ignored in favour of an independent
transaction that committed regardless of the caller's rollback. The integration
tests caught it by noticing document numbers advancing across rolled-back
tests. There is no reliable way to sniff this; the contract is explicit instead.

The audit row is written inside the same transaction as the posting. An audit
trail that can be missing the entry it was meant to record is not an audit
trail. `logAudit()` now takes an optional transaction client for this, with a
default that keeps the ~35 existing CRM call sites working unchanged.

## Immutability

Posted entries are never updated or deleted. A mistake is corrected by
`reverseJournalEntry()`, which writes a new entry with every line's debit and
credit swapped, links it via `reversesEntryId`, and marks the original
`REVERSED`. The original's rows stay byte-identical — there is a test asserting
exactly that.

This is reinforced in the permission matrix: `accounting.delete` is `"none"`
for every role including `SUPER_ADMIN`. It is the one place this repo's
"delete is Super Admin only" convention is tightened rather than relaxed.

## Document numbering

GST Rule 46(b) requires a consecutive serial number unique within a financial
year. The CRM's existing `id-sequences.ts` derives numbers from `COUNT(*) + 1`
with a collision retry — not gapless (a deleted row shifts it), not per-FY (the
prefix rolls in April, the counter does not), and racy.

`numbering.ts` advances a counter row with a single
`UPDATE ... RETURNING` statement, which takes a row-level write lock held for
the enclosing transaction. Two concurrent invoices serialise there and each
gets its own number, with no retry loop and no gap. Because the allocation
happens inside the document's own transaction, an aborted insert releases the
number instead of burning it.

Format is `INV/2026-27/0001`. The `/` separator distinguishes statutory
documents from CRM ones, which keep their existing `QT-2026-0001` style.

## Tax

Rates live in the `TaxRate` table keyed by HSN, never as literals in code, and
start with `isVerified: false`. The tax engine refuses to price an invoice from
an unverified row, so the system cannot quietly invent a rate. The brief is
explicit that GST treatment is never assumed, and this is the mechanism.

CGST/SGST is always half the total rate each and IGST is the full rate, so one
`ratePercent` column is stored rather than three that can drift apart.

## What is not here, and why

**Multi-tenancy at the ledger level.** `Company` scopes what genuinely belongs
to a legal entity — financial periods and document series. `LedgerAccount` and
`JournalEntry` are not company-scoped. Urvar is one Pvt Ltd; threading a tenant
key through every posting call to support a second entity that does not exist
would cost more than it saves.

**Inventory valuation.** Quantities live in the sibling ERP (`urvar_erp`, same
Postgres instance, Drizzle). Its two exposed views carry quantity but no cost,
so COGS needs either a costed view added to the ERP contract or a CRM-side
weighted average from purchase invoices. The accounts exist; nothing posts to
them yet.

**An approval workflow.** The `approve` action and `assertCanApprove()` exist
and are tested, but no Phase 1 document requires approval. They are in place so
Phase 3's payment approvals do not require reopening the whole permission
matrix.

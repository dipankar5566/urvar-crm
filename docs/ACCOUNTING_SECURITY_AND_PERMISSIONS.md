# Accounting Security and Permissions

## The matrix

RBAC is enforced in application code, not middleware. `src/lib/permissions.ts`
holds a matrix of **18 modules x 4 actions x 5 roles**, every cell a scope of
`none` / `own` / `territory` / `all`. TypeScript enforces completeness: a
missing cell is a compile error, which is why adding a module means filling all
five role rows rather than only the one being tested.

Four modules were added: `accounting` (the ledger — chart of accounts, journal,
periods), `invoices`, `payments`, `gst`.

| Module | SUPER_ADMIN | SALES_MANAGER | SALES_EXECUTIVE | DISTRIBUTOR_MANAGER | ACCOUNTS_TEAM |
|---|---|---|---|---|---|
| accounting | r/w/approve all, **no delete** | none | none | none | r/w/approve all, no delete |
| invoices | r/w/approve all, no delete | read all | read own | read territory | r/w/approve all, no delete |
| payments | r/w/approve all, no delete | read all | read own | read territory | r/w/approve all, no delete |
| gst | r/w/approve all, no delete | none | none | none | r/w/approve all, no delete |

Sales roles get read-only visibility of invoices and payments, scoped the way
the rest of their data is. That is enough to answer "has this customer paid?"
on a call without exposing the books. They get nothing at all on `accounting`
and `gst`, the same way `purchases` is already invisible to them.

## The fourth action

`approve` was added to the `Action` union. Adding it forced every existing cell
to be revisited, which was the point — it is `"none"` on all fourteen
pre-existing modules because none of them has an approval step, and that is now
a stated fact rather than an omission.

## Deletion

`accounting.delete`, `invoices.delete` and `payments.delete` are `"none"` for
**every** role, Super Admin included.

This is the one place the repo's "delete is Super Admin only" convention is
tightened rather than relaxed. A posted journal entry is corrected by a linked
reversing entry; there is no code path that removes one, and no role that could
authorise it if there were.

## Separation of duties

Holding `approve` scope is necessary but not sufficient. `assertCanApprove()`
additionally refuses when the approver is the document's creator — the control
that actually matters on a payment is that the person who raised it is not the
person who releases it, and a role check alone cannot express that because it
is a fact about the specific document.

`SUPER_ADMIN` is exempt. On a five-person company there has to be someone who
can unblock a stuck document; pretending otherwise just means the control gets
worked around by sharing a login. The exemption is audited like any other
approval, so it is visible rather than silent.

## Scope composition

Every accounting query must compose its scope as:

```ts
const where = { AND: [scopeWhere(scope, user, ownerField), filters] };
```

Never spread `scopeWhere(...)` and then set a sibling key. That is a plain JS
object-key collision that silently overwrites the scope restriction instead of
erroring.

**This bug is live in the codebase today.** `src/lib/reports.ts:48-54` spreads
`scopeWhere(scope, user, "assignedToId")` and then assigns
`where.assignedToId = filters.repId`, so a `SALES_EXECUTIVE` (reports scope
`own`) can read another rep's report via `?repId=`. The same shape at
`reports.ts:86-89` lets a territory-scoped `DISTRIBUTOR_MANAGER` read revenue
outside their territory via `?state=`.

No financial report may be added to that code path until it is fixed. It is
scheduled inside Phase 2, before any ledger-derived report ships, and
`tests/permissions.test.ts` will carry a regression test for it.

## Audit trail

Every accounting mutation writes an `AuditLog` row **inside the same
transaction** as the change. `logAudit()` now accepts an optional
`Prisma.TransactionClient` for this; the default preserves the ~35 existing CRM
call sites, where a standalone write is acceptable because the business record
is the source of truth anyway.

Actions logged: `POST`, `REVERSE`, `CLOSE_PERIOD`, `REOPEN_PERIOD`,
`LOCK_PERIOD`, `OPEN_FINANCIAL_YEAR`. Entity types `JournalEntry` and
`FinancialPeriod` were added to the audit-log page's filter list, along with
`PurchaseInvoice`, `FieldVisit`, `DELETE`, `CHECK_IN` and `CHECK_OUT`, which
were already being written and were not filterable.

`ipAddress` exists on `AuditLog` and was never populated; `logAudit()` now
accepts it, though no accounting call site passes one yet.

## Period locking

- `OPEN` accepts postings.
- `CLOSED` refuses them. Reopenable by Super Admin only.
- `LOCKED` is permanent, reserved for a period whose GST returns have been
  filed. Nothing reopens it, and the UI requires a typed confirmation.

Enforcement is in the posting service, not the UI. Hiding the button is not the
control — `postJournalEntry()` re-reads the period status inside the
transaction and rejects.

## Known gaps

- **No rate limiting** on accounting Server Actions. Low risk while the module
  is internal and behind auth, but worth adding before any customer-facing
  financial endpoint.
- **Self-approval exemption is unconditional for Super Admin**, not logged as a
  distinct action. It appears in the audit trail as an ordinary approval by
  that user; distinguishing it would be clearer.
- **`Customer.outstandingAmount` is still hand-typed** and still read by
  `safe-zone.ts` to gate `AI_AUTO_QUOTE_ENABLED`. Phase 2 derives it from
  posted AR lines and makes the field read-only. Until then the AI's credit
  check rests on a number a human typed into a text box.

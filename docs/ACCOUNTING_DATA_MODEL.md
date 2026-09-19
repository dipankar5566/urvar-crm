# Accounting Data Model

Eight new tables and seven new enums, added by migration
`20260920011115_accounting_foundation`. Strictly additive — no existing table
was altered, no column dropped or retyped.

## Entity relationships

```
Company --< FinancialPeriod --< JournalEntry --< JournalLine >-- LedgerAccount
   |                                 |                               |
   +--< DocumentSeries               |                               |
                                     +-- reverses (self, 1:1)        |
                                                    AccountMapping >-+
TaxRate  (standalone, keyed by HSN)
```

`JournalLine.partyType` + `partyId` point at a `Customer` or `Supplier` without
a foreign key — the party may live in either table, and a subledger balance is
derived by filtering on the pair.

`JournalEntry.sourceType` + `sourceId` point at the originating document the
same way, for the same reason.

## Tables

### `Company`
The selling legal entity. One active row. Holds GSTIN, PAN, address, bank
details and `fyStartMonth` (4 for India).

A table rather than constants because these print on a tax invoice and must be
correctable by an admin — the existing quotation PDF hardcodes the company name
in its template, which is exactly what this replaces. Seeded with the legal
name and state only; **GSTIN, address and bank details are left null on
purpose** and nothing will invent them.

`state` is load-bearing: it is the origin for place-of-supply comparison, and
silently decides CGST+SGST vs IGST on every invoice.

### `LedgerAccount`
A node in the chart of accounts. Self-referencing `parentId` builds the tree.

- `code` is the stable identity (`1130`, `4100`). Names may be edited; codes
  may not, because mappings and report groupings resolve through them.
- `type` is ASSET / LIABILITY / EQUITY / INCOME / EXPENSE.
- `normalBalance` is stored rather than derived from `type`, so a contra
  account — Sales Returns is an INCOME account that normally carries a debit —
  needs no special case.
- `isPostable` is false for grouping accounts. Posting to a parent would
  double-count it against its own children in every rolled-up report; the
  posting service rejects it.
- `isSystem` marks accounts the seed owns and mappings depend on.

68 accounts seeded.

### `FinancialPeriod`
One month of one financial year, scoped to a company.

- `financialYear` is the FY's **starting** calendar year: FY 2026-27 is `2026`.
- `periodNumber` is 1-12 counting from April, stored rather than derived so
  ordering by it is chronological within the FY rather than the calendar year.
- `startDate`/`endDate` are inclusive, ending at 23:59:59.999.
- `status`: `OPEN` accepts postings, `CLOSED` refuses them but can be reopened
  by a Super Admin, `LOCKED` is permanent and reserved for a period whose GST
  returns have been filed.

Unique on `(companyId, financialYear, periodNumber)`.

### `JournalEntry`
A balanced set of debits and credits. Immutable once `POSTED`.

- `idempotencyKey` is unique — this is the double-post guard.
- `reversesEntryId` is unique and self-referencing, so an entry can be reversed
  at most once.
- `sourceType`/`sourceId` link back to the originating document.
- `entryNumber` comes from `DocumentSeries`, format `JV/2026-27/0001`.

### `JournalLine`
One side of one entry.

- `debit` and `credit` are `Decimal(16,2)`, both non-negative, exactly one
  non-zero. A negative amount is never used to mean the other side — it would
  break every SUM-based report.
- `lineNumber` preserves authoring order, so a ledger prints lines as written
  rather than by cuid.
- `partyType`/`partyId` give AR/AP subledger attribution.

Indexed on `entryId`, `accountId`, and `(partyType, partyId)`.

### `AccountMapping`
`key` maps to `accountId`. 24 keys seeded. Resolves named posting roles
(`AR_TRADE`, `GST_OUTPUT_CGST`, `ROUND_OFF`) so no account id or code appears at
a call site. Validated by `validateAccountMappings()`, which also catches a
mapping pointing at a non-postable or inactive account — the failure mode worth
catching early, because it posts fine and quietly double-counts.

### `DocumentSeries`
`(companyId, documentType, financialYear)` maps to `prefix`, `padding`,
`nextNumber`. Advanced by `UPDATE ... RETURNING` under a row lock inside the
document's own transaction.

### `TaxRate`
GST rate master keyed by HSN, with an `effectiveFrom`/`effectiveTo` window so a
historical invoice stays re-derivable after a rate change.

One `ratePercent` is stored, not three: CGST/SGST is half each and IGST is the
full rate, so a single number keeps intra- and inter-state consistent by
construction.

`isVerified` defaults false and gates pricing. One row seeded (HSN `3101` at
5%, carried over from `Product.gstPercent`), unverified, with a note recording
that all four products share that HSN and that Liquid Humic Acid at 3101 needs
a second look.

## Enums

`LedgerAccountType`, `NormalBalance`, `FinancialPeriodStatus`,
`JournalSourceType`, `JournalEntryStatus`, `PartyType`, `TaxTreatment`.

## Transaction lifecycle

```
document created (DRAFT)
        |
        +- user posts it
        |       |
        |       +- idempotency key already seen? --> return existing entry
        |       +- lines balance?            --no--> reject
        |       +- accounts postable/active? --no--> reject
        |       +- period OPEN?              --no--> reject
        |       |
        |       +- allocate number, write entry + lines + audit  (one tx)
        |
        +- mistake found
                |
                +- reverseJournalEntry()
                        +- write mirror entry, link it
                        +- mark original REVERSED  (original rows untouched)
```

## Phase 2 additions (not yet built)

`SalesInvoice`, `SalesInvoiceItem` (snapshotting `hsnCode`, `taxRate` and the
CGST/SGST/IGST split at issue time — the existing `QuotationItem` snapshots
neither, so historical quotation tax is not reconstructible), `Receipt`,
`ReceiptAllocation`, `CreditNote`, and `OrderItem` (the existing `Order` is a
header with one `totalAmount` and no lines).

## Migration notes

- Generated with `prisma migrate diff --from-config-datasource`, read before
  applying, and verified to contain no destructive statement and no `ALTER`
  other than `ADD CONSTRAINT` on the new tables.
- A `pg_dump` was taken immediately before `migrate deploy`.
- Rollback is removing the eight new tables and reverting `schema.prisma` —
  nothing existing was modified.

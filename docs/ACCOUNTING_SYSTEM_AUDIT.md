# Accounting System Audit

Phase Zero audit of Urvar CRM before the accounting build, plus what has
changed since. Conducted 2026-09-20 against commit `c060b49`.

## Scope of what existed

Next 16.2.9 / React 19 / Prisma 7.8 / Postgres 18, better-auth, PM2 +
Cloudflare Tunnel on the same Windows box that serves production. Fourteen
working CRM modules. Sales flow ran Lead → Customer → Quotation → Order and
**stopped at Order**. Procurement captured supplier invoices via Sarvam OCR.

### Accounting present before this work

None. No chart of accounts, journal, ledger, payment, receipt, allocation,
expense, cash/bank account, stock movement, inventory quantity, valuation, tax
master, financial period, credit note, sales invoice, company record or
currency. `Order.paymentStatus` was a three-state enum with no amount, date or
method behind it, and **no code wrote it after creation**.

### What was reusable, and was reused

- **Money was already `Decimal`** — 27 monetary columns at `NUMERIC(p,2)`, zero
  float at rest. No storage remediation needed. This was the single biggest
  head start.
- `Role.ACCOUNTS_TEAM` already existed with a seeded user.
- `AuditLog` was entity-agnostic and already wired into 35 call sites.
- `Customer.gstNumber`/`panNumber`, `Product.hsnCode`/`gstPercent`,
  `Supplier.gstNumber` existed.
- Tax was never accepted from the client — `computeTotals()` reads the rate off
  the `Product` row. The strongest money-integrity property in the app; kept.
- Nav is data-driven from a single array keyed to the `Module` union.

## Risk register

| # | Finding | Status |
|---|---|---|
| R1 | `Customer.outstandingAmount` is hand-typed, and `safe-zone.ts` reads it to gate the AI's auto-quote credit check | **Open** — Phase 2 derives it |
| R2 | `reports.ts` spreads `scopeWhere()` then overwrites the key, leaking cross-rep and cross-territory data | **Open** — fixed in Phase 2 before any financial report |
| R3 | Document numbers are `COUNT(*) + 1`: not gapless, not per-FY, racy | **Fixed for financial documents** via `DocumentSeries` |
| R4 | All money arithmetic is IEEE float | **Fixed in accounting**; `computeTotals()` unchanged |
| R5 | `Order` has no line items; status/paymentStatus never written after creation | **Open** — `OrderItem` lands in Phase 2 |
| R6 | `QuotationItem` snapshots neither tax rate nor HSN, so historical tax is unreconstructible | **Open** — `SalesInvoiceItem` will snapshot both |
| R7 | Product catalogue could not be invoiced from | **Largely resolved** — see below |
| R8 | Three independent quotation write paths with duplicated order-creation logic | **Open** — centralised in Phase 2 |
| R9 | `logAudit()` not transactional; `prisma/seed.ts` wipe list stale | **Fixed** |
| R10 | No test suite; production and dev share one database | **Partly fixed** — Vitest covers accounting; the shared DB is structural |

### R7 correction

`docs/PRODUCT_CATALOGUE.md` (dated 2026-09-19) states all four products have
`mrp = 0`. That is **stale**. Live data as of 2026-09-20:

| SKU | Product | Pack | MRP | Dealer | HSN | GST |
|---|---|---|---|---|---|---|
| URNP0108 | Enriched Vermicompost | 25 kg | 350 | 237.50 | 3101 | 5% |
| URNP0109 | Phosphate Rich Organic Manure | 50 kg | 1499 | 750 | 3101 | 5% |
| URNP0110 | Liquid Humic Acid | 1 L | 200 | 90 | 3101 | 5% |
| URNP0111 | Cow Dung Manure [FYM] | 25 kg | 250 | 175 | 3101 | 5% |

Prices and HSN codes now exist. Two things still need an accountant:

1. **All four share HSN `3101`.** Plausible for vermicompost, FYM and PROM
   (animal/vegetable fertilisers). **Questionable for Liquid Humic Acid**,
   which is commonly classified elsewhere. Misclassification is a rate and
   return problem, not a cosmetic one.
2. The 25 kg vs 5 kg pack-size disagreement between the CRM and the knowledge
   graph is still unresolved, and `PRODUCT_CATALOGUE.md` itself flags that pack
   size reaches quotations and invoices.

`TaxRate` carries these as **unverified** rows, and the tax engine refuses to
price an invoice from an unverified row — so the gap is visible rather than
silently becoming fact.

## Production data volume

Near-empty, which is why migration risk was minimal: 339 leads, **1 customer**,
4 products, 3 quotations, 2 orders, 0 suppliers, 0 purchase invoices. The one
customer has `outstandingAmount = 0` and no GSTIN. All customers are in West
Bengal, so place-of-supply is currently always intra-state — inter-state still
has to work, it just is not exercised yet.

## The ERP boundary

`D:\urvar-erp` is **Postgres + Drizzle** on the same instance (database
`urvar_erp`), not SQLite. It ships `phase2-erp-views.sql` and
`phase2-crm-fdw.sql`, which expose two read-only views to the CRM over
`postgres_fdw` behind a minimally-privileged `crm_reader` role. Nothing in the
CRM references them, so treat the integration as designed-not-wired.

`v_stock_available` gives quantity per finished good. **Neither view exposes
cost.** COGS therefore needs either a costed view added to the ERP contract or
a CRM-side weighted average from purchase invoices — the Phase 4 decision.

Two issues to fix before relying on it: the user mapping is created `FOR
postgres` while the CRM connects as `urvar_app`, and `crm_reader_dev_pw` is a
hardcoded password in a checked-in SQL file.

## What Phase 1 delivered

Eight tables, seven enums, one strictly-additive migration. A Decimal money
layer, Indian FY arithmetic, a 68-account chart of accounts with 24 named
mappings, gapless per-FY document numbering, and a posting service that is the
only writer of ledger rows. RBAC extended to 18 modules x 4 actions x 5 roles
with a new `approve` action and separation of duties. 62 automated tests, the
repo's first. Three UI routes under `/accounting`.

See `ACCOUNTING_ARCHITECTURE.md` for how, `ACCOUNTING_POSTING_MATRIX.md` for
the debit/credit contract, and `ACCOUNTING_IMPLEMENTATION_PLAN.md` for status.

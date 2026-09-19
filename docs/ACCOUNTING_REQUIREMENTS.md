# Accounting Requirements

What the system must do, and which requirements are confirmed versus assumed.
Anything marked **ASSUMED** needs sign-off before it becomes behaviour.

## Business context

Urvar Natural Pvt Ltd manufactures and sells organic fertilisers — vermicompost,
cow dung manure/FYM, PROM, humic acid — to dealers, distributors, FPOs/FPCs,
farmers, retailers and institutional buyers. India, INR, Indian number
formatting, financial year 1 April to 31 March.

## Functional requirements

### Confirmed

| # | Requirement | Phase |
|---|---|---|
| F1 | Double-entry ledger where every posted entry balances exactly | 1 · done |
| F2 | Chart of accounts with parent/child grouping and postable leaves | 1 · done |
| F3 | Financial periods that can be closed and permanently locked | 1 · done |
| F4 | Posted entries immutable; corrections by linked reversal | 1 · done |
| F5 | Gapless, per-financial-year document numbering | 1 · done |
| F6 | Decimal money arithmetic end to end | 1 · done |
| F7 | Audit trail committing atomically with the change it records | 1 · done |
| F8 | Sales invoice with per-line HSN and tax snapshot | 2 |
| F9 | Receipts allocated against specific invoices; partial and over-payment | 2 |
| F10 | Customer ledger and AR ageing derived from posted lines | 2 |
| F11 | Credit notes for returns and corrections | 2 |
| F12 | Supplier bills, payments, AP ageing, ITC tracking | 3 |
| F13 | Expense capture with an approval workflow | 3 |
| F14 | Inventory valuation and COGS | 4 |
| F15 | Trial Balance, P&L, Balance Sheet, GST registers | 5 |
| F16 | Opening balances migrated from Vyapar | with 2 |

### Tax — all configurable, none hardcoded

| # | Requirement | Status |
|---|---|---|
| T1 | CGST/SGST on intra-state, IGST on inter-state, from place of supply | Designed |
| T2 | Rates held per HSN in a table, versioned by effective date | Done |
| T3 | A rate cannot be used until a tax professional marks it verified | Done |
| T4 | Customers may or may not be GST-registered | Schema supports |
| T5 | Round-off to the nearest rupee as an explicit ledger line | Done (`roundToRupee`) |

**ASSUMED, needs the accountant:**
- All four products are correctly HSN `3101` at 5%. Carried over from
  `Product.gstPercent`, seeded unverified. **Liquid Humic Acid at `3101` is
  doubtful.**
- Freight is part of taxable value rather than a separate supply. Currently
  modelled as `FREIGHT_RECOVERED` revenue with tax applied.
- No reverse-charge supplier categories.
- E-invoicing (IRN) and e-way bills do not apply at current turnover. **No
  integration exists and none is claimed.**

## Non-functional requirements

| # | Requirement | Status |
|---|---|---|
| N1 | Server-side authorization on every action; hiding a button is not security | Done — `assertCan` on every accounting action |
| N2 | Financial writes atomic | Done — single transaction incl. audit |
| N3 | Duplicate submissions cannot double-post | Done — `idempotencyKey` |
| N4 | Money never in floating point | Done in accounting |
| N5 | No posted invoice, payment or journal entry deletable | Done — `delete: "none"` for every role |
| N6 | Separation of duties on high-risk operations | Done — `assertCanApprove()` |
| N7 | Migrations additive and reversible | Done |
| N8 | No fabricated company, bank, GST or customer data | Done — seeded null, loudly |
| N9 | Indexed queries and pagination on large ledgers | Partial — indexes in place, journal paginates at 100 |
| N10 | Rate limiting on financial endpoints | **Not done** |

## Explicit non-goals

- **Automated GST return filing, GST portal connectivity, e-invoicing, e-way
  bills, real-time GSTIN validation.** None implemented, none claimed. Adding
  any means documenting the provider, eligibility, credentials, cost, failure
  handling and reconciliation first.
- **Multi-entity accounting.** One `Company`; the ledger is not tenant-scoped.
- **Inventory quantity in the CRM.** It lives in the ERP. The CRM holds value
  only, once Phase 4 settles how cost crosses the boundary.
- **Payroll, fixed-asset depreciation schedules, bank feed integration.**
- **Replacing the CRM's existing quotation flow.** `computeTotals()` still runs
  in float; it is unchanged and out of scope until Phase 2 supersedes it for
  invoicing.

## Constraints inherited from the environment

- Production and development share one database; the app role cannot create
  another. Integration tests run inside rolled-back transactions.
- `prisma migrate dev` fails with P3014; migrations go through
  `migrate diff` + `migrate deploy`.
- Single PM2 process, so the in-process cron and the row-lock numbering are
  both safe — scaling to multiple instances would break assumptions in the
  reminder cron first.
- Ports 3000-3003 are taken; local dev runs elsewhere and must not create
  `.env.local`.

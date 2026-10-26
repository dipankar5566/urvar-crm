# Vyapar Parity Spec: Cash, Bank, Assets & Reports

**Status:** DRAFT for review, 2026-10-25. Nothing in this document is implemented yet.
**Plan:** `~/.claude/plans/we-have-our-urvar-functional-jellyfish.md` (Phase 2 deliverable).
**Evidence:** `D:\vyapar-analysis.md` Parts 3–4. REA research on Vyapar 36.0.2 (Electron), in two forms:
- **static:** decoded string tables from `app.asar`
- **runtime:** six experiment rounds on a throwaway "REA Test Co" company, row-level DB diffs, and 17 exported report workbooks in `vyapar/rea-test-reports/` (gitignored)

**Rules for this document:**
- Urvar builds **its own implementation** of Vyapar's *behavior*. No Vyapar code is copied.
- Urvar's existing accounting rules stay in force (`CLAUDE.md`, `ACCOUNTING_POSTING_MATRIX.md`):
  - double-entry, posting only through `posting.ts`
  - no stored balances
  - reversals instead of deletes
  - `AccountMapping` keys, never hardcoded codes
  - `withRollback` tests
- Where Vyapar is single-entry or stores derived values, Urvar keeps its own stricter model and copies only the user-visible result.

Evidence labels used below: **[R]** observed at runtime, **[X]** read from an exported report, **[S]** static only (decoded constants; a licensed feature that couldn't be exercised).

---

## 1. Gap matrix

| # | Area | Vyapar behavior | Urvar today | Work |
|---|---|---|---|---|
| G1 | Bank account master | Bank = payment type with name, bank name, account no., IFSC, holder, UPI ID, opening balance + date; IFSC auto-fills bank & branch [R] | Bank = bare `LedgerAccount` under 1120 | **New `BankAccount` model** (§2.1) |
| G2 | Bank balance adjust (no cash side) | Types 17/18; posts to Owner's Equity → Adjustments → Bank Adjustment [R][X] | No equivalent (only BANK_CHARGE / INTEREST_INCOME) | **New movement types** (§2.2) |
| G3 | Cash add/reduce | Types 19/20; posts to Owner's Equity → Adjustments → Cash Adjustment [R][X] | `CASH_ADJUSTMENT` requires an expense account | **Default the offset to equity adjustments**, keep the option to pick an account (§2.2) |
| G4 | Cash↔bank, bank↔bank | Types 14/15/25 [R] | DEPOSIT / WITHDRAWAL / TRANSFER | ✅ Parity. Labels only |
| G5 | Cheques | Receipt/payment by cheque → status row; Deposit/Withdraw moves it to a bank on a date; default accounts Undeposited Cheques (asset) and Unwithdrawn Cheques (liability) [R][X] | Receipts post straight to cash/bank | **Cheque lifecycle + clearing accounts** (§2.3) |
| G6 | Split payment | `txn_payment_mapping` allows several payment methods per document [R] | One deposit account per receipt | **Spec decision D3** (deferred unless approved) |
| G7 | Loans | Starting balance (40), processing fee (41), EMI with principal/interest (43); charges and adjustments [R][S] | ✅ (2026-10-25) Loan + EMI split; fee/charges/top-up via `LoanTransaction` (§2.4) | — |
| G8 | Fixed assets | Buy/sell FA, opening FA, appreciate, depreciate [S] (license-locked) | ✅ Phase 9 (register, WDV depreciation, disposal) | Appreciation only if D5 = yes |
| G9 | Journal entry | Journal + line items, party paid/received [S] (license-locked) | ✅ Phase 9 manual journal + reverse | Journal Entry **report** only (R12) |
| G10 | Party balance sign | A customer in credit (advance) appears under **Sundry Creditors**, a supplier with a debit balance under **Sundry Debtors** [X] | Check `balanceSheet` / `allPartiesSummary` | **Verify and match** in R5/R9 |
| G11 | Bank reconciliation | Decoded `BANK_RECONCILIATION_*` / bank-linking constants [S]; **no reconcile UI** on the test company | ✅ (2026-10-26) `BankStatementLine` + `bank-reconciliation.ts` — Urvar-designed, no oracle to match (§4) | — |
| G12 | Reports | Approx. 100 report titles decoded; 17 exported | 25 report functions | **New reports in §3** |
| G13 | Export | Every report exports to Excel (main sheet + "Item Details" sheet) and prints [X] | ✅ (2026-10-26) `report-registry.ts` — all 32 reports, XLSX + PDF | — |
| G14 | GST data | HSN on item; per-line tax id; supplier GSTIN on party [R] | ✅ (2026-10-26) `PurchaseInvoiceItem.hsnCode`/tax fields (nullable), `PurchaseInvoice.supplierGstin`/`placeOfSupply`/`itcEligibility` (§2.5) | — |
| G15 | Stock | Perpetual quantity on item [R] | Periodic valuation (deliberate); stock in ERP DB | Stock reports **later phase** |

## 2. Business and posting rules (to be added to `ACCOUNTING_POSTING_MATRIX.md`)

### 2.1 Bank account master (G1)

- **New model `BankAccount`**, linked 1:1 to a postable `LedgerAccount`. Code allocated under `1120` via `nextChildCode`.
  - Fields: `displayName`, `bankName`, `branch`, `accountNumber`, `ifsc`, `accountHolderName`, `upiId`, `isOverdraft` (Vyapar `BANK_OD_AC` [S]), `openingBalance`, `openingDate`, `isActive`, `printOnInvoice`.
  - `Company` already carries bank details; decide in D2 whether `printOnInvoice` replaces them.
- **Opening balance** posts once (idempotency `BANK_OPENING:<id>:0`):
  - balance > 0: **Dr bank ledger / Cr `OPENING_BALANCE_EQUITY` (3300)**
  - overdraft (negative): the reverse
  - Vyapar keeps the opening figure on the account and shows "Difference in Opening Balance" on the Balance Sheet [X]. Urvar's 3300 is the equivalent.
- **IFSC lookup** (Vyapar auto-fills bank and branch [R]) is optional. See D1.
- `recordReceipt()` already restricts deposit accounts to 1110 / children of 1120. `BankAccount` must keep that true.

### 2.2 Cash and bank adjustments (G2, G3)

New `CashBankTxnType` values:

| Urvar type | Vyapar | Dr | Cr |
|---|---|---|---|
| `BANK_ADJ_INCREASE` | 17 | Bank | `CASH_BANK_ADJUSTMENT_EQUITY` (new mapping) |
| `BANK_ADJ_DECREASE` | 18 | `CASH_BANK_ADJUSTMENT_EQUITY` | Bank |
| `CASH_ADJUSTMENT` (existing), direction OVER/SHORTAGE | 19 / 20 | Cash / offset | offset / Cash |

- **New equity account** "Capital Adjustments" (3400, mapping `CASH_BANK_ADJUSTMENT_EQUITY`), with sub-accounts "Cash Adjustment" and "Bank Adjustment" so the Balance Sheet can mirror Vyapar's breakdown [X].
- `CASH_ADJUSTMENT` keeps its existing account picker. The **default offset** becomes the equity adjustment account. The existing `CASH_SHORT_OVER` (5800) stays selectable. **D4** decides the default.

### 2.3 Cheques (G5)

- **New model `Cheque`:** direction (`RECEIVED` / `ISSUED`), `chequeNumber`, `chequeDate`, `issuedDate`, amount, `partyType` + `partyId`, `sourceType` + `sourceId` (Receipt / SupplierPayment), `status`, `bankAccountId`, `transferDate`, `closeNote`.
- **Status flow:**
  - `RECEIVED` cheques: `OPEN` → `DEPOSITED`, or `OPEN` → `BOUNCED`
  - `ISSUED` cheques: `OPEN` → `CLEARED`, or `OPEN` → `CANCELLED`
  - Reopen = reverse the transfer entry.
- **New accounts and mappings:**
  - `UNDEPOSITED_CHEQUES`: current asset, e.g. 1115
  - `UNWITHDRAWN_CHEQUES`: current liability, e.g. 2165
  - These match Vyapar's default accounts [R].

| Event | Dr | Cr | Idempotency |
|---|---|---|---|
| Receipt by cheque (`PaymentMethod.CHEQUE`) | `UNDEPOSITED_CHEQUES` | AR (`AR_TRADE` / party) | existing receipt key |
| Cheque deposited | Bank | `UNDEPOSITED_CHEQUES` | `CHEQUE_DEPOSIT:<id>:<rev>` |
| Received cheque bounced | AR | `UNDEPOSITED_CHEQUES` (or Bank if already deposited) | `CHEQUE_BOUNCE:<id>:<rev>` |
| Supplier payment by cheque | AP (`AP_TRADE`) | `UNWITHDRAWN_CHEQUES` | existing payment key |
| Issued cheque cleared | `UNWITHDRAWN_CHEQUES` | Bank | `CHEQUE_CLEAR:<id>:<rev>` |

- Vyapar's Bank Statement shows the deposit as "[Cheque Deposit] Cust A" on the transfer date [X]. Urvar's bank report must do the same, from the deposit entry.
- Receipt `status` / invoice allocation is unchanged: the customer's debt is settled when the cheque is received, as in Vyapar. A bounce re-opens it.

### 2.4 Loans (G7)

| Event | Vyapar | Dr | Cr |
|---|---|---|---|
| Processing fee | 41 [R] | `LOAN_PROCESSING_FEE` (new expense mapping) | payment account |
| Loan charges | 42? [S] | `LOAN_CHARGES` (new expense mapping) | Loan account (added to debt) or payment account, per D6 |
| Top-up / increase | [S] | receiving account | Loan account |
| EMI | 43 [R] | Loan (principal) + `INTEREST_EXPENSE` (interest) | payment account |

- The EMI row already exists in Urvar. Fee, charges and top-up are new `LoanTransaction` rows (or extend `LoanRepayment` with a `kind`; decide in implementation), each posted through `posting.ts`.
- Vyapar's Expense Category report lists loan interest and processing fee as categories [X]. Urvar's `expenseCategoryReport` should include those ledger accounts.

### 2.5 GST data on purchases (G14)

- `PurchaseInvoiceItem`: add `hsnCode`, `taxRateId` (or rate), `taxableValue`, `cgst`/`sgst`/`igst`/`cess`, priced through `tax.ts` `priceLine` exactly as sales lines are.
- `PurchaseInvoice`: add `supplierGstin` (frozen from `Supplier.gstNumber` at posting), `placeOfSupply`, `isReverseCharge`, `itcEligibility` (`INPUTS` / `CAPITAL_GOODS` / `INPUT_SERVICES` / `INELIGIBLE`; Vyapar shows "Inputs" [X]).
- Existing blended-tax purchase invoices stay valid. The new fields are nullable, and returns mark old rows "line tax unavailable".
- Fix the sales **line discount** (always 0 today) so the discount reports and GSTR taxable values work.

## 3. Reports

Columns come from the exported Vyapar workbooks [X]. Every report takes a date range (the `date-filter-form.tsx` pattern), reads only through `financial-reports.ts`, and gets Excel and PDF export (§3.4).

### 3.1 New transaction reports

| ID | Report | Columns (Vyapar) | Source in Urvar |
|---|---|---|---|
| R1 | **Sale Report** ✅ | Date, Order No, Invoice No, Party Name, GSTIN, Party Phone, Transaction Type, Total Amount, Payment Type, Received Amount, Balance Due, Description, **one column per bank**; sheet 2 "Item Details" | `saleReport()` in `transaction-reports.ts` — SalesInvoice + ReceiptAllocation |
| R2 | **Purchase Report** ✅ | Same columns, with Paid in place of Received. No per-bank columns — the oracle export doesn't carry them for purchases either. | `purchaseReport()` — PurchaseInvoice + SupplierPaymentAllocation |
| R3 | **All Transactions** ✅ | Date, Reference No, Party Name, Category Name, Type, Total, Payment Type, Paid, Received, Balance, Description; sheet 2 "Item Details" | `allTransactionsReport()` — **scope corrected during step 2**: the exported oracle (`AllTransactionsReport_*.xlsx`) excludes pure cash/bank housekeeping (deposits, withdrawals, transfers, cash/bank adjustments, cheque deposit/withdraw) entirely — those are Day Book (R8) only. The "+ cash/bank/loan events" wording above was written before the oracle was captured; what's actually unioned is every sale, purchase, receipt, supplier payment, approved expense, loan disbursement and loan repayment. |
| R4 | **Sale/Purchase by Party** ✅ (by Party Group deferred) | Party, Sale total, Purchase total (per Vyapar menu) | `salePurchaseByParty()` — "by Party" only; "by Party Group" needs a party-group field (D7), not built |
| R5 | **Itemwise Transaction** ✅ | Item Details columns: Date, Invoice/Txn No, Party, Item, Item Code, HSN/SAC, Category, Challan/Order No, Qty, Unit, UnitPrice, Discount %, Discount, Tax %, Tax, Transaction Type, Amount | `itemwiseTransactionReport()` — Invoice/purchase/expense lines. HSN/Category come from the linked `Product` when a line has one (purchase lines have no HSN column of their own); a purchase line's Tax %/Tax are null (G14 — no per-line tax exists yet) |

### 3.2 Cash, bank, loan and journal reports

| ID | Report | Columns (Vyapar) | Notes |
|---|---|---|---|
| R6 | **Bank Statement** (per bank) | Date, Transaction Details, Withdrawal, Deposit, Balance, Description; Total row | Compare with the existing `bank-report`; labels follow Vyapar ("[Cash Withdraw]", "To SBI Test", "[Payment-In] Cust A", "[Cheque Deposit] …", "[EMI Paid] …") |
| R7 | **Cash in Hand statement** (Vyapar calls it "Cash Flow Report") | Date, Ref No, Name, Category, Type, Cash In, Cash Out, Running cash in hand, Description; Opening and Closing rows | Keep Urvar's `cashFlowSummary` as the real cash-flow statement; add this cash book alongside |
| R8 | **Day Book** ✅ (checked, not rebuilt) | Name, Ref No, Type, Payment Type, Total, Money In, Money Out, Description; Total and Net rows | `dayBookMoneyFlow()` wraps the existing `dayBook()` with Money In/Out — see the amendment below for the netting rule this forced |
| R9 | **Loan Statement** ✅ | Date, Type, Amount, Ending Balance; summary: Opening Balance, Balance Due, Total Principal Paid, Total Interest Paid | `loanStatement()` in `loans.ts`. Fee rows don't change the ending balance [X], confirmed exactly against `Loan Statement Report_*.xlsx` |
| R10 | **Loan Account Summary** ✅ | Per loan: lender, opening, paid principal and interest, balance | `loanAccountSummary()` in `loans.ts`. No single oracle export exists for this one; reuses `outstandingPrincipal`'s arithmetic, scoped "as of" a date |
| R11 | **Other Income** (overall / by category / by item) ✅ | Mirrors the Expense Category / Item reports | `otherIncomeCategoryReport()`/`otherIncomeItemReport()` in `financial-reports.ts`, backed by the new `OtherIncome`/`OtherIncomeItem` document — D8, step 6 |
| R12 | **Journal Entry report** ✅ | Date, Ref, Account, Debit, Credit, Narration | `journalEntryReport()` in `financial-reports.ts`. From `JournalEntry` where sourceType = MANUAL |

### 3.3 GST and tax reports (labelled **"for review, not for filing"** until the accountant signs off)

- **R13 GSTR-1** ✅ (`gstr1Report()`, `gstr-reports.ts`). Shipped: `GSTR1 Report` (main flat list), `b2b`, `b2cs`, `cdnr`, `cdnur`, `exemp` (zero-shell), `hsn(b2b)`, `hsn(b2c)`, `docs`. Not implemented — no data behind them, confirmed against the oracle itself: `b2cl` (large B2C, a dying provision), `exp` (exports), `at`/`atadj` (advances, not tracked separately from the invoice they're later applied to).
- **R14 GSTR-2** ✅. Shipped: `GSTR2 Report`, `b2b`, `b2bur`, `exemp`/`itcr` (zero-shell, matching the oracle's own all-zero shape), `hsnsum`. Only purchases on G14's line-priced path (every item has an HSN) contribute. Not implemented: `imps`/`impg` (imports), `at`/`atadj` (advance under reverse charge), `cdnr`/`cdnur` (returned empty — no `DebitNote` model exists yet, only the reserved enum value).
- **R15 GSTR-3B** ✅. Shipped: table 3.1 (a)/(d), (b)/(c)/(e) zero-shell; 3.2 (unregistered only — composition/UIN columns are always zero, not tracked); 4(A)(3)/(5), (D)(2) (4(A)(1)/(2)/(4) and 4(D)(1) are always zero — imports, ISD and *which* ineligibility rule applied aren't tracked); table 5 zero-shell.
- **R16 SAC Wise Summary** (services) — not applicable, consistent with `hsnSummary()`'s own existing comment: Urvar sells physical goods, not services. **GST Tax Rate Report** ✅ (`gstTaxRateReport()`).
- **R17 TCS/TDS** payable and receivable ✅ (`tdsTcsReport()`), **Form 27EQ out of scope** — D9, step 6. TDS is real: `Receipt`/`SupplierPayment` gained `tdsDeducted`, posted to the new `TDS_RECEIVABLE` (1145)/`TDS_PAYABLE` (2140, pre-existing) accounts, gated on `Company.tdsCaptureEnabled` (UI-only; the backend always accepts the field). TCS is stub accounts only (`TCS_RECEIVABLE` 1146, `TCS_PAYABLE` 2141) — nothing posts to them; see the step-6 amendment below for why.
- GSTR-4/9/9A, VAT 201 and Drug Schedule are **out of scope**.

### 3.4 Export (G13) ✅ shipped 2026-10-26 — see the step-4 amendment below

- **Generalise `src/app/api/reports/export`** into a registry: report id → `{ load(params), columns, itemDetails? }`.
- **Formats:**
  - **XLSX** via `exceljs`: sheet 1 = report, sheet 2 = "Item Details" where applicable, as in Vyapar.
  - **PDF** via `@react-pdf/renderer`.
- Permission checked per report module (`assertCan`).
- A filename pattern like Vyapar's: `<Report>_<dd_mm_yy>_to_<dd_mm_yy>.xlsx`.

### 3.5 Other added scope

- **Close Books** ✅ (2026-10-26) — see the step-7 amendment below for why no entry posts to 3200.
- **Custom Report** ✅ (2026-10-26) — `custom-report.ts`, see the step-7 amendment below.

## 4. Bank reconciliation (G11). Urvar design, not Vyapar parity

Vyapar's reconciliation is online bank linking with no visible UI on the test company. Urvar's approach:

- Upload a bank statement (CSV/XLSX).
- Map its columns once per bank. The mapping is stored on `BankAccount`.
- Statement lines are auto-matched to that bank's journal lines by amount + date window + reference (cheque number, UPI ref), then confirmed manually.
- A `BankStatementLine` stores the source row and `matchedJournalLineId`.
- Unmatched statement lines can create a `CashBankTransaction` (charges, interest) in one click.
- The reconciliation report shows book balance, statement balance and unmatched items on both sides.

## 5. Decisions needed

| # | Question | Owner | Default if not answered |
|---|---|---|---|
| D1 | IFSC → bank/branch lookup: public Razorpay IFSC API (online) or manual entry? | Management | Manual entry |
| D2 | Should `BankAccount.printOnInvoice` replace `Company` bank details? | Management | Yes |
| D3 | Split payment (one receipt across cash + bank + cheque)? | Management | Not now |
| D4 | Default offset for cash adjustments: Capital Adjustments (Vyapar) or Cash Short/Over 5800 (current Urvar)? | Accountant | Capital Adjustments, picker kept |
| D5 | Asset appreciation (revaluation) needed? | Accountant | No |
| D6 | Loan charges: added to loan balance or paid from cash/bank? | Accountant | Paid from account |
| D7 | Party groups for R4: new field on Customer/Supplier? | Management | Add `partyGroup` string |
| D8 | Other Income: new document type, or a manual journal to income accounts? | Accountant | New lightweight document — ✅ shipped step 6 (default taken) |
| D9 | TCS/TDS: does Urvar collect TCS on sales or deduct TDS on payments today? | Accountant | Build reports; capture behind a setting — ✅ shipped step 6 (default taken; TDS capture real, TCS stub-only) |
| D10 | GST open questions carried over from `ACCOUNTING_IMPLEMENTATION_PLAN.md` (GSTIN/state, HSN rates, e-invoice, reverse charge, Sec 17(5)) | Accountant | No legal-compliance claim; "for review" label |

## 6. Parity test oracle (Vitest, dev DB, `withRollback`)

Recreate the REA Test Co scenario in one test fixture:
1. 2 banks (50,000 and 20,000 opening); add cash 10,000.
2. Bank→cash 3,000; cash→bank 4,000; HDFC→SBI 5,000; bank +600 / −700; cash −800.
3. Receipt by cheque 1,500 (deposited to HDFC); receipt via HDFC 2,500; supplier cheque 900 (cleared from SBI).
4. Loan 1,00,000 into HDFC with processing fee 1,000 from cash; EMI 8,000 + 1,000 interest.
5. Sale 2 × 1,000 + 18% (1,000 received in HDFC); purchase 3 × 600 + 18% paid cash; expense Rent 350 cash.

Expected figures (from Vyapar's own exports [X]):

| Check | Expected |
|---|---|
| Cash | 4,726 |
| HDFC | 1,38,600 |
| SBI | 27,400 |
| Bank total | 1,66,000 |
| Test Loan | 92,000 |
| Customer advance (Sundry Creditors) | 2,640 |
| Supplier debit (Sundry Debtors) | 900 |
| Output GST | 360 |
| Input GST | 324 |
| Sale taxable value | 2,000 |
| Gross profit, with closing stock 600 | 800 |
| Net loss (Rent 350, loan interest 1,000, processing fee 1,000) | −1,550 |
| GSTR-3B 3.1(a) | taxable 2,000, CGST 180, SGST 180 |
| GSTR-3B 4(A)(5) | CGST 162, SGST 162 |

**Known intentional differences** (document them in the test, don't "fix" them):
- Urvar's closing stock comes from a periodic valuation, so the test must post a 600 valuation.
- Vyapar's P&L shows tax-inclusive Sale/Purchase lines with GST rows offsetting them; Urvar's P&L is net of tax. Gross profit must agree.
- Opening balances post to 3300 in Urvar, not a "Difference in Opening Balance" line.

## 7. Implementation order (Phase 3)

1. G1 bank accounts, G2/G3 adjustments, G5 cheques (with R6 and R7).
2. ✅ R1–R5 transaction reports; R8 Day Book check (2026-10-25 — see the amendment below).
3. ✅ G7 loans, R9/R10; R12 journal report (2026-10-25 — see the amendment below).
4. ✅ §3.4 export registry, retrofitted onto all existing and new reports (2026-10-26 — see the amendment below).
5. ✅ G14 purchase GST data, then R13–R16 (GSTR-1/2/3B, SAC, tax rate) — 2026-10-26, see the amendment below.
6. ✅ R17 TCS/TDS (after D9); R11 other income (after D8) — 2026-10-26, see the amendment below.
7. ✅ §4 bank reconciliation; §3.5 Close Books and Custom Report — 2026-10-26, see the amendment below.
8. Later phase: stock reports, after the ERP postgres_fdw link.

Each step: a migration on dev (`npm run db:dev:migrate`), posting-matrix update, tests, `npx tsc --noEmit`, `npx eslint`.

---

## Amendment 2026-10-25: cheque states (supersedes the status flow in §2.3)

REA round 7 showed that Vyapar has only **open** and **transferred** (deposited/withdrawn), plus **Reopen**. No close or bounce exists in its UI. As built (`src/lib/accounting/cheques.ts`):
- **States:** `ChequeStatus` = OPEN, DEPOSITED, CLEARED, CANCELLED.
- **No BOUNCED state:** a bounced cheque is reopened, then its receipt is cancelled. That re-opens the invoice.
- **CANCELLED** means the cheque's receipt or payment was cancelled while the cheque was OPEN.
- **Cancellation of a deposited or cleared cheque's document** is refused until the cheque is reopened.

## Amendment 2026-10-25 (step 2): R1–R5 shipped; R8's Money In/Out netting rule; two structural differences confirmed by the oracle

**Shipped:** `src/lib/accounting/transaction-reports.ts` (`saleReport`, `purchaseReport`, `allTransactionsReport`, `itemwiseTransactionReport`, `salePurchaseByParty`), report pages under `accounting/reports/{sale-report,purchase-report,all-transactions,itemwise-transaction,sale-purchase-by-party}`, `dayBookMoneyFlow()` in `financial-reports.ts` (wraps `dayBook()` with Vyapar's Money In/Out columns, now shown on the Day Book page), and `tests/vyapar-parity.test.ts` — a Vitest fixture recreating the REA Test Co scenario (§6) against the dev DB, checked against the exported oracle workbooks.

**The Day Book's Money In/Out must be netted per entry, not summed per side.** The first implementation summed every cash-like line's debits into Money In and every cash-like line's credits into Money Out independently. For a pure transfer between two cash-like accounts (a deposit, withdrawal, bank-to-bank transfer, or a cheque clearing — both its lines are cash-like) this produced equal non-zero Money In *and* Money Out, where the oracle (`Daybook_*.xlsx`) shows literal `0`/`0`. The fix: net the cash-like lines first (`Σdebit − Σcredit`), then the net amount becomes Money In when positive, Money Out when negative — a transfer's net is always zero because both its legs are cash-like and cancel; a `BANK_ADJ_INCREASE`/`CASH_ADJUSTMENT`/receipt/loan-disbursement/loan-repayment entry nets to a genuine one-sided figure because only one of its two lines is cash-like. The test (`tests/vyapar-parity.test.ts`, "R8 Day Book check") locks this in per movement type.

**Two structural differences the oracle made unambiguous (both already documented at the top of `transaction-reports.ts`), confirmed by building the actual fixture rather than reading the spec in the abstract:**
1. A `SalesInvoice`/`PurchaseInvoice` never carries a payment — Vyapar's single-entry Sale/Purchase document can, and its Day Book/All Transactions rows show a non-zero Money In/Out or Payment Type directly on that one row. In Urvar the same money shows up as a *separate*, independently dated `Receipt`/`SupplierPayment` document — so where the fixture's oracle-equivalent scenario has 2 Payment-In and 1 Payment-Out rows, Urvar's `allTransactionsReport` correctly has 3 and 2 (the extra one is the payment that happens to be allocated to an invoice created the same day) — not a bug, the aggregate totals (received, paid, balance) agree exactly.
2. `allTransactionsReport`'s Payment Type column is **frozen as recorded**, not re-resolved against a cheque's later clearing state — `"Cheque (111111)"` stays that label even after the cheque deposits, matching the oracle (which is generated once from Vyapar's `txn_payment_mapping` at document creation and never rewritten). `saleReport`/`purchaseReport`'s per-bank breakdown, by contrast, *does* re-resolve a cleared cheque to its eventual bank — a deliberately different, invoice-centric view with no oracle row to contradict it.

## Amendment 2026-10-25 (step 3): G7 loan fee/charges/top-up; R9/R10/R12 shipped

**Schema:** `LoanTransaction` (new model, migration `20261025140000_loan_transactions`, applied to dev) + `LoanTransactionType` enum (`PROCESSING_FEE`, `CHARGES`, `TOP_UP`) + `JournalSourceType.LOAN_TRANSACTION`. Deliberately a separate model from `LoanRepayment` rather than a `kind` column on it — a fee/charge has no principal/interest split, and a top-up moves money the *opposite* direction (into the loan account, like the disbursement), neither of which fits `LoanRepayment`'s shape. Two new expense accounts: 5720 Loan Processing Fee, 5730 Loan Charges (under 5700 Finance Costs, alongside 5710 Interest Expense), with new `AccountMapping` keys `LOAN_PROCESSING_FEE`/`LOAN_CHARGES`.

**`src/lib/accounting/loans.ts`:** `recordLoanFee()` (PROCESSING_FEE or CHARGES — Dr the matching expense account, Cr the payment account, never touching the loan balance, per decision D6's default), `recordLoanTopUp()` (same shape as the disbursement — Dr the receiving account, Cr the loan account), `cancelLoanTransaction()` (reversal, mirrors `cancelLoanRepayment`). `outstandingPrincipal()` now also sums non-cancelled `TOP_UP` amounts into the balance — backward compatible, since a loan with no top-ups sums zero.

**R9 Loan Statement and R10 Loan Account Summary**, also in `loans.ts`. R9 was checked directly against `vyapar/rea-test-reports/Loan Statement Report_01_10_26_to_25_10_26.xlsx` — the oracle's exact shape (Date/Type/Amount/Ending Balance rows, with a fee row leaving the balance unchanged) and exact summary figures (Opening Balance 100000, Balance Due 92000, Total Principal Paid 8000, Total Interest Paid 1000) matched on the first attempt once `LoanTransaction` existed to drive it. R10 has no oracle export to check against (none of the 17 captured workbooks is a cross-loan summary) and reuses the same balance arithmetic, scoped "as of" a date instead of "now".

**R12 Journal Entry Report**, added to `financial-reports.ts` — the one report scoped to `sourceType: "MANUAL"` on purpose, since every other posting already has its own document-shaped report.

**`allTransactionsReport()` (R3) updated**: a `LoanTransaction` now contributes its own row — "Processing Fee"/"Charges" (shown as `paid`) or "Top-up" (shown as `received`) — replacing the test fixture's earlier workaround of modelling the loan processing fee as a plain `Expense` (documented in step 2's amendment above; that workaround is now resolved, not a permanent gap).

**UI:** the loan detail page (`/accounting/loans/[loanId]`) gained a fee/charge form, a top-up form, a combined history table with cancel, and a "Statement" link to R9; the Reports index gained Loan Statement, Loan Account Summary and Journal Entry Report under Transaction Report.

9 new tests (`tests/loans.test.ts`) plus 3 new `tests/vyapar-parity.test.ts` describe blocks (R9, R10, R12) — 325 total passing, `tsc --noEmit` and `eslint` clean.

## Amendment 2026-10-26 (step 4): the export registry (G13), shipped for all 32 reports

**Shipped:** `src/lib/accounting/report-registry.ts` (`REPORT_REGISTRY`, `vyaparFilename()`), `src/lib/pdf/report-pdf.tsx` (one shared tabular PDF template), `src/app/api/accounting/reports/export/route.ts`, `src/components/accounting/export-links.tsx`, and `tests/report-registry.test.ts`. Every one of the 32 accounting report pages (all of §3.1/§3.2's R1–R12 plus the 20 pre-existing Phase 5/7/8 reports) now has an "Export Excel" / "Export PDF" link next to its date filter.

**One deliberate simplification of the spec's recipe.** §3.4 asks for "report id -> `{ load(params), columns, itemDetails? }`". This implementation drops the separate `columns` field: a sheet's columns are always `Object.keys(rows[0])`, the same thing the pre-existing CRM export route (`/api/reports/export`, leads/orders/quotations) already did — there is no reason to hand-list column headers a second time next to code that already names every field in the row object it builds. `itemDetails` likewise becomes "a second `ReportSheet`" rather than a special case: R1/R2/R3 just return two sheets (`[main, "Item Details"]`) instead of one; R9's summary rows and `gst`'s two-report combination (tax summary + outward register) use the same mechanism.

**Permission check**: the new route checks `can(user.role, "accounting", "read")`, matching every report page's own `assertCan`, and is deliberately a separate route from `/api/reports/export` (CRM, gated on the `reports` module) rather than a shared one with a branch for "which permission to check."

**Filename convention**: `vyaparFilename()` reproduces Vyapar's own pattern exactly — `SaleReport_01_10_26_to_31_10_26.xlsx` for a range, `TrialBalance_25_10_26.xlsx` for an as-of date — confirmed against the oracle filenames already sitting in `vyapar/rea-test-reports/`.

**PDF scope**: one shared landscape, auto-width table template renders whichever sheet would be sheet 1 of the XLSX. A report with an Item Details second sheet (R1/R2/R3) prints only the first — multi-sheet output is what a spreadsheet is for, and building 30+ bespoke PDF layouts to match Vyapar's own print formats isn't proportionate to what this project needs from PDF export.

**Verification**: every registered report's `load()` was run against the dev DB via a throwaway script (deleted afterward) before writing permanent tests — all 32 resolved without error, and `renderReportPdf()` was confirmed to produce a real PDF (`%PDF` header) in isolation. `tests/report-registry.test.ts` then locked in the parts worth asserting: the filename convention, row-flattening into plain numbers/strings for day-book/sale-report/ar-ageing/loan-statement/party-statement/ledger/gst/cash-bank-assets, and a blanket "every range/asOf-only report still loads" sweep. 338 tests pass total, `tsc --noEmit` and `eslint` clean across the repo.

## Amendment 2026-10-26 (step 5): G14 purchase GST data; R13–R16 shipped

**Schema (G14):** `PurchaseInvoiceItem` gained `hsnCode`, `taxRatePercent`, `taxableValue`, `cgstAmount`, `sgstAmount`, `igstAmount`, `cessAmount` — all nullable, since an existing OCR-captured line has none and a return built from one must show "unavailable" rather than a false zero. `PurchaseInvoice` gained `supplierGstin`/`placeOfSupply` (frozen at posting, same moment `isInterState` is decided — mirrors `SalesInvoice.customerGstin`'s convention exactly), `cessAmount`, `isReverseCharge`, and `itcEligibility` (new `ItcEligibility` enum: INPUTS/CAPITAL_GOODS/INPUT_SERVICES/INELIGIBLE — header-level, not per-line; the spec research never found Vyapar varying it within one invoice). Migration `20261026090000_purchase_gst_data`, applied to dev only.

**`purchase-posting.ts` gained a second posting path.** When every line on an invoice has an `hsnCode` (entered by hand at intake — Sarvam OCR extracts none), tax is resolved and split line-by-line exactly the way `invoicing.ts` prices a sales line, and that line-summed figure *overrides* the invoice's header subtotal/tax/total — more accurate than the OCR-read figure, the same "lines are the source of truth, the header is derived" rule the sales side already follows, and safe because nothing can have been paid against a still-DRAFT invoice. When even one line lacks an `hsnCode`, the original header-blended split runs completely unchanged — there is no partial mix of the two paths on one invoice, and every invoice captured before this shipped keeps posting exactly as it always did (confirmed: all pre-existing purchase-posting/payables/supplier-payment/fixed-assets/financial-reports tests pass unmodified).

**Intake UI** (`purchases/new/invoice-intake.tsx`): an optional HSN input per line, and an ITC-eligibility select + reverse-charge checkbox on the header, defaulting to the common case (Inputs, forward charge) — same "everything editable, nothing write-through" posture the rest of the form already has. The detail page shows HSN/per-line tax and the new header fields once posted.

**One item from §2.5 deliberately not done: "fix the sales line discount (always 0 today)".** `SalesInvoiceItem.discountPercent` is hardcoded `0` at invoice creation (`invoicing.ts`) because `OrderItem` has no discount column of its own — `orderItemsFromQuotation()` folds a quotation line's discount into a lower `unitPrice` instead, which is a *deliberate, already-shipped, regression-tested* design (the QT-2026-0004/ORD-2026-0138 fix, `tests/order-from-quotation.test.ts`'s "folds a line discount into the unit price" test). Reversing it to restore a real `discountPercent` would relitigate that fix for a reporting-display gap, not a correctness bug — the taxable value is already right (it's computed from the already-discounted price, which is exactly what GST taxes). Left for `itemWiseDiscount`/`discountReport` to keep showing 0% on a quotation-sourced invoice until someone explicitly decides the tradeoff is worth it.

**R13/R14/R15 (`gstr-reports.ts`)** were shaped against real Vyapar exports, not the GST portal's documentation — `vyapar/rea-test-reports/GSTR{1,2,3B} Report_10_26_to_10_26.xlsx` — and every figure in the single-sale/single-purchase oracle scenario was reproduced exactly (taxable 2000/1800, CGST+SGST 180/180 and 162/162, HSN quantity 2/3, "Inputs" eligibility carrying the full tax into Availed ITC) via a scratch fixture before `tests/gstr-reports.test.ts` was written. One real bug this caught before it shipped: `gstOutwardSupplyRegister()`'s `OutwardSupplyRow` never exposed line `quantity` (the query already fetched it; nothing read it), so GSTR-1's `hsn(b2c)` sheet showed `"Total Quantity": 0` against the oracle's `2` — fixed by adding the field, which `hsnSummary()` (the only other caller) doesn't read and is unaffected by.

**R16**: SAC Wise Summary is not applicable — Urvar sells physical goods, not services, the same conclusion `hsnSummary()`'s own pre-existing comment already reached. GST Tax Rate Report ships instead, listing every `TaxRate` row and its verification status.

**All four wired into the step-4 export registry** (`gstr1`/`gstr2`/`gstr3b`/`gst-tax-rate`), new pages under `/accounting/reports/{gstr1,gstr2,gstr3b,gst-tax-rate}`, each rendered through a new shared `<SheetTable>` component (one table per sheet, columns derived the same way the XLSX export derives them).

16 new tests (3 in `purchase-posting.test.ts`, 13 in `gstr-reports.test.ts`). 354 tests pass total. `tsc --noEmit` and `eslint` clean.

## Amendment 2026-10-26 (step 6): R11 Other Income + D8; R17 TCS/TDS + D9 shipped

**D8/R11 — Other Income, both defaults taken.** New `OtherIncome`/`OtherIncomeItem` models and `OtherIncomeStatus` enum (DRAFT/SUBMITTED/APPROVED/REJECTED/CANCELLED), mirroring `Expense`/`ExpenseItem` field-for-field with every Dr/Cr reversed: money comes IN (`depositAccountId`, not `paymentAccountId`), and `categoryAccountId` must resolve to a postable `INCOME`-typed account (the pre-existing `4900 Other Income` leaf qualifies — no new chart-of-accounts entry needed). There is deliberately no `claimInputCredit`-equivalent toggle: any GST an Other Income entry carries is output tax Urvar now owes (`GST_OUTPUT_CGST/SGST/IGST`), never a choice, because a seller doesn't get to decide not to recognise tax it collected. Lifecycle, self-approval rule (`canSelfApprove`), and round-off sign convention (credits Round Off on rounding up — the mirror image of `expenses.ts`, which debits it) all match `expenses.ts` exactly; see `src/lib/accounting/other-income.ts`.

Full module shipped: `other-income/{page.tsx,actions.ts,new/{page.tsx,new-other-income-form.tsx},[incomeId]/{page.tsx,other-income-actions.tsx}}`, `otherIncome` added to the `Module` permissions matrix (mirrors `expenses`' access for all 5 roles), nav entry added. **Scope cut deliberately taken to control cost:** the "new entry" form is flat-amount-only — no itemised-lines UI toggle, no attachment upload (Other Income entries are miscellaneous and infrequent; there's no OCR intake to speak of, unlike a supplier bill or expense receipt). `createOtherIncome()` itself fully supports itemised GST-priced lines (needed for the GSTR reports below) — that path is reachable via the server action/tests today, just not this simple form.

Two reports, mirroring `expenseCategoryReport()`/`expenseItemReport()` exactly: `otherIncomeCategoryReport()`, `otherIncomeItemReport()` in `financial-reports.ts`, wired into the step-4 export registry as `other-income-category-report`/`other-income-item-report`, with report pages reusing the `expense-category-report`/`expense-item-report` page pattern verbatim.

**D9/R17 — TCS/TDS, default taken, with TDS real and TCS deliberately stub-only.** Two new accounts (`1145 TDS Receivable`, `1146 TCS Receivable`) alongside the pre-existing `2140 TDS Payable`, plus one new liability (`2141 TCS Payable`) — all four wired into `AccountMapping` (`TDS_RECEIVABLE`/`TCS_RECEIVABLE`/`TDS_PAYABLE`/`TCS_PAYABLE`).

TDS is a real, additive extension to the two already-tested payment-posting functions: `Receipt`/`SupplierPayment` each gained a `tdsDeducted` column (default 0), and `recordReceipt()`/`recordSupplierPayment()` each gained a `tdsDeducted` input. The allocation cap becomes `amount + tdsDeducted` rather than `amount` alone — a customer who pays ₹1,000 cash and withholds ₹50 TDS still fully settles a ₹1,050 invoice — and a non-zero `tdsDeducted` posts one extra balanced line (`TDS_RECEIVABLE` debit on the receipt side, `TDS_PAYABLE` credit on the payment side). Entirely backward compatible: `tdsDeducted` defaults to 0, and the full existing 354-test suite passed unchanged before any new TDS test was added. Gated end-to-end by a new `Company.tdsCaptureEnabled` boolean (default `false`) — pure UI gate: the backend accepts `tdsDeducted` regardless, so flipping the flag is a data change, not a deploy. The Receipt and Supplier Payment "new" forms show the field only when the flag is on, folding it into their client-side allocation/advance math the same way the server does.

TCS (Section 206C(1H)) is intentionally **not** implemented beyond the two stub accounts — materially higher uncertainty than TDS-on-payments: it's turnover-threshold-gated, needs buyer-wise cumulative tracking Urvar doesn't do, and (unlike TDS, which slots into two already-existing posting functions) would need a new collection point on the sales side with no natural home yet. `tdsTcsReport()` in `financial-reports.ts` reports all four accounts' balances "for review" regardless — TCS simply shows zero until something posts to it — wired into the export registry as `tds-tcs-report`.

Migration `20261026110000_other_income_tds_tcs`, applied to dev only (schema.prisma edited → `prisma migrate status` confirmed no drift → `prisma migrate diff --from-config-datasource` → read, confirmed no `DROP`/`TRUNCATE` → `db:dev:migrate` → `db:generate`). `db:dev:seed-accounting` installed the 3 new accounts and 4 new mappings (84 accounts, 38/38 mappings present).

24 new tests (16 in `other-income.test.ts`, 4 each in `receipts.test.ts`/`supplier-payments.test.ts` for TDS capture) plus the 3 new report-registry entries (`report-registry.test.ts`'s hardcoded count bumped 36 → 39). 378 tests pass total. `tsc --noEmit` and `eslint` clean.

## Amendment 2026-10-26 (step 7): bank reconciliation (§4), Close Books and Custom Report (§3.5) shipped

**G11 — Bank reconciliation, Urvar's own design (no Vyapar oracle exists).** New `BankStatementLine` model (migration `20261026120000_bank_reconciliation_and_custom_reports`, applied to dev only) + `BankStatementLineStatus` enum (UNMATCHED/MATCHED/IGNORED), plus `BankAccount.statementColumnMap` (Json, the per-bank column mapping so a second import skips the mapping step). `matchedJournalLineId` is `@unique` — the database itself, not just application code, refuses to let two statement lines settle the same journal line.

`src/lib/accounting/bank-reconciliation.ts` never posts anything; it only links rows that already happened. `importBankStatement()` creates one `importBatch` (a `randomUUID()`, not a separate parent model — there is nothing else to say about a batch beyond "these rows arrived together") and immediately runs `autoMatchBankAccount()`: a single deterministic pass matching by exact amount (debit for a deposit line, credit for a withdrawal line) within a 5-day date window, picking the closest date among untaken candidates. `matchStatementLine()`/`unmatchStatementLine()` are the manual override; `ignoreStatementLine()`/`restoreStatementLine()` handle a duplicate or bank-error row that should never match anything; `deleteStatementImport()` undoes a bad upload but refuses once any of its lines is matched (unmatch first). `createTransactionFromStatementLine()` is "unmatched statement lines can create a `CashBankTransaction` in one click" — it calls the existing `createCashBankTransaction()` (never duplicates its posting logic) for a `BANK_CHARGE`/`INTEREST_INCOME` and matches the resulting journal line in the same transaction. `reconciliationSummary()` reports the standard reconciliation-statement shape: book balance, each side's unmatched deposits/withdrawals, and (when the user types in the statement's own closing figure — never stored, since Urvar has no concept of a "closing balance" field to store) the two adjusted balances that should agree once reconciliation is complete.

UI: `/accounting/bank-reconciliation` (bank picker with unmatched counts) → `/accounting/bank-reconciliation/[bankAccountId]` (upload, column-mapping, summary, match tables, import history). The upload flow mirrors the leads importer's two-step shape — `POST /api/accounting/bank-reconciliation/parse` (reusing the existing `parseSpreadsheetFile()`, gated on `accounting` write instead of the leads bulk-import permission) returns headers once so the mapping UI can be drawn, then `importBankStatementRowsAction()` takes the already-parsed JSON rows rather than re-uploading the file.

**Close Books, deliberately not a Vyapar-style closing entry.** `closeBooks(financialYear)` (`accounting/actions.ts`) locks every period of a financial year in one Super-Admin action, refusing if any period is still OPEN (every period must be reviewed and closed first) — a batch convenience over the pre-existing per-period `lockPeriod()`, not new posting machinery. It deliberately does **not** post a journal entry moving the year's net profit into Retained Earnings (3200), unlike Vyapar's own year-end close: `balanceSheet()`'s own docstring already documents that "Current Earnings" is computed as cumulative Income − Expenses since inception, exactly the plug a closing entry would otherwise produce — and physically zeroing every INCOME/EXPENSE account for the year would corrupt `profitAndLoss()` for a date range inside that same year (the zeroing entry's own lines are typed INCOME/EXPENSE and would sum into any later query spanning its date). This is the "Vyapar is single-entry and stores a derived value; Urvar's stricter model copies only the user-visible result" rule from this document's own header, applied: the Periods page now shows each FY's net profit (computed live via `profitAndLoss()`, the same function the P&L report uses) next to the Close Books button, so the reviewable-and-sealed result Vyapar's close produces is matched without a posting that would fight the rest of this system's design.

**Custom Report (§3.5) — a thin filter/projection over `allTransactionsReport()` (R3), never a parallel query.** `custom-report.ts`'s `CUSTOM_REPORT_COLUMNS` mirrors R3's own row shape (Date/Reference No/Party Name/Category Name/Type/Total/Payment Type/Paid/Received/Balance/Description) exactly, so a custom report can never disagree with the All Transactions Report it's built from. `runCustomReport()` filters by transaction type, a case-insensitive party-name substring, and a min/max total, then projects only the requested columns. `CustomReportDefinition` (new model, same migration) stores one user's named column/filter pick — "saved definitions per user", enforced in `deleteCustomReportDefinition()` by checking `createdById` rather than trusting the caller. Wired into the step-4 export registry as `custom-report` (`needs: ["range", "custom"]`, a new `ReportParams.custom` field carrying columns/types/partyContains/minAmount/maxAmount through the query string) so it gets the same Excel/PDF export every other report has, with no special-casing in the export route beyond parsing the extra params.

13 new tests (9 in `bank-reconciliation.test.ts`, 4 in `custom-report.test.ts`) plus the new registry entry (`report-registry.test.ts`'s hardcoded count bumped 39 → 40; its generic "every report loads" sweep now also skips the `"custom"` need, the same way it already skips `accountId`/`partyId`/etc.). Every bank-reconciliation test creates its own brand-new bank ledger via `createBankAccount()` with no `existingLedgerAccountId` rather than reusing the shared seeded 1121/1122 — a fresh account has no history, so balance assertions never depend on what else happens to be in the dev DB. 391 tests pass total. `tsc --noEmit` and `eslint` clean across the repo.

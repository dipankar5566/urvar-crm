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
| G7 | Loans | Starting balance (40), processing fee (41), EMI with principal/interest (43); charges and adjustments [R][S] | Loan + EMI split ✅; no fee, charges or top-up | **Add fee / charges / top-up** (§2.4) |
| G8 | Fixed assets | Buy/sell FA, opening FA, appreciate, depreciate [S] (license-locked) | ✅ Phase 9 (register, WDV depreciation, disposal) | Appreciation only if D5 = yes |
| G9 | Journal entry | Journal + line items, party paid/received [S] (license-locked) | ✅ Phase 9 manual journal + reverse | Journal Entry **report** only (R12) |
| G10 | Party balance sign | A customer in credit (advance) appears under **Sundry Creditors**, a supplier with a debit balance under **Sundry Debtors** [X] | Check `balanceSheet` / `allPartiesSummary` | **Verify and match** in R5/R9 |
| G11 | Bank reconciliation | Decoded `BANK_RECONCILIATION_*` / bank-linking constants [S]; **no reconcile UI** on the test company | None | **Urvar-designed statement import + match** (§4) |
| G12 | Reports | Approx. 100 report titles decoded; 17 exported | 25 report functions | **New reports in §3** |
| G13 | Export | Every report exports to Excel (main sheet + "Item Details" sheet) and prints [X] | Financial reports: no export | **Export registry** (§3.4) |
| G14 | GST data | HSN on item; per-line tax id; supplier GSTIN on party [R] | Purchase lines have no HSN or per-line tax; no supplier GSTIN on invoice | **Schema additions** (§2.5) |
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
| R1 | **Sale Report** | Date, Order No, Invoice No, Party Name, GSTIN, Party Phone, Transaction Type, Total Amount, Payment Type, Received Amount, Balance Due, Description, **one column per bank**; sheet 2 "Item Details" | SalesInvoice + allocations |
| R2 | **Purchase Report** | Same columns, with Paid in place of Received | PurchaseInvoice + SupplierPaymentAllocation |
| R3 | **All Transactions** | Date, Reference No, Party Name, Category Name, Type, Total, Payment Type, Paid, Received, Balance, Description; sheet 2 "Item Details" | Union of every posted document + cash/bank/loan events |
| R4 | **Sale/Purchase by Party** and **by Party Group** | Party, Sale total, Purchase total (per Vyapar menu) | Needs a party-group field (D7) |
| R5 | **Itemwise Transaction** | Item Details columns: Date, Invoice/Txn No, Party, Item, Item Code, HSN/SAC, Category, Challan/Order No, Qty, Unit, UnitPrice, Discount %, Discount, Tax %, Tax, Transaction Type, Amount | Invoice/purchase lines |

### 3.2 Cash, bank, loan and journal reports

| ID | Report | Columns (Vyapar) | Notes |
|---|---|---|---|
| R6 | **Bank Statement** (per bank) | Date, Transaction Details, Withdrawal, Deposit, Balance, Description; Total row | Compare with the existing `bank-report`; labels follow Vyapar ("[Cash Withdraw]", "To SBI Test", "[Payment-In] Cust A", "[Cheque Deposit] …", "[EMI Paid] …") |
| R7 | **Cash in Hand statement** (Vyapar calls it "Cash Flow Report") | Date, Ref No, Name, Category, Type, Cash In, Cash Out, Running cash in hand, Description; Opening and Closing rows | Keep Urvar's `cashFlowSummary` as the real cash-flow statement; add this cash book alongside |
| R8 | **Day Book** | Name, Ref No, Type, Payment Type, Total, Money In, Money Out, Description; Total and Net rows | Internal transfers show Money In/Out = 0 [X]. Check the existing `dayBook` |
| R9 | **Loan Statement** | Date, Type, Amount, Ending Balance; summary: Opening Balance, Balance Due, Total Principal Paid, Total Interest Paid | Fee rows don't change the ending balance [X] |
| R10 | **Loan Account Summary** | Per loan: lender, opening, paid principal and interest, balance | |
| R11 | **Other Income** (overall / by category / by item) | Mirrors the Expense Category / Item reports | Needs an Other Income document or posting; D8 |
| R12 | **Journal Entry report** | Date, Ref, Account, Debit, Credit, Narration | From `JournalEntry` where sourceType = MANUAL |

### 3.3 GST and tax reports (labelled **"for review, not for filing"** until the accountant signs off)

- **R13 GSTR-1.** Sheets matching the GST offline-tool sections [X]: summary, `b2b,sez,de`, `b2cl`, `b2cs` (Type OE, Place of Supply, Rate, Taxable Value, Cess), `cdnr`, `cdnur`, `exp`, `at`, `atadj`, `exemp`, `hsn(b2b)`, `hsn(b2c)` (HSN, Description, UQC, Total Qty, Total Value, Rate, Taxable, IGST, CGST, SGST, Cess), `docs` (document serial ranges and cancelled count, which `DocumentSeries` can supply).
- **R14 GSTR-2.** Sheets: `b2b`, `b2bur`, `imps`, `impg`, `cdnr`, `cdnur`, `at`, `atadj`, `exemp`, `itcr`, `hsnsum`, with ITC eligibility and availed columns.
- **R15 GSTR-3B.** Table 3.1 (a)–(e); 3.2 (inter-state supplies to unregistered / composition / UIN holders); 4 (A)(1)–(5) ITC available, (D) ineligible incl. Sec 17(5); 5 (exempt / nil / non-GST inward).
- **R16 SAC Wise Summary** (services). **GST Tax Rate Report.**
- **R17 TCS/TDS** payable and receivable, and **Form 27EQ.** These need TCS capture on sales and TDS on payments. Urvar has `TDS Payable` (2140) but no TCS accounts; add TCS Payable/Receivable and TDS Receivable, matching Vyapar's default `other_accounts` [R].
- GSTR-4/9/9A, VAT 201 and Drug Schedule are **out of scope**.

### 3.4 Export (G13)

- **Generalise `src/app/api/reports/export`** into a registry: report id → `{ load(params), columns, itemDetails? }`.
- **Formats:**
  - **XLSX** via `exceljs`: sheet 1 = report, sheet 2 = "Item Details" where applicable, as in Vyapar.
  - **PDF** via `@react-pdf/renderer`.
- Permission checked per report module (`assertCan`).
- A filename pattern like Vyapar's: `<Report>_<dd_mm_yy>_to_<dd_mm_yy>.xlsx`.

### 3.5 Other added scope

- **Close Books.** Year-end close: lock the FY's periods (existing `FinancialPeriod` LOCKED), carry net income to Retained Earnings (3200), and optionally archive. Vyapar: `LinkedTransactionManager.closeBook`, `TXN_TYPE_LOAN_CLOSE_BOOK_ADJ` [S].
- **Custom Report.** A user picks columns and filters over R3's dataset. Saved definitions per user.

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
| D8 | Other Income: new document type, or a manual journal to income accounts? | Accountant | New lightweight document |
| D9 | TCS/TDS: does Urvar collect TCS on sales or deduct TDS on payments today? | Accountant | Build reports; capture behind a setting |
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
2. R1–R5 transaction reports; R8 Day Book check.
3. G7 loans, R9/R10; R12 journal report.
4. §3.4 export registry (retrofit all existing and new reports).
5. G14 purchase GST data, then R13–R16 (GSTR-1/2/3B, SAC, tax rate).
6. R17 TCS/TDS (after D9); R11 other income (after D8).
7. §4 bank reconciliation; §3.5 Close Books and Custom Report.
8. Later phase: stock reports, after the ERP postgres_fdw link.

Each step: a migration on dev (`npm run db:dev:migrate`), posting-matrix update, tests, `npx tsc --noEmit`, `npx eslint`.

---

## Amendment 2026-10-25: cheque states (supersedes the status flow in §2.3)

REA round 7 showed that Vyapar has only **open** and **transferred** (deposited/withdrawn), plus **Reopen**. No close or bounce exists in its UI. As built (`src/lib/accounting/cheques.ts`):
- **States:** `ChequeStatus` = OPEN, DEPOSITED, CLEARED, CANCELLED.
- **No BOUNCED state:** a bounced cheque is reopened, then its receipt is cancelled. That re-opens the invoice.
- **CANCELLED** means the cheque's receipt or payment was cancelled while the cheque was OPEN.
- **Cancellation of a deposited or cleared cheque's document** is refused until the cheque is reopened.

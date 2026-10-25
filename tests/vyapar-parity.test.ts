import { describe, it, expect } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createBankAccount } from "@/lib/accounting/bank-accounts";
import { createCashBankTransaction } from "@/lib/accounting/cash-bank";
import { recordReceipt } from "@/lib/accounting/receipts";
import { recordSupplierPayment } from "@/lib/accounting/supplier-payments";
import { transferCheque } from "@/lib/accounting/cheques";
import { createLoan, recordLoanFee, recordLoanRepayment } from "@/lib/accounting/loans";
import { createExpense, approveExpense } from "@/lib/accounting/expenses";
import { createInvoiceFromOrder } from "@/lib/accounting/invoicing";
import { postPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import { dayBookMoneyFlow, journalEntryReport } from "@/lib/accounting/financial-reports";
import { postJournalEntry } from "@/lib/accounting/posting";
import { loanStatement, loanAccountSummary } from "@/lib/accounting/loans";
import {
  saleReport,
  purchaseReport,
  allTransactionsReport,
  itemwiseTransactionReport,
  salePurchaseByParty,
} from "@/lib/accounting/transaction-reports";
import { money, toAmountString } from "@/lib/accounting/money";
import {
  withRollback,
  testUserId,
  openPeriodDate,
  accountId,
  ensureVerifiedTaxRate,
  testProduct,
  testCustomer,
  testSupplier,
  testOrderWithLine,
  testPurchaseInvoice,
} from "./helpers/db";

/**
 * Vyapar parity oracle test (docs/VYAPAR_PARITY_SPEC.md §6, amended below).
 *
 * Recreates the REA Test Co scenario (rounds 1–5, D:\vyapar-analysis.md
 * Part 4) using Urvar's own double-entry primitives, then checks the new
 * R1–R5 transaction reports and the Day Book's Money In/Out (R8) against
 * the figures exported from the real Vyapar app in
 * `vyapar/rea-test-reports/` (gitignored — read with exceljs when
 * reproducing this by hand).
 *
 * Two structural differences from Vyapar, both already documented at the
 * top of `transaction-reports.ts`, mean this does not replay the oracle
 * byte-for-byte:
 *
 * 1. A Sale/Purchase document never carries a payment here — the fixture
 *    creates the sales invoice, then a *separate* receipt allocates 1000 to
 *    it, which is the same end state (received 1000, balance 1360) Vyapar
 *    reaches by bundling the payment on the Sale row itself.
 * 2. (Resolved in step 3.) The loan processing fee now goes through the real
 *    `recordLoanFee()` (loans.ts) and shows up as its own "Processing Fee"
 *    row in All Transactions and Loan Statement, matching the oracle.
 *
 * What's asserted is: (a) every ending balance in the spec's oracle table,
 * (b) R1/R2/R5's figures for the one sale, one purchase and one expense
 * that do map cleanly onto Vyapar's single-entry rows, (c) R3's shape for
 * the receipts/payments that have no sale/purchase behind them, (d) R8's
 * Money In/Out classification for every cash/bank movement type, which is
 * the part of Vyapar's Day Book this scenario can match exactly, and (e)
 * R9's Loan Statement against `Loan Statement Report_*.xlsx` directly.
 */

async function balance(tx: Prisma.TransactionClient, id: string): Promise<string> {
  const lines = await tx.journalLine.findMany({ where: { accountId: id } });
  const debit = lines.reduce((a, l) => a.plus(l.debit), money(0));
  const credit = lines.reduce((a, l) => a.plus(l.credit), money(0));
  return toAmountString(debit.minus(credit));
}

async function buildScenario(tx: Prisma.TransactionClient) {
  const userId = await testUserId(tx);
  const date = await openPeriodDate(tx);
  const customer = await testCustomer(tx);
  const supplier = await testSupplier(tx, { userId });
  await ensureVerifiedTaxRate(tx, "9999TEST", 18);
  const product = await testProduct(tx, { hsnCode: "9999TEST", mrp: 1000 });

  const cashId = await accountId(tx, "1110");
  const undepositedId = await accountId(tx, "1115");
  const unwithdrawnId = await accountId(tx, "2165");
  const rent = await accountId(tx, "5420");

  // Round 1 — two banks, cash.
  const hdfc = await createBankAccount(
    { displayName: "HDFC Test", openingBalance: "50000", openingDate: date, createdById: userId },
    tx,
  );
  const sbi = await createBankAccount(
    { displayName: "SBI Test", openingBalance: "20000", openingDate: date, createdById: userId },
    tx,
  );
  await createCashBankTransaction(
    { type: "CASH_ADJUSTMENT", direction: "OVERAGE", amount: "10000", txnDate: date, createdById: userId },
    tx,
  );

  // Round 2 — movements.
  await createCashBankTransaction({ type: "WITHDRAWAL", bankAccountId: hdfc.ledgerAccountId, amount: "3000", txnDate: date, createdById: userId }, tx);
  await createCashBankTransaction({ type: "DEPOSIT", bankAccountId: sbi.ledgerAccountId, amount: "4000", txnDate: date, createdById: userId }, tx);
  await createCashBankTransaction({ type: "TRANSFER", fromAccountId: hdfc.ledgerAccountId, toAccountId: sbi.ledgerAccountId, amount: "5000", txnDate: date, createdById: userId }, tx);
  await createCashBankTransaction({ type: "BANK_ADJ_INCREASE", bankAccountId: hdfc.ledgerAccountId, amount: "600", txnDate: date, createdById: userId }, tx);
  await createCashBankTransaction({ type: "BANK_ADJ_DECREASE", bankAccountId: sbi.ledgerAccountId, amount: "700", txnDate: date, createdById: userId }, tx);
  await createCashBankTransaction({ type: "CASH_ADJUSTMENT", direction: "SHORTAGE", amount: "800", txnDate: date, createdById: userId }, tx);

  // Round 3 — cheques (pure advances, not allocated to any invoice).
  const receipt1 = await recordReceipt(
    { customerId: customer.id, receiptDate: date, amount: "1500", method: "CHEQUE", reference: "111111", depositAccountId: undepositedId, createdById: userId },
    tx,
  );
  const cheque1 = await tx.cheque.findUniqueOrThrow({ where: { receiptId: receipt1.receiptId } });
  await transferCheque({ chequeId: cheque1.id, bankLedgerAccountId: hdfc.ledgerAccountId, transferDate: date, transferredById: userId }, tx);

  const receipt2 = await recordReceipt(
    { customerId: customer.id, receiptDate: date, amount: "2500", method: "BANK_TRANSFER", depositAccountId: hdfc.ledgerAccountId, createdById: userId },
    tx,
  );

  const payment1 = await recordSupplierPayment(
    { supplierId: supplier.id, paymentDate: date, amount: "900", method: "CHEQUE", reference: "222222", paymentAccountId: unwithdrawnId, createdById: userId },
    tx,
  );
  const cheque2 = await tx.cheque.findUniqueOrThrow({ where: { supplierPaymentId: payment1.paymentId } });
  await transferCheque({ chequeId: cheque2.id, bankLedgerAccountId: sbi.ledgerAccountId, transferDate: date, transferredById: userId }, tx);

  // Round 4 — loan: disbursed into HDFC, processing fee from cash, one EMI.
  // 12% annual on 100000 outstanding gives exactly 1000 interest/month
  // (VYAPAR_PARITY_SPEC.md §6 / vyapar-analysis.md §15), so a 9000 EMI splits
  // 8000 principal + 1000 interest — the same split Vyapar recorded by hand.
  const loan = await createLoan(
    { lenderName: "Test Loan", disbursedToAccountId: hdfc.ledgerAccountId, principal: "100000", annualRatePercent: "12", tenureMonths: 12, startDate: date, emiAmount: "9000", createdById: userId },
    tx,
  );
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });
  const fee = await recordLoanFee(
    { loanId: loan.loanId, type: "PROCESSING_FEE", txnDate: date, amount: "1000", paymentAccountId: cashId, createdById: userId },
    tx,
  );
  await recordLoanRepayment({ loanId: loan.loanId, installmentNumber: 1, paidDate: date, paidFromAccountId: hdfc.ledgerAccountId, createdById: userId }, tx);

  // Round 5 — sale (2 x 1000 @ 18%, 1000 received via HDFC), purchase (3 x 600 @ 18%, paid in full by cash), expense (Rent 350 cash).
  const order = await testOrderWithLine(tx, { userId, customerId: customer.id, productId: product.id, quantity: 2, unitPrice: 1000 });
  const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
  const receipt3 = await recordReceipt(
    {
      customerId: customer.id,
      receiptDate: date,
      amount: "1000",
      method: "BANK_TRANSFER",
      depositAccountId: hdfc.ledgerAccountId,
      allocations: [{ invoiceId: invoice.invoiceId, amount: "1000" }],
      createdById: userId,
    },
    tx,
  );

  const purchaseDraft = await testPurchaseInvoice(tx, {
    userId,
    supplierId: supplier.id,
    invoiceDate: date,
    items: [{ productId: product.id, quantity: 3, unitPrice: 600 }],
    subtotal: "1800",
    taxAmount: "324",
    totalAmount: "2124",
  });
  await postPurchaseInvoice({ invoiceId: purchaseDraft.id, postedById: userId }, tx);
  const payment2 = await recordSupplierPayment(
    {
      supplierId: supplier.id,
      paymentDate: date,
      amount: "2124",
      method: "CASH",
      paymentAccountId: cashId,
      allocations: [{ invoiceId: purchaseDraft.id, amount: "2124" }],
      createdById: userId,
    },
    tx,
  );

  const rentExpense = await createExpense(
    {
      expenseDate: date,
      categoryAccountId: rent,
      payeeName: "Rent",
      method: "CASH",
      paymentAccountId: cashId,
      items: [{ description: "Rent", quantity: "1", unitPrice: "350" }],
      createdById: userId,
    },
    tx,
  );
  await approveExpense({ expenseId: rentExpense.expenseId, approverRole: user.role, approvedById: userId }, tx);

  return {
    userId, date, customer, supplier, product,
    cashId, hdfc, sbi, undepositedId, unwithdrawnId,
    receipt1, receipt2, receipt3, payment1, payment2,
    loan, fee, rentExpense,
    invoiceId: invoice.invoiceId, purchaseInvoiceId: purchaseDraft.id,
  };
}

describe("Vyapar parity — ending balances (VYAPAR_PARITY_SPEC.md §6 oracle table)", () => {
  it("matches every expected balance", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      expect(await balance(tx, s.cashId)).toBe("4726.00");
      expect(await balance(tx, s.hdfc.ledgerAccountId)).toBe("138600.00");
      expect(await balance(tx, s.sbi.ledgerAccountId)).toBe("27400.00");

      const { outstandingPrincipal } = await import("@/lib/accounting/loans");
      expect(toAmountString(await outstandingPrincipal(s.loan.loanId, tx))).toBe("92000.00");
    });
  });
});

describe("R1 Sale Report (vyapar/rea-test-reports/SaleReport_01_10_26_to_31_10_26.xlsx)", () => {
  it("shows the invoice with its received amount, balance, and per-bank split", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const result = await saleReport(s.date, s.date, tx);
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0];
      expect(row.invoiceId).toBe(s.invoiceId);
      expect(row.partyName).toBe(s.customer.name);
      expect(toAmountString(row.totalAmount)).toBe("2360.00"); // 2 x 1000 + 18%
      expect(toAmountString(row.receivedAmount)).toBe("1000.00");
      expect(toAmountString(row.balanceDue)).toBe("1360.00");
      expect(row.byBank.get(s.hdfc.ledgerAccountId)?.toFixed(2)).toBe("1000.00");
      expect(row.byBank.get(s.sbi.ledgerAccountId)?.toFixed(2) ?? "0.00").toBe("0.00");
    });
  });
});

describe("R2 Purchase Report (vyapar/rea-test-reports/PurchaseReport_01_10_26_to_31_10_26.xlsx)", () => {
  it("shows the purchase invoice fully paid in cash", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const result = await purchaseReport(s.date, s.date, tx);
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0];
      expect(row.partyName).toBe(s.supplier.name);
      expect(toAmountString(row.totalAmount)).toBe("2124.00");
      expect(toAmountString(row.paidAmount)).toBe("2124.00");
      expect(toAmountString(row.balanceDue)).toBe("0.00");
      expect(row.paymentType).toBe("Cash");
    });
  });
});

describe("R3 All Transactions Report (vyapar/rea-test-reports/AllTransactionsReport_01_10_26_to_31_10_26.xlsx)", () => {
  it("lists every sale/purchase/payment/expense/loan event, matching the oracle's per-row figures", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const rows = await allTransactionsReport(s.date, s.date, tx);

      const byType = (t: string) => rows.filter((r) => r.transactionType === t);
      expect(byType("Sale")).toHaveLength(1);
      expect(byType("Purchase")).toHaveLength(1);
      // 3, not Vyapar's 2: receipt1 (1500 cheque) and receipt2 (2500 bank) are
      // pure advances, same as the oracle's two Payment-In rows — but
      // receipt3 (1000, allocated to the invoice) is ALSO its own Receipt
      // document here, where Vyapar bundles that same 1000 onto the Sale row
      // itself (structural difference #1 in transaction-reports.ts).
      expect(byType("Payment-In")).toHaveLength(3);
      // 2, not Vyapar's 1: payment1 (900 cheque, a pure advance, same as the
      // oracle's row) and payment2 (2124 cash, allocated to the purchase
      // invoice) — same structural reason as the Payment-In count above.
      expect(byType("Payment-Out")).toHaveLength(2);
      expect(byType("Expense")).toHaveLength(1); // Rent only — the loan fee has its own row type now
      expect(byType("Loan Disbursement")).toHaveLength(1);
      expect(byType("Loan Repayment")).toHaveLength(1);
      expect(byType("Processing Fee")).toHaveLength(1);

      const cheque111 = byType("Payment-In").find((r) => r.paymentType === "Cheque (111111)");
      expect(cheque111).toBeDefined();
      expect(toAmountString(cheque111!.received!)).toBe("1500.00");

      const cheque222 = byType("Payment-Out").find((r) => r.paymentType === "Cheque (222222)");
      expect(cheque222).toBeDefined();
      expect(toAmountString(cheque222!.paid!)).toBe("900.00");

      const sale = byType("Sale")[0];
      expect(toAmountString(sale.total)).toBe("2360.00");
      expect(toAmountString(sale.received!)).toBe("1000.00");
      expect(toAmountString(sale.balance!)).toBe("1360.00");

      const purchase = byType("Purchase")[0];
      expect(toAmountString(purchase.total)).toBe("2124.00");
      expect(toAmountString(purchase.paid!)).toBe("2124.00");

      const rent = byType("Expense").find((r) => r.partyName === "Rent");
      expect(rent).toBeDefined();
      expect(toAmountString(rent!.total)).toBe("350.00");
      expect(rent!.paymentType).toBe("Cash");

      const disbursement = byType("Loan Disbursement")[0];
      expect(toAmountString(disbursement.total)).toBe("100000.00");

      const emi = byType("Loan Repayment")[0];
      expect(toAmountString(emi.total)).toBe("9000.00"); // 8000 principal + 1000 interest

      // Matches AllTransactionsReport_*.xlsx row 5 exactly: "Processing Fee", 1000, Paid=1000.
      const processingFee = byType("Processing Fee")[0];
      expect(toAmountString(processingFee.total)).toBe("1000.00");
      expect(toAmountString(processingFee.paid!)).toBe("1000.00");
      expect(processingFee.paymentType).toBe("Cash");
    });
  });
});

describe("R5 Itemwise Transaction Report (Item Details sheets across the oracle workbooks)", () => {
  it("has one sale line, one purchase line and one expense line matching the oracle's HSN/qty/tax", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const rows = await itemwiseTransactionReport(s.date, s.date, tx);

      const saleLine = rows.find((r) => r.transactionType === "Sale");
      expect(saleLine).toBeDefined();
      expect(saleLine!.hsnCode).toBe("9999TEST");
      expect(saleLine!.quantity.toFixed(2)).toBe("2.00");
      expect(toAmountString(saleLine!.unitPrice)).toBe("1000.00");
      expect(saleLine!.taxPercent?.toFixed(2)).toBe("18.00");
      expect(toAmountString(saleLine!.taxAmount)).toBe("360.00");
      expect(toAmountString(saleLine!.amount)).toBe("2360.00");

      const purchaseLine = rows.find((r) => r.transactionType === "Purchase");
      expect(purchaseLine).toBeDefined();
      expect(purchaseLine!.quantity.toFixed(2)).toBe("3.00");
      expect(toAmountString(purchaseLine!.unitPrice)).toBe("600.00");
      // HSN comes from the linked product (when one is linked) since
      // PurchaseInvoiceItem has no HSN column of its own. Tax is the real
      // G14 gap: no per-line tax rate/amount exists for a purchase line.
      expect(purchaseLine!.hsnCode).toBe("9999TEST");
      expect(purchaseLine!.taxPercent).toBeNull();

      const expenseLine = rows.find((r) => r.transactionType === "Expense" && r.itemName === "Rent");
      expect(expenseLine).toBeDefined();
      expect(toAmountString(expenseLine!.amount)).toBe("350.00");
    });
  });
});

describe("R4 Sale/Purchase by Party", () => {
  it("one customer row (sale only) and one supplier row (purchase only)", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const rows = await salePurchaseByParty(s.date, s.date, tx);

      const customerRow = rows.find((r) => r.partyType === "CUSTOMER" && r.partyId === s.customer.id);
      expect(customerRow).toBeDefined();
      expect(toAmountString(customerRow!.saleTotal)).toBe("2360.00");
      expect(toAmountString(customerRow!.purchaseTotal)).toBe("0.00");

      const supplierRow = rows.find((r) => r.partyType === "SUPPLIER" && r.partyId === s.supplier.id);
      expect(supplierRow).toBeDefined();
      expect(toAmountString(supplierRow!.purchaseTotal)).toBe("2124.00");
      expect(toAmountString(supplierRow!.saleTotal)).toBe("0.00");
    });
  });
});

describe("R8 Day Book check — Money In/Out (vyapar/rea-test-reports/Daybook_25_10_26_to_25_10_26.xlsx)", () => {
  it("classifies every cash/bank movement the same way Vyapar's own export does", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const { entries, totalIn, totalOut, net } = await dayBookMoneyFlow(s.date, s.date, tx);

      const flowOf = (sourceType: string) => {
        const matches = entries.filter((e) => e.sourceType === sourceType);
        expect(matches.length).toBeGreaterThan(0);
        return matches;
      };
      // `CashBankTransaction` posts every one of its types under the single
      // sourceType CASH_BANK_TRANSFER (cash-bank.ts) — only `type` on the
      // narration tells DEPOSIT/WITHDRAWAL/TRANSFER (pure transfers between
      // two cash-like accounts) apart from BANK_ADJ_*/CASH_ADJUSTMENT (one
      // side cash-like, the other equity — no contra to cancel against).
      const byNarration = (prefix: string) =>
        entries.filter((e) => e.sourceType === "CASH_BANK_TRANSFER" && e.narration.startsWith(prefix));

      // Pure transfers between cash-like accounts net to 0/0, as in the oracle.
      for (const e of [...byNarration("DEPOSIT"), ...byNarration("WITHDRAWAL"), ...byNarration("TRANSFER")]) {
        expect(toAmountString(e.moneyIn)).toBe("0.00");
        expect(toAmountString(e.moneyOut)).toBe("0.00");
      }
      // A cheque deposit/clear moves money between two cash-like accounts too.
      for (const e of flowOf("CHEQUE_TRANSFER")) {
        expect(toAmountString(e.moneyIn)).toBe("0.00");
        expect(toAmountString(e.moneyOut)).toBe("0.00");
      }
      // BANK_ADJ_INCREASE/DECREASE and CASH_ADJUSTMENT have no cash-like
      // contra, so they show as pure Money In or Money Out — the oracle's
      // "Bank Adj Increase"/"Cash Reduce" rows.
      const bankIncrease = byNarration("BANK ADJ INCREASE")[0];
      expect(bankIncrease).toBeDefined();
      expect(toAmountString(bankIncrease.moneyIn)).toBe("600.00");
      expect(toAmountString(bankIncrease.moneyOut)).toBe("0.00");
      const bankDecrease = byNarration("BANK ADJ DECREASE")[0];
      expect(toAmountString(bankDecrease.moneyIn)).toBe("0.00");
      expect(toAmountString(bankDecrease.moneyOut)).toBe("700.00");
      const cashOverage = byNarration("CASH ADJUSTMENT").find((e) => e.moneyIn.greaterThan(0));
      expect(cashOverage).toBeDefined();
      expect(toAmountString(cashOverage!.moneyIn)).toBe("10000.00");
      const cashShortage = byNarration("CASH ADJUSTMENT").find((e) => e.moneyOut.greaterThan(0));
      expect(toAmountString(cashShortage!.moneyOut)).toBe("800.00");

      // A received cheque (held in Undeposited Cheques) is Money In at
      // receipt time, same as the oracle's row for "Payment-In ... Cheque (111111)".
      const chequeReceipt = entries.find((e) => e.sourceType === "RECEIPT" && e.lines.some((l) => l.accountId === s.undepositedId));
      expect(chequeReceipt).toBeDefined();
      expect(toAmountString(chequeReceipt!.moneyIn)).toBe("1500.00");

      // The loan disbursement and EMI are Money In / Money Out respectively.
      const disbursement = entries.find((e) => e.sourceType === "LOAN");
      expect(toAmountString(disbursement!.moneyIn)).toBe("100000.00");
      const emi = entries.find((e) => e.sourceType === "LOAN_REPAYMENT");
      expect(toAmountString(emi!.moneyOut)).toBe("9000.00");

      // Aggregate invariant: Total Money In − Total Money Out is the net
      // change in cash + bank + cheques-in-transit over the range.
      expect(net.equals(totalIn.minus(totalOut))).toBe(true);
      expect(totalIn.greaterThan(0)).toBe(true);
      expect(totalOut.greaterThan(0)).toBe(true);
    });
  });
});

describe("R9 Loan Statement (vyapar/rea-test-reports/Loan Statement Report_01_10_26_to_25_10_26.xlsx)", () => {
  it("matches the oracle's rows and summary exactly", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const result = await loanStatement(s.loan.loanId, s.date, s.date, tx);

      expect(result.lenderName).toBe("Test Loan");
      expect(toAmountString(result.openingBalance)).toBe("0.00"); // nothing happened before the range
      expect(result.rows).toHaveLength(3);

      const [disbursement, fee, emi] = result.rows;
      expect(disbursement.type).toBe("Disbursement"); // oracle: "Opening Loan"
      expect(toAmountString(disbursement.amount)).toBe("100000.00");
      expect(toAmountString(disbursement.endingBalance)).toBe("100000.00");

      expect(fee.type).toBe("Processing Fee");
      expect(toAmountString(fee.amount)).toBe("1000.00");
      expect(toAmountString(fee.endingBalance)).toBe("100000.00"); // unchanged — matches the oracle exactly

      expect(emi.type).toBe("EMI Paid");
      expect(toAmountString(emi.amount)).toBe("9000.00");
      expect(toAmountString(emi.endingBalance)).toBe("92000.00");

      // Oracle summary: Opening Balance 100000, Balance Due 92000,
      // Total Principal Paid 8000, Total Interest Paid 1000.
      expect(toAmountString(result.balanceDue)).toBe("92000.00");
      expect(toAmountString(result.totalPrincipalPaid)).toBe("8000.00");
      expect(toAmountString(result.totalInterestPaid)).toBe("1000.00");
    });
  });
});

describe("R10 Loan Account Summary", () => {
  it("one row per loan with opening principal, paid principal/interest, and balance", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const rows = await loanAccountSummary(s.date, tx);
      const row = rows.find((r) => r.loanId === s.loan.loanId);
      expect(row).toBeDefined();
      expect(row!.status).toBe("ACTIVE");
      expect(toAmountString(row!.openingPrincipal)).toBe("100000.00");
      expect(toAmountString(row!.principalPaid)).toBe("8000.00");
      expect(toAmountString(row!.interestPaid)).toBe("1000.00");
      expect(toAmountString(row!.balance)).toBe("92000.00");
    });
  });
});

describe("R12 Journal Entry Report", () => {
  it("lists a manual journal entry's lines, and excludes every document-sourced entry", async () => {
    await withRollback(async (tx) => {
      const s = await buildScenario(tx);
      const userId = await testUserId(tx);
      const drawings = await accountId(tx, "3410"); // Capital Adjustments — any two postable accounts will do
      const cash = s.cashId;

      const posted = await postJournalEntry(
        {
          entryDate: s.date,
          narration: "Owner's drawings, test fixture",
          sourceType: "MANUAL",
          idempotencyKey: `TEST_MANUAL:${s.loan.loanId}:1`,
          postedById: userId,
          lines: [
            { accountId: drawings, debit: "500" },
            { accountId: cash, credit: "500" },
          ],
        },
        tx,
      );

      const rows = await journalEntryReport(s.date, s.date, tx);
      const entryRows = rows.filter((r) => r.entryId === posted.entryId);
      expect(entryRows).toHaveLength(2);
      expect(toAmountString(entryRows.find((r) => r.accountCode === "3410")!.debit)).toBe("500.00");
      expect(toAmountString(entryRows.find((r) => !r.accountCode.startsWith("3410"))!.credit)).toBe("500.00");

      // Every other posting in this scenario (sale, purchase, receipts,
      // loan events…) has a real sourceType of its own — none of them leak
      // into a report that is deliberately scoped to MANUAL only.
      expect(rows.every((r) => r.entryId === posted.entryId)).toBe(true);
    });
  });
});

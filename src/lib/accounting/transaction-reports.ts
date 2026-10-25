import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { loadAccountMap, requireAccount } from "./account-map";
import { add, money, sub, sum, type Money } from "./money";

/**
 * Vyapar parity, step 2 (docs/VYAPAR_PARITY_SPEC.md §3.1, R1–R5).
 *
 * Read-only, same rule as every other report in this directory: derived
 * from posted document rows, never an independent recomputation. Validated
 * against the exported Vyapar workbooks in `vyapar/rea-test-reports/`
 * (gitignored) — `tests/vyapar-parity.test.ts` recreates the REA Test Co
 * scenario and checks these functions' output against those exports.
 *
 * Two structural differences from Vyapar, both intentional (see the spec's
 * "Rules for this document"):
 *
 * 1. **A sale or purchase invoice never carries a payment.** Vyapar's Sale
 *    and Purchase documents are single-entry and can bundle an immediate
 *    receipt/payment (`txn_cash_amount`) on the same row, so its All
 *    Transactions export shows a Payment Type directly on that row. Urvar is
 *    double-entry: `SalesInvoice`/`PurchaseInvoice` post Dr/Cr AR or AP only,
 *    and any money moved against one is a separate `Receipt`/
 *    `SupplierPayment` document, allocated afterwards — so a Sale/Purchase
 *    row in `allTransactionsReport` has `paymentType: null`, and
 *    `saleReport`'s "Received Amount" is the running total of every
 *    allocation against the invoice as of the report date, not a field
 *    frozen on the invoice itself. The user-visible totals (paid, received,
 *    balance) still agree; the row-level mechanics don't.
 * 2. **Customer and Supplier are different tables.** Vyapar's `kb_names` is
 *    one party model that can be both a debtor and a creditor; Urvar keeps
 *    them separate (`salePurchaseByParty`'s rows are never both sale and
 *    purchase for the same party).
 *
 * Known gaps carried over from the spec, not fixed here:
 * - `PurchaseInvoiceItem` has no per-line HSN or tax (G14, step 5) — those
 *   columns are null on a purchase line in `itemwiseTransactionReport`.
 * - Party groups (D7) are not modelled — `salePurchaseByParty` has no Party
 *   Group column and is "by Party" only; "by Party Group" is deferred.
 */

type Db = Prisma.TransactionClient | typeof prisma;

const NOT_CANCELLED_NOT_OPENING = { status: { not: "CANCELLED" as const }, isOpeningItem: false };

// ------------------------------------------------------------ Payment attribution

type BankByLedger = Map<string, { bankAccountId: string; label: string }>;

async function loadBankColumns(db: Db): Promise<{ byLedger: BankByLedger; columns: { bankAccountId: string; label: string }[] }> {
  const banks = await db.bankAccount.findMany({
    where: { isActive: true },
    select: { ledgerAccountId: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });
  const columns = banks.map((b) => ({ bankAccountId: b.ledgerAccountId, label: b.displayName }));
  return { byLedger: new Map(columns.map((c) => [c.bankAccountId, c])), columns };
}

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank Transfer",
  UPI: "UPI",
  CHEQUE: "Cheque",
  CARD: "Card",
  OTHER: "Other",
};

/**
 * Where a receipt/payment's money actually sits (or has moved to), for the
 * "Payment Type" column and the per-bank breakdown.
 *
 * A cheque held in Undeposited/Unwithdrawn Cheques has no bank attribution
 * until it clears — Vyapar shows the same thing as "[Cheque Deposit]" on a
 * separate Bank Statement line (VYAPAR_PARITY_SPEC.md §2.3), never
 * attributed to a bank from the original Payment-In/Out row.
 */
function describePaymentAccount(
  accountId: string,
  method: PaymentMethod,
  reference: string | null,
  chequeNumber: string | null,
  cashId: string,
  undepositedId: string,
  unwithdrawnId: string,
  bankByLedger: BankByLedger,
  accountNameById: Map<string, string>,
): { label: string; bankAccountId: string | null } {
  if (accountId === cashId) return { label: "Cash", bankAccountId: null };
  const bank = bankByLedger.get(accountId);
  if (bank) return { label: bank.label, bankAccountId: bank.bankAccountId };
  if (accountId === undepositedId || accountId === unwithdrawnId) {
    const num = chequeNumber ?? reference;
    return { label: num ? `Cheque (${num})` : "Cheque", bankAccountId: null };
  }
  return { label: accountNameById.get(accountId) ?? METHOD_LABELS[method], bankAccountId: null };
}

/** `Cheque` rows keyed by the `Receipt`/`SupplierPayment` id they belong to. */
async function loadChequeMap(
  db: Db,
  receiptIds: string[],
  paymentIds: string[],
): Promise<Map<string, { chequeNumber: string | null; status: string; bankLedgerAccountId: string | null }>> {
  const cheques = await db.cheque.findMany({
    where: { OR: [{ receiptId: { in: receiptIds } }, { supplierPaymentId: { in: paymentIds } }] },
    select: { receiptId: true, supplierPaymentId: true, chequeNumber: true, status: true, bankLedgerAccountId: true },
  });
  const map = new Map<string, { chequeNumber: string | null; status: string; bankLedgerAccountId: string | null }>();
  for (const c of cheques) {
    const key = c.receiptId ?? c.supplierPaymentId;
    if (key) map.set(key, { chequeNumber: c.chequeNumber, status: c.status, bankLedgerAccountId: c.bankLedgerAccountId });
  }
  return map;
}

/**
 * Once a held cheque clears, attribute it to the bank it cleared into — the
 * "[Cheque Deposit] Cust A" treatment Vyapar's Bank Statement shows
 * (VYAPAR_PARITY_SPEC.md §2.3) — rather than leaving it stuck on "Cheque
 * (nnn)" forever once it is no longer accurate.
 */
function resolveEffectiveAccountId(
  rawAccountId: string,
  cheque: { status: string; bankLedgerAccountId: string | null } | undefined,
): string {
  if (!cheque) return rawAccountId;
  if ((cheque.status === "DEPOSITED" || cheque.status === "CLEARED") && cheque.bankLedgerAccountId) {
    return cheque.bankLedgerAccountId;
  }
  return rawAccountId;
}

// ------------------------------------------------------------ R1 Sale Report

export type SaleReportRow = {
  invoiceId: string;
  date: Date;
  orderNumber: string | null;
  invoiceNumber: string;
  partyName: string;
  gstin: string | null;
  partyPhone: string;
  transactionType: "Sale";
  totalAmount: Money;
  paymentType: string;
  receivedAmount: Money;
  balanceDue: Money;
  description: string | null;
  byBank: Map<string, Money>;
};

export type SaleReportResult = {
  bankColumns: { bankAccountId: string; label: string }[];
  rows: SaleReportRow[];
  totals: { totalAmount: Money; receivedAmount: Money; byBank: Map<string, Money> };
};

/** Every sales invoice in range, with how much of it has been received and through which bank — Vyapar's "Sale Report" (VYAPAR_PARITY_SPEC.md R1). */
export async function saleReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<SaleReportResult> {
  const [accountMap, { byLedger, columns }] = await Promise.all([loadAccountMap(db), loadBankColumns(db)]);
  const cashId = requireAccount(accountMap, "CASH_ON_HAND");
  const undepositedId = requireAccount(accountMap, "UNDEPOSITED_CHEQUES");
  const unwithdrawnId = requireAccount(accountMap, "UNWITHDRAWN_CHEQUES");

  const invoices = await db.salesInvoice.findMany({
    where: { ...NOT_CANCELLED_NOT_OPENING, invoiceDate: { gte: fromDate, lte: toDate } },
    select: {
      id: true,
      invoiceDate: true,
      invoiceNumber: true,
      totalAmount: true,
      customerGstin: true,
      notes: true,
      order: { select: { orderNumber: true } },
      customer: { select: { name: true, phone: true } },
      allocations: {
        where: { receipt: { status: "POSTED" } },
        select: {
          amount: true,
          receipt: { select: { id: true, depositAccountId: true, method: true, reference: true } },
        },
      },
    },
    orderBy: { invoiceDate: "asc" },
  });

  const receiptIds = invoices.flatMap((inv) => inv.allocations.map((a) => a.receipt.id));
  const chequeByReceipt = await loadChequeMap(db, receiptIds, []);

  const rows: SaleReportRow[] = invoices.map((inv) => {
    let receivedAmount = money(0);
    const byBank = new Map<string, Money>();
    const labels = new Set<string>();

    for (const alloc of inv.allocations) {
      receivedAmount = add(receivedAmount, alloc.amount);
      const cheque = chequeByReceipt.get(alloc.receipt.id);
      const effectiveAccountId = resolveEffectiveAccountId(alloc.receipt.depositAccountId, cheque);
      const described = describePaymentAccount(
        effectiveAccountId,
        alloc.receipt.method,
        alloc.receipt.reference,
        cheque?.chequeNumber ?? null,
        cashId,
        undepositedId,
        unwithdrawnId,
        byLedger,
        new Map(),
      );
      labels.add(described.label);
      if (described.bankAccountId) {
        byBank.set(described.bankAccountId, add(byBank.get(described.bankAccountId), alloc.amount));
      }
    }

    return {
      invoiceId: inv.id,
      date: inv.invoiceDate,
      orderNumber: inv.order?.orderNumber ?? null,
      invoiceNumber: inv.invoiceNumber,
      partyName: inv.customer.name,
      gstin: inv.customerGstin,
      partyPhone: inv.customer.phone,
      transactionType: "Sale",
      totalAmount: money(inv.totalAmount),
      paymentType: labels.size ? [...labels].join(" + ") : "—",
      receivedAmount,
      balanceDue: sub(inv.totalAmount, receivedAmount),
      description: inv.notes,
      byBank,
    };
  });

  const totalAmount = sum(rows.map((r) => r.totalAmount));
  const receivedAmount = sum(rows.map((r) => r.receivedAmount));
  const byBankTotals = new Map<string, Money>();
  for (const col of columns) {
    byBankTotals.set(col.bankAccountId, sum(rows.map((r) => r.byBank.get(col.bankAccountId) ?? money(0))));
  }

  return { bankColumns: columns, rows, totals: { totalAmount, receivedAmount, byBank: byBankTotals } };
}

// ------------------------------------------------------------ R2 Purchase Report

export type PurchaseReportRow = {
  invoiceId: string;
  date: Date;
  invoiceNumber: string;
  partyName: string;
  gstin: string | null;
  partyPhone: string | null;
  transactionType: "Purchase";
  totalAmount: Money;
  paymentType: string;
  paidAmount: Money;
  balanceDue: Money;
  description: string | null;
};

/** Every POSTED purchase invoice in range, with how much has been paid — Vyapar's "Purchase Report" (R2). No per-bank columns: the oracle export doesn't carry them for purchases. */
export async function purchaseReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<{ rows: PurchaseReportRow[]; totals: { totalAmount: Money; paidAmount: Money } }> {
  const [accountMap, { byLedger }] = await Promise.all([loadAccountMap(db), loadBankColumns(db)]);
  const cashId = requireAccount(accountMap, "CASH_ON_HAND");
  const undepositedId = requireAccount(accountMap, "UNDEPOSITED_CHEQUES");
  const unwithdrawnId = requireAccount(accountMap, "UNWITHDRAWN_CHEQUES");

  const invoices = await db.purchaseInvoice.findMany({
    where: { ...NOT_CANCELLED_NOT_OPENING, status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] }, invoiceDate: { gte: fromDate, lte: toDate } },
    select: {
      id: true,
      invoiceDate: true,
      invoiceNumber: true,
      totalAmount: true,
      notes: true,
      supplier: { select: { name: true, gstNumber: true, phone: true } },
      allocations: {
        where: { payment: { status: "POSTED" } },
        select: {
          amount: true,
          payment: { select: { id: true, paymentAccountId: true, method: true, reference: true } },
        },
      },
    },
    orderBy: { invoiceDate: "asc" },
  });

  const paymentIds = invoices.flatMap((inv) => inv.allocations.map((a) => a.payment.id));
  const chequeByPayment = await loadChequeMap(db, [], paymentIds);

  const rows: PurchaseReportRow[] = invoices.map((inv) => {
    let paidAmount = money(0);
    const labels = new Set<string>();
    for (const alloc of inv.allocations) {
      paidAmount = add(paidAmount, alloc.amount);
      const cheque = chequeByPayment.get(alloc.payment.id);
      const effectiveAccountId = resolveEffectiveAccountId(alloc.payment.paymentAccountId, cheque);
      const described = describePaymentAccount(
        effectiveAccountId,
        alloc.payment.method,
        alloc.payment.reference,
        cheque?.chequeNumber ?? null,
        cashId,
        undepositedId,
        unwithdrawnId,
        byLedger,
        new Map(),
      );
      labels.add(described.label);
    }
    return {
      invoiceId: inv.id,
      date: inv.invoiceDate,
      invoiceNumber: inv.invoiceNumber,
      partyName: inv.supplier.name,
      gstin: inv.supplier.gstNumber,
      partyPhone: inv.supplier.phone,
      transactionType: "Purchase",
      totalAmount: money(inv.totalAmount),
      paymentType: labels.size ? [...labels].join(" + ") : "—",
      paidAmount,
      balanceDue: sub(inv.totalAmount, paidAmount),
      description: inv.notes,
    };
  });

  return {
    rows,
    totals: { totalAmount: sum(rows.map((r) => r.totalAmount)), paidAmount: sum(rows.map((r) => r.paidAmount)) },
  };
}

// ------------------------------------------------------------ R3 All Transactions Report

export type AllTransactionsRow = {
  date: Date;
  referenceNo: string | null;
  partyName: string | null;
  categoryName: string | null;
  transactionType:
    | "Sale"
    | "Purchase"
    | "Payment-In"
    | "Payment-Out"
    | "Expense"
    | "Loan Disbursement"
    | "Loan Repayment";
  total: Money;
  paymentType: string | null;
  paid: Money | null;
  received: Money | null;
  balance: Money | null;
  description: string | null;
};

/**
 * Every party/business-event document in range, in Vyapar's "All
 * Transactions Report" shape (R3). Scoped to match the exported oracle
 * exactly: pure cash/bank housekeeping (deposits, withdrawals, transfers,
 * cash/bank adjustments, cheque deposit/withdraw) does **not** appear here —
 * the oracle workbook confirms Vyapar excludes it too, even though an
 * earlier draft of VYAPAR_PARITY_SPEC.md §3.1 described this as "every
 * posted document + cash/bank/loan events". Those movements are what the
 * Day Book (R8) is for.
 */
export async function allTransactionsReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<AllTransactionsRow[]> {
  const [accountMap, { byLedger }] = await Promise.all([loadAccountMap(db), loadBankColumns(db)]);
  const cashId = requireAccount(accountMap, "CASH_ON_HAND");
  const undepositedId = requireAccount(accountMap, "UNDEPOSITED_CHEQUES");
  const unwithdrawnId = requireAccount(accountMap, "UNWITHDRAWN_CHEQUES");
  const range = { gte: fromDate, lte: toDate };
  // Unlike saleReport/purchaseReport's per-bank breakdown (which re-resolves a
  // cheque to its eventual bank once cleared), the Payment Type column here
  // is frozen as recorded — "Cheque (111111)" stays that way even after the
  // cheque deposits, matching the oracle's own All Transactions export,
  // which is generated once from `txn_payment_mapping` at document creation
  // and never rewritten when a cheque later clears.

  const [sales, receipts, purchases, payments, expenses, loans, repayments] = await Promise.all([
    db.salesInvoice.findMany({
      where: { ...NOT_CANCELLED_NOT_OPENING, invoiceDate: range },
      select: { id: true, invoiceDate: true, invoiceNumber: true, totalAmount: true, notes: true, customer: { select: { name: true } },
        allocations: { where: { receipt: { status: "POSTED" } }, select: { amount: true } } },
    }),
    db.receipt.findMany({
      where: { status: "POSTED", receiptDate: range },
      select: { id: true, receiptDate: true, receiptNumber: true, amount: true, notes: true, method: true, reference: true, depositAccountId: true, customer: { select: { name: true } } },
    }),
    db.purchaseInvoice.findMany({
      where: { ...NOT_CANCELLED_NOT_OPENING, status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] }, invoiceDate: range },
      select: { id: true, invoiceDate: true, invoiceNumber: true, totalAmount: true, notes: true, supplier: { select: { name: true } },
        allocations: { where: { payment: { status: "POSTED" } }, select: { amount: true } } },
    }),
    db.supplierPayment.findMany({
      where: { status: "POSTED", paymentDate: range },
      select: { id: true, paymentDate: true, paymentNumber: true, amount: true, notes: true, method: true, reference: true, paymentAccountId: true, supplier: { select: { name: true } } },
    }),
    db.expense.findMany({
      where: { status: "APPROVED", expenseDate: range },
      select: { id: true, expenseDate: true, expenseNumber: true, amount: true, payeeName: true, description: true, method: true, paymentAccountId: true, categoryAccount: { select: { name: true } } },
    }),
    db.loan.findMany({
      where: { cancelledAt: null, startDate: range },
      select: { id: true, startDate: true, lenderName: true, principal: true, notes: true, disbursedToAccountId: true },
    }),
    db.loanRepayment.findMany({
      where: { cancelledAt: null, paidDate: range },
      select: { id: true, paidDate: true, installmentNumber: true, totalPaid: true, paidFromAccountId: true, loan: { select: { lenderName: true } } },
    }),
  ]);

  const noNames = new Map<string, string>();

  const describe = (accountId: string, method: PaymentMethod, reference: string | null) =>
    describePaymentAccount(accountId, method, reference, null, cashId, undepositedId, unwithdrawnId, byLedger, noNames).label;

  const rows: AllTransactionsRow[] = [];

  for (const inv of sales) {
    const received = sum(inv.allocations.map((a) => a.amount));
    rows.push({
      date: inv.invoiceDate, referenceNo: inv.invoiceNumber, partyName: inv.customer.name, categoryName: null,
      transactionType: "Sale", total: money(inv.totalAmount), paymentType: null, paid: null, received,
      balance: sub(inv.totalAmount, received), description: inv.notes,
    });
  }
  for (const r of receipts) {
    rows.push({
      date: r.receiptDate, referenceNo: r.receiptNumber, partyName: r.customer.name, categoryName: null,
      transactionType: "Payment-In", total: money(r.amount), paymentType: describe(r.depositAccountId, r.method, r.reference),
      paid: null, received: money(r.amount), balance: null, description: r.notes,
    });
  }
  for (const inv of purchases) {
    const paid = sum(inv.allocations.map((a) => a.amount));
    rows.push({
      date: inv.invoiceDate, referenceNo: inv.invoiceNumber, partyName: inv.supplier.name, categoryName: null,
      transactionType: "Purchase", total: money(inv.totalAmount), paymentType: null, paid, received: null,
      balance: sub(inv.totalAmount, paid), description: inv.notes,
    });
  }
  for (const p of payments) {
    rows.push({
      date: p.paymentDate, referenceNo: p.paymentNumber, partyName: p.supplier.name, categoryName: null,
      transactionType: "Payment-Out", total: money(p.amount), paymentType: describe(p.paymentAccountId, p.method, p.reference),
      paid: money(p.amount), received: null, balance: null, description: p.notes,
    });
  }
  for (const e of expenses) {
    rows.push({
      date: e.expenseDate, referenceNo: e.expenseNumber, partyName: e.payeeName, categoryName: e.categoryAccount.name,
      transactionType: "Expense", total: money(e.amount), paymentType: describe(e.paymentAccountId, e.method, null),
      paid: money(e.amount), received: null, balance: null, description: e.description,
    });
  }
  for (const l of loans) {
    rows.push({
      date: l.startDate, referenceNo: null, partyName: l.lenderName, categoryName: null,
      transactionType: "Loan Disbursement", total: money(l.principal), paymentType: describe(l.disbursedToAccountId, "BANK_TRANSFER", null),
      paid: null, received: money(l.principal), balance: null, description: l.notes,
    });
  }
  for (const rep of repayments) {
    rows.push({
      date: rep.paidDate, referenceNo: null, partyName: rep.loan.lenderName, categoryName: rep.loan.lenderName,
      transactionType: "Loan Repayment", total: money(rep.totalPaid), paymentType: describe(rep.paidFromAccountId, "BANK_TRANSFER", null),
      paid: money(rep.totalPaid), received: null, balance: null, description: `Instalment #${rep.installmentNumber}`,
    });
  }

  return rows.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ------------------------------------------------------------ R5 Itemwise Transaction Report

export type ItemwiseTransactionRow = {
  date: Date;
  txnNumber: string;
  partyName: string | null;
  itemName: string;
  itemCode: string | null;
  hsnCode: string | null;
  category: string | null;
  orderNumber: string | null;
  quantity: Money;
  unit: string | null;
  unitPrice: Money;
  discountPercent: Money;
  discountAmount: Money;
  taxPercent: Money | null;
  taxAmount: Money;
  transactionType: "Sale" | "Purchase" | "Expense";
  amount: Money;
};

/**
 * Every invoice/purchase/expense line in range — Vyapar's "Item Details"
 * sheet promoted to its own report (R5). Purchase lines have no HSN or
 * per-line tax (`PurchaseInvoiceItem`, G14 — a step-5 schema gap, not fixed
 * here), so those two columns are null for a "Purchase" row.
 */
export async function itemwiseTransactionReport(fromDate: Date, toDate: Date, db: Db = prisma): Promise<ItemwiseTransactionRow[]> {
  const range = { gte: fromDate, lte: toDate };

  const [saleItems, purchaseItems, expenseItems] = await Promise.all([
    db.salesInvoiceItem.findMany({
      where: { invoice: { ...NOT_CANCELLED_NOT_OPENING, invoiceDate: range } },
      select: {
        quantity: true, unit: true, unitPrice: true, discountPercent: true, hsnCode: true, taxRatePercent: true,
        cgstAmount: true, sgstAmount: true, igstAmount: true, cessAmount: true, lineTotal: true, taxableValue: true, description: true,
        product: { select: { sku: true, category: true } },
        invoice: { select: { invoiceDate: true, invoiceNumber: true, customer: { select: { name: true } }, order: { select: { orderNumber: true } } } },
      },
    }),
    db.purchaseInvoiceItem.findMany({
      where: { invoice: { ...NOT_CANCELLED_NOT_OPENING, status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] }, invoiceDate: range } },
      select: {
        quantity: true, unitPrice: true, lineTotal: true, description: true,
        product: { select: { sku: true, category: true, hsnCode: true } },
        invoice: { select: { invoiceDate: true, invoiceNumber: true, supplier: { select: { name: true } } } },
      },
    }),
    db.expenseItem.findMany({
      where: { expense: { status: "APPROVED", expenseDate: range } },
      select: {
        quantity: true, unitPrice: true, taxRatePercent: true, taxAmount: true, lineTotal: true, description: true,
        expense: { select: { expenseDate: true, expenseNumber: true, payeeName: true } },
      },
    }),
  ]);

  const rows: ItemwiseTransactionRow[] = [];

  for (const item of saleItems) {
    const tax = add(add(item.cgstAmount, item.sgstAmount), add(item.igstAmount, item.cessAmount));
    const discountAmount = sub(money(item.quantity).times(item.unitPrice), item.taxableValue);
    rows.push({
      date: item.invoice.invoiceDate, txnNumber: item.invoice.invoiceNumber, partyName: item.invoice.customer.name,
      itemName: item.description, itemCode: item.product?.sku ?? null, hsnCode: item.hsnCode, category: item.product?.category ?? null,
      orderNumber: item.invoice.order?.orderNumber ?? null, quantity: money(item.quantity), unit: item.unit, unitPrice: money(item.unitPrice),
      discountPercent: money(item.discountPercent), discountAmount, taxPercent: money(item.taxRatePercent), taxAmount: tax,
      transactionType: "Sale", amount: money(item.lineTotal),
    });
  }
  for (const item of purchaseItems) {
    rows.push({
      date: item.invoice.invoiceDate, txnNumber: item.invoice.invoiceNumber, partyName: item.invoice.supplier.name,
      itemName: item.description, itemCode: item.product?.sku ?? null, hsnCode: item.product?.hsnCode ?? null, category: item.product?.category ?? null,
      orderNumber: null, quantity: money(item.quantity), unit: null, unitPrice: money(item.unitPrice),
      discountPercent: money(0), discountAmount: money(0), taxPercent: null, taxAmount: money(0),
      transactionType: "Purchase", amount: money(item.lineTotal),
    });
  }
  for (const item of expenseItems) {
    rows.push({
      date: item.expense.expenseDate, txnNumber: item.expense.expenseNumber, partyName: item.expense.payeeName,
      itemName: item.description, itemCode: null, hsnCode: null, category: null,
      orderNumber: null, quantity: money(item.quantity), unit: null, unitPrice: money(item.unitPrice),
      discountPercent: money(0), discountAmount: money(0), taxPercent: money(item.taxRatePercent), taxAmount: money(item.taxAmount),
      transactionType: "Expense", amount: money(item.lineTotal),
    });
  }

  return rows.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ------------------------------------------------------------ R4 Sale/Purchase by Party

export type SalePurchaseByPartyRow = {
  partyId: string;
  partyName: string;
  partyType: "CUSTOMER" | "SUPPLIER";
  saleTotal: Money;
  purchaseTotal: Money;
};

/**
 * Sale and purchase totals per party (R4, "by Party" only — "by Party
 * Group" needs D7, deferred per the spec). Urvar's Customer and Supplier are
 * different tables, unlike Vyapar's single party model, so a row is always
 * all-sale or all-purchase, never both.
 */
export async function salePurchaseByParty(fromDate: Date, toDate: Date, db: Db = prisma): Promise<SalePurchaseByPartyRow[]> {
  const range = { gte: fromDate, lte: toDate };
  const [salesByCustomer, purchasesBySupplier] = await Promise.all([
    db.salesInvoice.groupBy({ by: ["customerId"], where: { ...NOT_CANCELLED_NOT_OPENING, invoiceDate: range }, _sum: { totalAmount: true } }),
    db.purchaseInvoice.groupBy({ by: ["supplierId"], where: { ...NOT_CANCELLED_NOT_OPENING, status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] }, invoiceDate: range }, _sum: { totalAmount: true } }),
  ]);

  const [customers, suppliers] = await Promise.all([
    db.customer.findMany({ where: { id: { in: salesByCustomer.map((s) => s.customerId) } }, select: { id: true, name: true } }),
    db.supplier.findMany({ where: { id: { in: purchasesBySupplier.map((p) => p.supplierId) } }, select: { id: true, name: true } }),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

  const rows: SalePurchaseByPartyRow[] = [
    ...salesByCustomer.map((s) => ({
      partyId: s.customerId, partyName: customerName.get(s.customerId) ?? "—", partyType: "CUSTOMER" as const,
      saleTotal: money(s._sum.totalAmount ?? 0), purchaseTotal: money(0),
    })),
    ...purchasesBySupplier.map((p) => ({
      partyId: p.supplierId, partyName: supplierName.get(p.supplierId) ?? "—", partyType: "SUPPLIER" as const,
      saleTotal: money(0), purchaseTotal: money(p._sum.totalAmount ?? 0),
    })),
  ];
  return rows.sort((a, b) => b.saleTotal.plus(b.purchaseTotal).comparedTo(a.saleTotal.plus(a.purchaseTotal)));
}

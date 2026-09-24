import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod, Role } from "@/generated/prisma/enums";
import { postJournalEntry, reverseJournalEntry, type PostingLine } from "./posting";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import {
  add, div, gt, money, mul, percentOf, round, roundToRupee, sub, sum,
  toAmountString, type Money,
} from "./money";
import { logAudit } from "@/lib/audit";
import { canSelfApprove } from "@/lib/permissions";

/**
 * Simple, immediately-paid expenses - rent, electricity, travel, a courier
 * bill - as distinct from a PurchaseInvoice, which carries an ongoing AP
 * balance. See the ExpenseStatus enum comment in schema.prisma for why
 * approval and posting happen in the same step.
 *
 * DRAFT -> SUBMITTED -> APPROVED (posts) or REJECTED. Separation of duties
 * is enforced the same way accounting.approve is everywhere else:
 * assertCanApprove() at the Server Action boundary refuses a user approving
 * their own submission unless they hold the Super Admin exemption.
 *
 * Two shapes coexist: a legacy flat amount (no items, `amount` entered
 * directly — still exactly how it always worked), or an itemised expense
 * (line items, optional GST, transportation, round-off) matching the
 * reference entry screen. `Expense.amount` is the grand total either way,
 * which is all posting, audit and every report have ever needed to read.
 */

export class ExpenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseError";
  }
}

export type ExpenseItemInput = {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  /** Ignored (treated as 0) unless the expense's own `isGstApplicable` is true. */
  taxRatePercent?: string | number;
};

export type CreateExpenseInput = {
  expenseDate: Date;
  categoryAccountId: string;
  payeeName: string;
  description?: string | null;
  method: PaymentMethod;
  paymentAccountId: string;
  createdById: string;
  /** Legacy flat-amount path. Provide exactly one of `amount` or `items`. */
  amount?: string | number;
  items?: ExpenseItemInput[];
  isGstApplicable?: boolean;
  /**
   * Whether the GST above may be claimed as Input Tax Credit. Defaults false
   * — see the `Expense.claimInputCredit` schema comment for why an
   * unclaimed default is the safe one.
   */
  claimInputCredit?: boolean;
  transportAmount?: string | number;
  /** An already-uploaded receipt/bill photo (`File.relatedExpenseId` unset) to attach. */
  fileId?: string;
};

type PreparedItem = {
  description: string;
  quantity: Money;
  unitPrice: Money;
  taxRatePercent: Money;
  taxableValue: Money;
  taxAmount: Money;
  lineTotal: Money;
};

function prepareItem(item: ExpenseItemInput, isGstApplicable: boolean): PreparedItem {
  const quantity = money(item.quantity);
  const unitPrice = money(item.unitPrice);
  const description = item.description.trim();
  if (!description) throw new ExpenseError("Every line needs a description.");
  if (!gt(quantity, 0)) throw new ExpenseError(`Line "${description}" must have a quantity greater than zero.`);

  const taxableValue = round(mul(quantity, unitPrice));
  // The GST toggle governs the whole expense: a rate picked on a line is
  // meaningless (and ignored) when the expense itself isn't marked GST.
  const taxRatePercent = isGstApplicable ? money(item.taxRatePercent ?? 0) : money(0);
  const taxAmount = round(percentOf(taxableValue, taxRatePercent));

  return { description, quantity, unitPrice, taxRatePercent, taxableValue, taxAmount, lineTotal: add(taxableValue, taxAmount) };
}

type PreparedExpense = {
  prepared: PreparedItem[];
  subtotal: Money;
  totalTax: Money;
  transportAmount: Money;
  cgstAmount: Money;
  sgstAmount: Money;
  igstAmount: Money;
  roundOff: Money;
  amount: Money;
};

function prepareExpense(input: CreateExpenseInput, isGstApplicable: boolean): PreparedExpense {
  const hasItems = (input.items?.length ?? 0) > 0;

  if (!hasItems) {
    if (input.amount === undefined) throw new ExpenseError("Provide either an amount or line items.");
    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new ExpenseError("Expense amount must be greater than zero.");
    return {
      prepared: [], subtotal: amount, totalTax: money(0), transportAmount: money(0),
      cgstAmount: money(0), sgstAmount: money(0), igstAmount: money(0), roundOff: money(0), amount,
    };
  }

  const prepared = input.items!.map((item) => prepareItem(item, isGstApplicable));
  const subtotal = round(sum(prepared.map((p) => p.taxableValue)));
  const totalTax = round(sum(prepared.map((p) => p.taxAmount)));
  const transportAmount = round(input.transportAmount ?? 0);

  // Simplification, documented rather than guessed at: expense entry captures
  // no supplier state / place of supply the way sales invoicing does, and the
  // overwhelming majority of day-to-day operating expenses (rent, courier,
  // office supplies) are bought locally, so tax is always split intra-state
  // (CGST+SGST) — a genuinely inter-state expense is a known gap, tracked in
  // docs/ACCOUNTING_IMPLEMENTATION_PLAN.md rather than silently mis-posted as
  // IGST or guessed at here. Split by subtraction, not independent rounding,
  // so the two halves always reconcile exactly to totalTax with no drift.
  //
  // This split is stored regardless of `claimInputCredit` — that flag only
  // decides WHERE the tax posts (see approveExpense), never whether it is
  // recorded. Gating the split itself on the flag was a real bug caught by
  // the test suite: with the flag off, cgst/sgst stayed zero while `amount`
  // (used for the payment credit) still included the tax, so the category
  // debit and payment credit silently disagreed and the entry failed to
  // balance.
  let cgstAmount = money(0);
  let sgstAmount = money(0);
  const igstAmount = money(0);
  if (gt(totalTax, 0)) {
    cgstAmount = round(div(totalTax, 2));
    sgstAmount = sub(totalTax, cgstAmount);
  }

  const beforeRounding = add(add(subtotal, transportAmount), totalTax);
  const { rounded: amount, adjustment: roundOff } = roundToRupee(beforeRounding);
  if (!gt(amount, 0)) throw new ExpenseError("Expense total must be greater than zero.");

  return { prepared, subtotal, totalTax, transportAmount, cgstAmount, sgstAmount, igstAmount, roundOff, amount };
}

export async function createExpense(
  input: CreateExpenseInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ expenseId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ expenseId: string }> => {
    if (!input.payeeName.trim()) throw new ExpenseError("A payee is required.");

    const category = await tx.ledgerAccount.findUnique({ where: { id: input.categoryAccountId } });
    if (!category) throw new ExpenseError("That expense category account does not exist.");
    if (category.type !== "EXPENSE") throw new ExpenseError(`${category.name} is not an expense account.`);
    if (!category.isPostable) {
      throw new ExpenseError(`${category.name} is a grouping account and cannot be used directly.`);
    }

    const isGstApplicable = input.isGstApplicable ?? false;
    const claimInputCredit = isGstApplicable ? (input.claimInputCredit ?? false) : false;
    const { prepared, subtotal, transportAmount, cgstAmount, sgstAmount, igstAmount, roundOff, amount } =
      prepareExpense(input, isGstApplicable);

    const company = await requireCompany(tx);
    const expenseNumber = await allocateDocumentNumber(tx, {
      companyId: company.id,
      documentType: DOCUMENT_TYPES.EXPENSE,
      financialYear: financialYearOf(input.expenseDate, company.fyStartMonth),
      fyStartMonth: company.fyStartMonth,
    });

    const expense = await tx.expense.create({
      data: {
        expenseNumber,
        companyId: company.id,
        expenseDate: input.expenseDate,
        categoryAccountId: input.categoryAccountId,
        payeeName: input.payeeName.trim(),
        description: input.description?.trim() || null,
        amount,
        isGstApplicable,
        claimInputCredit,
        subtotal,
        cgstAmount,
        sgstAmount,
        igstAmount,
        transportAmount,
        roundOff,
        method: input.method,
        paymentAccountId: input.paymentAccountId,
        status: "SUBMITTED",
        submittedAt: new Date(),
        createdById: input.createdById,
        items: prepared.length
          ? {
              create: prepared.map((p, i) => ({
                description: p.description,
                quantity: p.quantity,
                unitPrice: p.unitPrice,
                taxRatePercent: p.taxRatePercent,
                taxableValue: p.taxableValue,
                taxAmount: p.taxAmount,
                lineTotal: p.lineTotal,
                lineNumber: i + 1,
              })),
            }
          : undefined,
      },
    });

    if (input.fileId) {
      await tx.file.updateMany({
        where: { id: input.fileId, uploadedById: input.createdById, relatedExpenseId: null },
        data: { relatedExpenseId: expense.id },
      });
    }

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "Expense",
        entityId: expense.id,
        newValue: { expenseNumber, payeeName: input.payeeName, amount: toAmountString(amount) },
      },
      tx,
    );

    return { expenseId: expense.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type ApproveExpenseInput = {
  expenseId: string;
  approverRole: Role;
  approvedById: string;
};

/** Approve and post in one step — see the module comment for why. */
export async function approveExpense(
  input: ApproveExpenseInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ journalEntryId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ journalEntryId: string }> => {
    const expense = await tx.expense.findUnique({ where: { id: input.expenseId } });
    if (!expense) throw new ExpenseError("Expense not found.");
    if (expense.status !== "SUBMITTED") {
      throw new ExpenseError(`Only a submitted expense can be approved; this one is ${expense.status}.`);
    }
    if (expense.createdById === input.approvedById && !canSelfApprove(input.approverRole)) {
      throw new ExpenseError("You cannot approve an expense you submitted yourself.");
    }

    // The category is debited the subtotal, plus the tax when it is NOT being
    // claimed as ITC — an unclaimed tax is part of the cost, not a separate
    // receivable from the government. Zero-valued lines are dropped rather
    // than posted, matching invoicing.ts's own convention.
    const categoryDebit = expense.claimInputCredit
      ? expense.subtotal
      : add(add(expense.subtotal, expense.cgstAmount), add(expense.sgstAmount, expense.igstAmount));

    const lines: PostingLine[] = [];
    if (gt(categoryDebit, 0)) lines.push({ accountId: expense.categoryAccountId, debit: categoryDebit });
    if (gt(expense.transportAmount, 0)) lines.push({ accountKey: "FREIGHT_INWARD", debit: expense.transportAmount });
    if (expense.claimInputCredit) {
      if (gt(expense.cgstAmount, 0)) lines.push({ accountKey: "GST_INPUT_CGST", debit: expense.cgstAmount });
      if (gt(expense.sgstAmount, 0)) lines.push({ accountKey: "GST_INPUT_SGST", debit: expense.sgstAmount });
      if (gt(expense.igstAmount, 0)) lines.push({ accountKey: "GST_INPUT_IGST", debit: expense.igstAmount });
    }
    if (!expense.roundOff.isZero()) {
      // Mirror image of invoicing.ts's round-off line. There, AR is DEBITED
      // the rounded total, so rounding up CREDITS Round Off. Here the payment
      // account is CREDITED the rounded total instead — the lines above only
      // sum to the exact pre-rounding amount, so rounding up (roundOff > 0,
      // the payment credit is bigger than what's been debited so far) must
      // DEBIT Round Off to make up the difference, and rounding down mirrors it.
      lines.push(
        expense.roundOff.isPositive()
          ? { accountKey: "ROUND_OFF", debit: expense.roundOff }
          : { accountKey: "ROUND_OFF", credit: expense.roundOff.abs() },
      );
    }
    lines.push({ accountId: expense.paymentAccountId, credit: expense.amount });

    const posted = await postJournalEntry(
      {
        entryDate: expense.expenseDate,
        narration: `Expense ${expense.expenseNumber}: ${expense.payeeName}`,
        sourceType: "EXPENSE",
        sourceId: expense.id,
        idempotencyKey: `EXPENSE:${expense.id}:1`,
        postedById: input.approvedById,
        lines,
      },
      tx,
    );

    await tx.expense.update({
      where: { id: expense.id },
      data: {
        status: "APPROVED",
        approvedById: input.approvedById,
        approvedAt: new Date(),
        postedEntryId: posted.entryId,
      },
    });

    await logAudit(
      {
        userId: input.approvedById,
        action: "APPROVE",
        entityType: "Expense",
        entityId: expense.id,
        newValue: { status: "APPROVED", amount: toAmountString(expense.amount) },
      },
      tx,
    );

    return { journalEntryId: posted.entryId };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type RejectExpenseInput = {
  expenseId: string;
  reason: string;
  rejectedById: string;
};

export async function rejectExpense(
  input: RejectExpenseInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const expense = await tx.expense.findUnique({ where: { id: input.expenseId } });
    if (!expense) throw new ExpenseError("Expense not found.");
    if (expense.status !== "SUBMITTED") {
      throw new ExpenseError(`Only a submitted expense can be rejected; this one is ${expense.status}.`);
    }

    await tx.expense.update({
      where: { id: expense.id },
      data: { status: "REJECTED", rejectedReason: input.reason },
    });

    await logAudit(
      {
        userId: input.rejectedById,
        action: "REJECT",
        entityType: "Expense",
        entityId: expense.id,
        newValue: { status: "REJECTED", reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelExpenseInput = {
  expenseId: string;
  reason: string;
  cancelledById: string;
};

/** Reverses an already-approved (posted) expense. */
export async function cancelExpense(
  input: CancelExpenseInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const expense = await tx.expense.findUnique({ where: { id: input.expenseId } });
    if (!expense) throw new ExpenseError("Expense not found.");
    if (expense.status !== "APPROVED") {
      throw new ExpenseError(`Only an approved expense can be cancelled; this one is ${expense.status}.`);
    }
    if (!expense.postedEntryId) throw new ExpenseError("This expense has no posting to reverse.");

    await reverseJournalEntry(
      { entryId: expense.postedEntryId, reason: input.reason, postedById: input.cancelledById },
      tx,
    );

    await tx.expense.update({
      where: { id: expense.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "Expense",
        entityId: expense.id,
        oldValue: { status: expense.status },
        newValue: { status: "CANCELLED", reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

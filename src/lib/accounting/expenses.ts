import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod, Role } from "@/generated/prisma/enums";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import { gt, round, toAmountString } from "./money";
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
 */

export class ExpenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseError";
  }
}

export type CreateExpenseInput = {
  expenseDate: Date;
  categoryAccountId: string;
  payeeName: string;
  description?: string | null;
  amount: string | number;
  method: PaymentMethod;
  paymentAccountId: string;
  createdById: string;
};

export async function createExpense(
  input: CreateExpenseInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ expenseId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ expenseId: string }> => {
    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new ExpenseError("Expense amount must be greater than zero.");
    if (!input.payeeName.trim()) throw new ExpenseError("A payee is required.");

    const category = await tx.ledgerAccount.findUnique({ where: { id: input.categoryAccountId } });
    if (!category) throw new ExpenseError("That expense category account does not exist.");
    if (category.type !== "EXPENSE") throw new ExpenseError(`${category.name} is not an expense account.`);
    if (!category.isPostable) {
      throw new ExpenseError(`${category.name} is a grouping account and cannot be used directly.`);
    }

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
        method: input.method,
        paymentAccountId: input.paymentAccountId,
        status: "SUBMITTED",
        submittedAt: new Date(),
        createdById: input.createdById,
      },
    });

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

    const posted = await postJournalEntry(
      {
        entryDate: expense.expenseDate,
        narration: `Expense ${expense.expenseNumber}: ${expense.payeeName}`,
        sourceType: "EXPENSE",
        sourceId: expense.id,
        idempotencyKey: `EXPENSE:${expense.id}:1`,
        postedById: input.approvedById,
        lines: [
          { accountId: expense.categoryAccountId, debit: expense.amount },
          { accountId: expense.paymentAccountId, credit: expense.amount },
        ],
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

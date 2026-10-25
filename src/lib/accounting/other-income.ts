import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod, Role } from "@/generated/prisma/enums";
import { postJournalEntry, reverseJournalEntry, type PostingLine } from "./posting";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import { add, div, gt, money, mul, percentOf, round, roundToRupee, sub, sum, toAmountString, type Money } from "./money";
import { logAudit } from "@/lib/audit";
import { canSelfApprove } from "@/lib/permissions";

/**
 * Vyapar parity step 6 (docs/VYAPAR_PARITY_SPEC.md D8, R11) — miscellaneous
 * income that isn't a sale: scrap sold, bank interest, a one-off service
 * charge. Mirrors `expenses.ts` deliberately closely — same DRAFT ->
 * SUBMITTED -> APPROVED (posts) / REJECTED lifecycle, same legacy
 * flat-amount-or-itemised-lines duality, same self-approval rule — with
 * every Dr/Cr reversed: money comes IN (`depositAccountId`, not
 * `paymentAccountId`), and any GST it carries is always output tax Urvar
 * now owes, never a claimable credit, so there is no
 * `claimInputCredit`-style toggle to make — a seller never gets to choose
 * not to recognise tax it collected.
 */

export class OtherIncomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtherIncomeError";
  }
}

export type OtherIncomeItemInput = {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  /** Ignored (treated as 0) unless the entry's own `isGstApplicable` is true. */
  taxRatePercent?: string | number;
};

export type CreateOtherIncomeInput = {
  incomeDate: Date;
  categoryAccountId: string;
  payerName: string;
  description?: string | null;
  method: PaymentMethod;
  depositAccountId: string;
  createdById: string;
  /** Legacy flat-amount path. Provide exactly one of `amount` or `items`. */
  amount?: string | number;
  items?: OtherIncomeItemInput[];
  isGstApplicable?: boolean;
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

function prepareItem(item: OtherIncomeItemInput, isGstApplicable: boolean): PreparedItem {
  const quantity = money(item.quantity);
  const unitPrice = money(item.unitPrice);
  const description = item.description.trim();
  if (!description) throw new OtherIncomeError("Every line needs a description.");
  if (!gt(quantity, 0)) throw new OtherIncomeError(`Line "${description}" must have a quantity greater than zero.`);

  const taxableValue = round(mul(quantity, unitPrice));
  const taxRatePercent = isGstApplicable ? money(item.taxRatePercent ?? 0) : money(0);
  const taxAmount = round(percentOf(taxableValue, taxRatePercent));

  return { description, quantity, unitPrice, taxRatePercent, taxableValue, taxAmount, lineTotal: add(taxableValue, taxAmount) };
}

type PreparedOtherIncome = {
  prepared: PreparedItem[];
  subtotal: Money;
  cgstAmount: Money;
  sgstAmount: Money;
  igstAmount: Money;
  roundOff: Money;
  amount: Money;
};

function prepareOtherIncome(input: CreateOtherIncomeInput, isGstApplicable: boolean): PreparedOtherIncome {
  const hasItems = (input.items?.length ?? 0) > 0;

  if (!hasItems) {
    if (input.amount === undefined) throw new OtherIncomeError("Provide either an amount or line items.");
    const amount = round(input.amount);
    if (!gt(amount, 0)) throw new OtherIncomeError("Income amount must be greater than zero.");
    return { prepared: [], subtotal: amount, cgstAmount: money(0), sgstAmount: money(0), igstAmount: money(0), roundOff: money(0), amount };
  }

  const prepared = input.items!.map((item) => prepareItem(item, isGstApplicable));
  const subtotal = round(sum(prepared.map((p) => p.taxableValue)));
  const totalTax = round(sum(prepared.map((p) => p.taxAmount)));

  // Same simplification expenses.ts makes, mirrored: no place-of-supply
  // capture here, so tax always splits intra-state (CGST+SGST). A genuinely
  // inter-state other-income entry is a known gap, not silently mis-posted.
  let cgstAmount = money(0);
  let sgstAmount = money(0);
  const igstAmount = money(0);
  if (gt(totalTax, 0)) {
    cgstAmount = round(div(totalTax, 2));
    sgstAmount = sub(totalTax, cgstAmount);
  }

  const beforeRounding = add(subtotal, totalTax);
  const { rounded: amount, adjustment: roundOff } = roundToRupee(beforeRounding);
  if (!gt(amount, 0)) throw new OtherIncomeError("Income total must be greater than zero.");

  return { prepared, subtotal, cgstAmount, sgstAmount, igstAmount, roundOff, amount };
}

export async function createOtherIncome(
  input: CreateOtherIncomeInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ otherIncomeId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ otherIncomeId: string }> => {
    if (!input.payerName.trim()) throw new OtherIncomeError("A payer is required.");

    const category = await tx.ledgerAccount.findUnique({ where: { id: input.categoryAccountId } });
    if (!category) throw new OtherIncomeError("That income category account does not exist.");
    if (category.type !== "INCOME") throw new OtherIncomeError(`${category.name} is not an income account.`);
    if (!category.isPostable) {
      throw new OtherIncomeError(`${category.name} is a grouping account and cannot be used directly.`);
    }

    const isGstApplicable = input.isGstApplicable ?? false;
    const { prepared, subtotal, cgstAmount, sgstAmount, igstAmount, roundOff, amount } = prepareOtherIncome(input, isGstApplicable);

    const company = await requireCompany(tx);
    const incomeNumber = await allocateDocumentNumber(tx, {
      companyId: company.id,
      documentType: DOCUMENT_TYPES.OTHER_INCOME,
      financialYear: financialYearOf(input.incomeDate, company.fyStartMonth),
      fyStartMonth: company.fyStartMonth,
    });

    const income = await tx.otherIncome.create({
      data: {
        incomeNumber,
        companyId: company.id,
        incomeDate: input.incomeDate,
        categoryAccountId: input.categoryAccountId,
        payerName: input.payerName.trim(),
        description: input.description?.trim() || null,
        amount,
        isGstApplicable,
        subtotal,
        cgstAmount,
        sgstAmount,
        igstAmount,
        roundOff,
        method: input.method,
        depositAccountId: input.depositAccountId,
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

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "OtherIncome",
        entityId: income.id,
        newValue: { incomeNumber, payerName: input.payerName, amount: toAmountString(amount) },
      },
      tx,
    );

    return { otherIncomeId: income.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type ApproveOtherIncomeInput = {
  otherIncomeId: string;
  approverRole: Role;
  approvedById: string;
};

/** Approve and post in one step — the dual of approveExpense(). */
export async function approveOtherIncome(
  input: ApproveOtherIncomeInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ journalEntryId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ journalEntryId: string }> => {
    const income = await tx.otherIncome.findUnique({ where: { id: input.otherIncomeId } });
    if (!income) throw new OtherIncomeError("Other income entry not found.");
    if (income.status !== "SUBMITTED") {
      throw new OtherIncomeError(`Only a submitted entry can be approved; this one is ${income.status}.`);
    }
    if (income.createdById === input.approvedById && !canSelfApprove(input.approverRole)) {
      throw new OtherIncomeError("You cannot approve an entry you submitted yourself.");
    }

    const lines: PostingLine[] = [];
    if (gt(income.subtotal, 0)) lines.push({ accountId: income.categoryAccountId, credit: income.subtotal });
    if (gt(income.cgstAmount, 0)) lines.push({ accountKey: "GST_OUTPUT_CGST", credit: income.cgstAmount });
    if (gt(income.sgstAmount, 0)) lines.push({ accountKey: "GST_OUTPUT_SGST", credit: income.sgstAmount });
    if (gt(income.igstAmount, 0)) lines.push({ accountKey: "GST_OUTPUT_IGST", credit: income.igstAmount });
    if (!income.roundOff.isZero()) {
      // Mirror image of expenses.ts's round-off line: the deposit is
      // DEBITED the rounded total, so rounding up (more came in than the
      // lines above sum to) must CREDIT Round Off to balance.
      lines.push(
        income.roundOff.isPositive()
          ? { accountKey: "ROUND_OFF", credit: income.roundOff }
          : { accountKey: "ROUND_OFF", debit: income.roundOff.abs() },
      );
    }
    lines.push({ accountId: income.depositAccountId, debit: income.amount });

    const posted = await postJournalEntry(
      {
        entryDate: income.incomeDate,
        narration: `Other income ${income.incomeNumber}: ${income.payerName}`,
        sourceType: "OTHER_INCOME",
        sourceId: income.id,
        idempotencyKey: `OTHER_INCOME:${income.id}:1`,
        postedById: input.approvedById,
        lines,
      },
      tx,
    );

    await tx.otherIncome.update({
      where: { id: income.id },
      data: { status: "APPROVED", approvedById: input.approvedById, approvedAt: new Date(), postedEntryId: posted.entryId },
    });

    await logAudit(
      {
        userId: input.approvedById,
        action: "APPROVE",
        entityType: "OtherIncome",
        entityId: income.id,
        newValue: { status: "APPROVED", amount: toAmountString(income.amount) },
      },
      tx,
    );

    return { journalEntryId: posted.entryId };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type RejectOtherIncomeInput = {
  otherIncomeId: string;
  reason: string;
  rejectedById: string;
};

export async function rejectOtherIncome(
  input: RejectOtherIncomeInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const income = await tx.otherIncome.findUnique({ where: { id: input.otherIncomeId } });
    if (!income) throw new OtherIncomeError("Other income entry not found.");
    if (income.status !== "SUBMITTED") {
      throw new OtherIncomeError(`Only a submitted entry can be rejected; this one is ${income.status}.`);
    }

    await tx.otherIncome.update({ where: { id: income.id }, data: { status: "REJECTED", rejectedReason: input.reason } });

    await logAudit(
      { userId: input.rejectedById, action: "REJECT", entityType: "OtherIncome", entityId: income.id, newValue: { status: "REJECTED", reason: input.reason } },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelOtherIncomeInput = {
  otherIncomeId: string;
  reason: string;
  cancelledById: string;
};

/** Reverses an already-approved (posted) entry. */
export async function cancelOtherIncome(
  input: CancelOtherIncomeInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const income = await tx.otherIncome.findUnique({ where: { id: input.otherIncomeId } });
    if (!income) throw new OtherIncomeError("Other income entry not found.");
    if (income.status !== "APPROVED") {
      throw new OtherIncomeError(`Only an approved entry can be cancelled; this one is ${income.status}.`);
    }
    if (!income.postedEntryId) throw new OtherIncomeError("This entry has no posting to reverse.");

    await reverseJournalEntry({ entryId: income.postedEntryId, reason: input.reason, postedById: input.cancelledById }, tx);

    await tx.otherIncome.update({ where: { id: income.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });

    await logAudit(
      { userId: input.cancelledById, action: "CANCEL", entityType: "OtherIncome", entityId: income.id, oldValue: { status: income.status }, newValue: { status: "CANCELLED", reason: input.reason } },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

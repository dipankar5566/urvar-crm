import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { CreditNoteReason } from "@/generated/prisma/enums";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { financialYearOf } from "./fiscal";
import { allocateDocumentNumber, DOCUMENT_TYPES } from "./numbering";
import { add, money, mul, round, roundToRupee, sub, sum, toAmountString } from "./money";
import { logAudit } from "@/lib/audit";
import { syncCustomerOutstanding } from "./receivables";

/**
 * Credit notes against a posted sales invoice.
 *
 * Deferred from Phase 2 ("no live invoices to credit against yet"); the
 * schema (`CreditNote`/`CreditNoteItem`) has existed since then. Built now
 * as an engine tested against synthetic fixtures, same as every other piece
 * of this system before real transaction volume existed to exercise it.
 *
 * Pricing is proportional to the ORIGINAL invoice line's own priced amounts
 * — never re-resolved from the current `TaxRate` — because a credit note
 * must reference the rate the original supply was actually taxed at, not
 * whatever rate happens to be in effect on the day it's issued.
 */

export class CreditNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditNoteError";
  }
}

export type CreditNoteLineInput = {
  invoiceItemId: string;
  /** Defaults to the invoice item's remaining creditable quantity. */
  quantity?: string | number;
};

export type CreateCreditNoteInput = {
  invoiceId: string;
  noteDate: Date;
  reason: CreditNoteReason;
  narration?: string | null;
  /** Omit to credit every line's full remaining quantity. */
  lines?: CreditNoteLineInput[];
  createdById: string;
};

export type CreateCreditNoteResult = {
  creditNoteId: string;
  creditNoteNumber: string;
  totalAmount: string;
  journalEntryId: string;
  journalEntryNumber: string;
};

/**
 * Create a CreditNote against a posted invoice and post it — one
 * transaction, one function, mirroring `createInvoiceFromOrder`'s shape:
 * sales-side documents in this schema post at creation, unlike the
 * purchase side's separate draft-then-review step.
 */
export async function createCreditNote(
  input: CreateCreditNoteInput,
  existingTx?: Prisma.TransactionClient,
): Promise<CreateCreditNoteResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<CreateCreditNoteResult> => {
    const invoice = await tx.salesInvoice.findUnique({
      where: { id: input.invoiceId },
      include: { items: { orderBy: { lineNumber: "asc" } } },
    });
    if (!invoice) throw new CreditNoteError("Invoice not found.");
    if (invoice.status === "CANCELLED") throw new CreditNoteError("Cannot credit a cancelled invoice.");
    if (invoice.items.length === 0) throw new CreditNoteError("This invoice has no line items to credit.");

    const requested = new Map((input.lines ?? []).map((l) => [l.invoiceItemId, l]));
    const toCredit = input.lines ? invoice.items.filter((i) => requested.has(i.id)) : invoice.items;
    if (toCredit.length === 0) throw new CreditNoteError("No matching invoice lines to credit.");

    const prepared = toCredit.map((item) => {
      const req = requested.get(item.id);
      const remaining = sub(item.quantity, item.quantityCredited);
      const qty = req?.quantity !== undefined ? money(req.quantity) : remaining;

      if (qty.lessThanOrEqualTo(0)) {
        throw new CreditNoteError(`Line "${item.description}" has nothing left to credit.`);
      }
      if (qty.greaterThan(remaining)) {
        throw new CreditNoteError(
          `Cannot credit ${toAmountString(qty)} of "${item.description}" — only ` +
            `${toAmountString(remaining)} remains creditable.`,
        );
      }

      const proportion = qty.dividedBy(item.quantity);
      const taxableValue = round(mul(item.taxableValue, proportion));
      const cgstAmount = round(mul(item.cgstAmount, proportion));
      const sgstAmount = round(mul(item.sgstAmount, proportion));
      const igstAmount = round(mul(item.igstAmount, proportion));
      const cessAmount = round(mul(item.cessAmount, proportion));
      const lineTotal = round(add(taxableValue, add(add(cgstAmount, sgstAmount), add(igstAmount, cessAmount))));

      return { item, qty, taxableValue, cgstAmount, sgstAmount, igstAmount, cessAmount, lineTotal };
    });

    const subtotal = round(sum(prepared.map((p) => p.taxableValue)));
    const cgst = round(sum(prepared.map((p) => p.cgstAmount)));
    const sgst = round(sum(prepared.map((p) => p.sgstAmount)));
    const igst = round(sum(prepared.map((p) => p.igstAmount)));
    const cess = round(sum(prepared.map((p) => p.cessAmount)));

    const beforeRounding = add(subtotal, add(add(cgst, sgst), add(igst, cess)));
    const { rounded: totalAmount, adjustment: roundOff } = roundToRupee(beforeRounding);

    const company = await requireCompany(tx);
    const financialYear = financialYearOf(input.noteDate, company.fyStartMonth);
    const creditNoteNumber = await allocateDocumentNumber(tx, {
      companyId: company.id,
      documentType: DOCUMENT_TYPES.CREDIT_NOTE,
      financialYear,
      fyStartMonth: company.fyStartMonth,
    });

    const creditNote = await tx.creditNote.create({
      data: {
        creditNoteNumber,
        companyId: company.id,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        noteDate: input.noteDate,
        reason: input.reason,
        narration: input.narration ?? null,
        placeOfSupply: invoice.placeOfSupply,
        isInterState: invoice.isInterState,
        subtotal,
        cgstAmount: cgst,
        sgstAmount: sgst,
        igstAmount: igst,
        cessAmount: cess,
        roundOff,
        totalAmount,
        createdById: input.createdById,
        items: {
          create: prepared.map((p, i) => ({
            productId: p.item.productId,
            description: p.item.description,
            hsnCode: p.item.hsnCode,
            unit: p.item.unit,
            quantity: p.qty,
            unitPrice: p.item.unitPrice,
            taxableValue: p.taxableValue,
            taxRatePercent: p.item.taxRatePercent,
            cgstAmount: p.cgstAmount,
            sgstAmount: p.sgstAmount,
            igstAmount: p.igstAmount,
            cessAmount: p.cessAmount,
            lineTotal: p.lineTotal,
            lineNumber: i + 1,
          })),
        },
      },
    });

    for (const p of prepared) {
      await tx.salesInvoiceItem.update({
        where: { id: p.item.id },
        data: { quantityCredited: add(p.item.quantityCredited, p.qty) },
      });
    }

    type PostLine = Parameters<typeof postJournalEntry>[0]["lines"][number];
    const lines: PostLine[] = [];
    if (subtotal.greaterThan(0)) lines.push({ accountKey: "SALES_RETURNS", debit: subtotal });
    if (cgst.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_CGST", debit: cgst });
    if (sgst.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_SGST", debit: sgst });
    if (igst.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_IGST", debit: igst });
    if (cess.greaterThan(0)) lines.push({ accountKey: "GST_OUTPUT_CESS", debit: cess });
    if (!roundOff.isZero()) {
      // AR_TRADE is CREDITED the rounded total below, while the debit lines
      // above only sum to the exact pre-rounding amount — the mirror image
      // of the sales-invoice polarity, since AR moves the opposite direction
      // here.
      lines.push(
        roundOff.isPositive()
          ? { accountKey: "ROUND_OFF", debit: roundOff }
          : { accountKey: "ROUND_OFF", credit: roundOff.abs() },
      );
    }
    lines.push({ accountKey: "AR_TRADE", credit: totalAmount, partyType: "CUSTOMER", partyId: invoice.customerId });

    const posted = await postJournalEntry(
      {
        entryDate: input.noteDate,
        narration: `Credit note ${creditNoteNumber} against invoice ${invoice.invoiceNumber}`,
        sourceType: "CREDIT_NOTE",
        sourceId: creditNote.id,
        idempotencyKey: `CREDIT_NOTE:${creditNote.id}:1`,
        postedById: input.createdById,
        lines,
      },
      tx,
    );

    await tx.creditNote.update({
      where: { id: creditNote.id },
      data: { postedEntryId: posted.entryId, postedAt: new Date() },
    });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "CreditNote",
        entityId: creditNote.id,
        newValue: { creditNoteNumber, invoiceId: invoice.id, totalAmount: toAmountString(totalAmount) },
      },
      tx,
    );

    await syncCustomerOutstanding(invoice.customerId, tx);

    return {
      creditNoteId: creditNote.id,
      creditNoteNumber,
      totalAmount: toAmountString(totalAmount),
      journalEntryId: posted.entryId,
      journalEntryNumber: posted.entryNumber,
    };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelCreditNoteInput = {
  creditNoteId: string;
  reason: string;
  cancelledById: string;
};

/**
 * Cancel a posted credit note by reversing its journal entry and releasing
 * the credited quantity back onto the invoice lines it came from — the same
 * shape as `cancelInvoice`.
 */
export async function cancelCreditNote(
  input: CancelCreditNoteInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const creditNote = await tx.creditNote.findUnique({
      where: { id: input.creditNoteId },
      include: { items: true },
    });
    if (!creditNote) throw new CreditNoteError("Credit note not found.");
    if (creditNote.cancelledAt) throw new CreditNoteError("Credit note is already cancelled.");
    if (!creditNote.postedEntryId) throw new CreditNoteError("This credit note was never posted.");

    await reverseJournalEntry(
      { entryId: creditNote.postedEntryId, reason: input.reason, postedById: input.cancelledById },
      tx,
    );

    await tx.creditNote.update({ where: { id: creditNote.id }, data: { cancelledAt: new Date() } });

    if (creditNote.invoiceId) {
      const invoiceItems = await tx.salesInvoiceItem.findMany({ where: { invoiceId: creditNote.invoiceId } });
      for (const ci of creditNote.items) {
        const matched = invoiceItems.find(
          (ii) => ii.productId === ci.productId && ii.description === ci.description,
        );
        if (matched) {
          await tx.salesInvoiceItem.update({
            where: { id: matched.id },
            data: { quantityCredited: sub(matched.quantityCredited, ci.quantity) },
          });
        }
      }
    }

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "CreditNote",
        entityId: creditNote.id,
        newValue: { reason: input.reason },
      },
      tx,
    );

    await syncCustomerOutstanding(creditNote.customerId, tx);
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

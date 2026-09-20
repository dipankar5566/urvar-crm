import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { isInterState } from "./tax";
import { add, gt, money, round, sub, toAmountString } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * Posts an already-captured PurchaseInvoice to the ledger.
 *
 * Deliberately a separate step from creating the invoice. `createPurchaseInvoice`
 * in purchases/actions.ts records what OCR read off a photograph — a misread
 * total should not reach the books unreviewed. A person opens the invoice,
 * checks the numbers, and posts explicitly; only POSTED invoices can be paid.
 */

export class PurchasePostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchasePostingError";
  }
}

export type PostPurchaseInvoiceInput = {
  invoiceId: string;
  postedById: string;
};

export type PostPurchaseInvoiceResult = {
  journalEntryId: string;
  journalEntryNumber: string;
};

export async function postPurchaseInvoice(
  input: PostPurchaseInvoiceInput,
  existingTx?: Prisma.TransactionClient,
): Promise<PostPurchaseInvoiceResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<PostPurchaseInvoiceResult> => {
    const invoice = await tx.purchaseInvoice.findUnique({
      where: { id: input.invoiceId },
      include: { supplier: true },
    });
    if (!invoice) throw new PurchasePostingError("Purchase invoice not found.");
    if (invoice.status !== "DRAFT") {
      throw new PurchasePostingError(`Only a DRAFT invoice can be posted; this one is ${invoice.status}.`);
    }
    if (!invoice.supplier.state) {
      throw new PurchasePostingError(
        `${invoice.supplier.name} has no state on file. Set it before posting — it decides ` +
          `CGST+SGST vs IGST and is never guessed.`,
      );
    }

    const company = await requireCompany(tx);
    const interState = isInterState(company.state, invoice.supplier.state);

    const subtotal = round(invoice.subtotal);
    const tax = round(invoice.taxAmount);
    const total = round(invoice.totalAmount);

    // The header captures one blended tax figure (OCR asks for a single
    // number, not a rate or HSN per line), so ITC is split proportionally
    // from it rather than computed line-by-line the way sales tax is.
    let cgst = money(0);
    let sgst = money(0);
    let igst = money(0);
    if (interState) {
      igst = tax;
    } else {
      const half = tax.dividedBy(2);
      cgst = round(half);
      sgst = round(half);
      // Rounding both halves independently can leave a paisa unaccounted for
      // against the header tax figure; fold it into SGST so the three GST
      // lines always sum to exactly `tax`.
      const drift = sub(tax, add(cgst, sgst));
      if (!drift.isZero()) sgst = add(sgst, drift);
    }

    type PostLine = Parameters<typeof postJournalEntry>[0]["lines"][number];
    const lines: PostLine[] = [
      { accountKey: "PURCHASES", debit: subtotal },
    ];
    if (gt(cgst, 0)) lines.push({ accountKey: "GST_INPUT_CGST", debit: cgst });
    if (gt(sgst, 0)) lines.push({ accountKey: "GST_INPUT_SGST", debit: sgst });
    if (gt(igst, 0)) lines.push({ accountKey: "GST_INPUT_IGST", debit: igst });
    lines.push({
      accountKey: "AP_TRADE",
      credit: total,
      partyType: "SUPPLIER",
      partyId: invoice.supplierId,
    });

    const posted = await postJournalEntry(
      {
        entryDate: invoice.invoiceDate,
        narration: `Purchase invoice ${invoice.invoiceNumber} from ${invoice.supplier.name}`,
        sourceType: "SUPPLIER_BILL",
        sourceId: invoice.id,
        idempotencyKey: `PURCHASE_INVOICE:${invoice.id}:1`,
        postedById: input.postedById,
        lines,
      },
      tx,
    );

    await tx.purchaseInvoice.update({
      where: { id: invoice.id },
      data: {
        status: "POSTED",
        isInterState: interState,
        cgstAmount: cgst,
        sgstAmount: sgst,
        igstAmount: igst,
        postedEntryId: posted.entryId,
        postedAt: new Date(),
      },
    });

    await logAudit(
      {
        userId: input.postedById,
        action: "POST",
        entityType: "PurchaseInvoice",
        entityId: invoice.id,
        newValue: { invoiceNumber: invoice.invoiceNumber, totalAmount: toAmountString(total) },
      },
      tx,
    );

    return { journalEntryId: posted.entryId, journalEntryNumber: posted.entryNumber };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CancelPurchaseInvoiceInput = {
  invoiceId: string;
  reason: string;
  cancelledById: string;
};

export async function cancelPurchaseInvoice(
  input: CancelPurchaseInvoiceInput,
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const invoice = await tx.purchaseInvoice.findUnique({
      where: { id: input.invoiceId },
      include: { allocations: true },
    });
    if (!invoice) throw new PurchasePostingError("Purchase invoice not found.");
    if (invoice.status === "CANCELLED") throw new PurchasePostingError("Already cancelled.");
    if (invoice.allocations.length > 0) {
      throw new PurchasePostingError(
        "This invoice has payments allocated against it. Unwind the allocation before cancelling.",
      );
    }

    if (invoice.postedEntryId) {
      await reverseJournalEntry(
        { entryId: invoice.postedEntryId, reason: input.reason, postedById: input.cancelledById },
        tx,
      );
    }

    await tx.purchaseInvoice.update({
      where: { id: invoice.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "PurchaseInvoice",
        entityId: invoice.id,
        oldValue: { status: invoice.status },
        newValue: { status: "CANCELLED", reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

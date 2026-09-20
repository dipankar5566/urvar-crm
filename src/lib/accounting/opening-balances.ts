import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry } from "./posting";
import { requireCompany } from "./company";
import { isInterState, resolvePlaceOfSupply } from "./tax";
import { round, toAmountString } from "./money";
import { logAudit } from "@/lib/audit";
import { syncCustomerOutstanding } from "./receivables";

/**
 * Opening balances migrated from Vyapar (or any prior system), cut over
 * 2026-09-20.
 *
 * These never touch revenue, expense, or GST output/input accounts — the
 * income was already recognised and the GST already filed under the old
 * system. Each opening invoice posts to its own party control account
 * (AR_TRADE / AP_TRADE) with OPENING_BALANCE_EQUITY as the sole contra,
 * which is what lets a signed opening trial balance be checked by summing
 * every opening posting: the plug should net to zero once every account is
 * accounted for. `isOpeningItem` excludes these from GST outward-supply
 * reporting (see `gstOutwardSupplyRegister()`'s filter).
 */

export class OpeningBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpeningBalanceError";
  }
}

export type CreateOpeningSalesInvoiceInput = {
  customerId: string;
  /** The real invoice number from the prior system, for traceability — never re-numbered through DocumentSeries. */
  sourceInvoiceNumber: string;
  invoiceDate: Date;
  dueDate?: Date | null;
  amount: string | number;
  createdById: string;
};

export type OpeningInvoiceResult = {
  invoiceId: string;
  invoiceNumber: string;
  journalEntryId: string;
  journalEntryNumber: string;
};

/**
 * Book a customer's outstanding balance as of cut-over as a single opening
 * invoice, carrying the source system's own invoice number rather than
 * allocating a new one — this is history being carried forward, not a new
 * sale.
 */
export async function createOpeningSalesInvoice(
  input: CreateOpeningSalesInvoiceInput,
  existingTx?: Prisma.TransactionClient,
): Promise<OpeningInvoiceResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<OpeningInvoiceResult> => {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new OpeningBalanceError("Customer not found.");

    const amount = round(input.amount);
    if (!amount.greaterThan(0)) throw new OpeningBalanceError("Opening balance amount must be greater than zero.");

    const company = await requireCompany(tx);
    const invoiceNumber = `VYP-S-${input.sourceInvoiceNumber}`;

    const existing = await tx.salesInvoice.findUnique({ where: { invoiceNumber } });
    if (existing) throw new OpeningBalanceError(`Opening invoice ${invoiceNumber} has already been imported.`);

    const placeOfSupply = resolvePlaceOfSupply(customer.state);
    const interState = isInterState(company.state, placeOfSupply);

    const invoice = await tx.salesInvoice.create({
      data: {
        invoiceNumber,
        companyId: company.id,
        customerId: customer.id,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        placeOfSupply,
        isInterState: interState,
        customerGstin: customer.gstNumber,
        sellerGstin: company.gstin,
        sellerState: company.state,
        subtotal: amount,
        totalAmount: amount,
        status: "POSTED",
        isOpeningItem: true,
        notes: `Migrated opening balance from prior system, invoice ${input.sourceInvoiceNumber}.`,
        createdById: input.createdById,
        items: {
          create: [
            {
              description: `Opening balance carried forward (source invoice ${input.sourceInvoiceNumber})`,
              unit: "opening",
              quantity: "1",
              unitPrice: amount,
              taxableValue: amount,
              taxRatePercent: "0",
              lineTotal: amount,
              lineNumber: 1,
            },
          ],
        },
      },
    });

    const posted = await postJournalEntry(
      {
        entryDate: input.invoiceDate,
        narration: `Opening balance — ${customer.name} (source invoice ${input.sourceInvoiceNumber})`,
        sourceType: "OPENING_BALANCE",
        sourceId: invoice.id,
        idempotencyKey: `OPENING_BALANCE:SALES_INVOICE:${invoice.id}:1`,
        postedById: input.createdById,
        lines: [
          { accountKey: "AR_TRADE", debit: amount, partyType: "CUSTOMER", partyId: customer.id },
          { accountKey: "OPENING_BALANCE_EQUITY", credit: amount },
        ],
      },
      tx,
    );

    await tx.salesInvoice.update({
      where: { id: invoice.id },
      data: { postedEntryId: posted.entryId, postedAt: new Date() },
    });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "SalesInvoice",
        entityId: invoice.id,
        newValue: { invoiceNumber, isOpeningItem: true, amount: toAmountString(amount) },
      },
      tx,
    );

    await syncCustomerOutstanding(customer.id, tx);

    return {
      invoiceId: invoice.id,
      invoiceNumber,
      journalEntryId: posted.entryId,
      journalEntryNumber: posted.entryNumber,
    };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CreateOpeningPurchaseInvoiceInput = {
  supplierId: string;
  sourceReference: string;
  invoiceDate: Date;
  amount: string | number;
  createdById: string;
};

/** Mirrors `createOpeningSalesInvoice()` for a supplier's outstanding balance. */
export async function createOpeningPurchaseInvoice(
  input: CreateOpeningPurchaseInvoiceInput,
  existingTx?: Prisma.TransactionClient,
): Promise<OpeningInvoiceResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<OpeningInvoiceResult> => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw new OpeningBalanceError("Supplier not found.");

    const amount = round(input.amount);
    if (!amount.greaterThan(0)) throw new OpeningBalanceError("Opening balance amount must be greater than zero.");

    const invoiceNumber = `VYP-P-${input.sourceReference}`;
    const existing = await tx.purchaseInvoice.findUnique({
      where: { supplierId_invoiceNumber: { supplierId: supplier.id, invoiceNumber } },
    });
    if (existing) throw new OpeningBalanceError(`Opening bill ${invoiceNumber} has already been imported.`);

    const invoice = await tx.purchaseInvoice.create({
      data: {
        invoiceNumber,
        supplierId: supplier.id,
        invoiceDate: input.invoiceDate,
        subtotal: amount,
        taxAmount: "0",
        totalAmount: amount,
        status: "POSTED",
        isOpeningItem: true,
        notes: `Migrated opening balance from prior system (${input.sourceReference}).`,
        createdById: input.createdById,
        items: {
          create: [
            {
              description: `Opening balance carried forward (${input.sourceReference})`,
              quantity: "1",
              unitPrice: amount,
              lineTotal: amount,
            },
          ],
        },
      },
    });

    const posted = await postJournalEntry(
      {
        entryDate: input.invoiceDate,
        narration: `Opening balance — ${supplier.name} (${input.sourceReference})`,
        sourceType: "OPENING_BALANCE",
        sourceId: invoice.id,
        idempotencyKey: `OPENING_BALANCE:PURCHASE_INVOICE:${invoice.id}:1`,
        postedById: input.createdById,
        lines: [
          { accountKey: "OPENING_BALANCE_EQUITY", debit: amount },
          { accountKey: "AP_TRADE", credit: amount, partyType: "SUPPLIER", partyId: supplier.id },
        ],
      },
      tx,
    );

    await tx.purchaseInvoice.update({
      where: { id: invoice.id },
      data: { postedEntryId: posted.entryId, postedAt: new Date() },
    });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "PurchaseInvoice",
        entityId: invoice.id,
        newValue: { invoiceNumber, isOpeningItem: true, amount: toAmountString(amount) },
      },
      tx,
    );

    return {
      invoiceId: invoice.id,
      invoiceNumber,
      journalEntryId: posted.entryId,
      journalEntryNumber: posted.entryNumber,
    };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

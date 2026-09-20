import { describe, it, expect } from "vitest";
import { createInvoiceFromOrder, cancelInvoice } from "@/lib/accounting/invoicing";
import { createCreditNote, cancelCreditNote, CreditNoteError } from "@/lib/accounting/credit-notes";
import { customerReceivable } from "@/lib/accounting/receivables";
import { toAmountString, sum } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, ensureVerifiedTaxRate, testProduct, testCustomer, testOrderWithLine,
} from "./helpers/db";

async function invoiceWithItems(tx: Parameters<typeof createInvoiceFromOrder>[1], userId: string, date: Date) {
  await ensureVerifiedTaxRate(tx!, "3101", 5);
  const product = await testProduct(tx!, { hsnCode: "3101" });
  const customer = await testCustomer(tx!, { state: "West Bengal" });
  const order = await testOrderWithLine(tx!, {
    userId, customerId: customer.id, productId: product.id, quantity: 10, unitPrice: 100,
  });
  const result = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
  const items = await tx!.salesInvoiceItem.findMany({ where: { invoiceId: result.invoiceId } });
  return { customer, invoice: result, items };
}

describe("createCreditNote()", () => {
  it("credits the full remaining quantity of every line by default, with a balanced entry", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { customer, invoice } = await invoiceWithItems(tx, userId, date);

      const result = await createCreditNote(
        { invoiceId: invoice.invoiceId, noteDate: date, reason: "SALES_RETURN", createdById: userId },
        tx,
      );

      expect(result.totalAmount).toBe(invoice.totalAmount);

      const lines = await tx.journalLine.findMany({ where: { entryId: result.journalEntryId } });
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));

      // The credit note reduces AR back to zero, same as invoicing it created it.
      expect(toAmountString(await customerReceivable(customer.id, tx))).toBe("0.00");
    });
  });

  it("credits a partial quantity and tracks quantityCredited on the invoice line", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { invoice, items } = await invoiceWithItems(tx, userId, date);

      // 10 units @ 100 + 5% GST = 1050 total; credit 4 of the 10 units.
      await createCreditNote(
        {
          invoiceId: invoice.invoiceId, noteDate: date, reason: "SHORTAGE", createdById: userId,
          lines: [{ invoiceItemId: items[0].id, quantity: "4" }],
        },
        tx,
      );

      const updated = await tx.salesInvoiceItem.findUniqueOrThrow({ where: { id: items[0].id } });
      expect(toAmountString(updated.quantityCredited)).toBe("4.00");

      const remaining = await customerReceivable((await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } })).customerId, tx);
      // 1050 - (4/10 * 1050) = 630.00
      expect(toAmountString(remaining)).toBe("630.00");
    });
  });

  it("refuses to credit more than the remaining creditable quantity", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { invoice, items } = await invoiceWithItems(tx, userId, date);

      await expect(
        createCreditNote(
          {
            invoiceId: invoice.invoiceId, noteDate: date, reason: "OTHER", createdById: userId,
            lines: [{ invoiceItemId: items[0].id, quantity: "11" }],
          },
          tx,
        ),
      ).rejects.toThrow(CreditNoteError);
    });
  });

  it("refuses a second credit note that would exceed what the first one left", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { invoice, items } = await invoiceWithItems(tx, userId, date);

      await createCreditNote(
        {
          invoiceId: invoice.invoiceId, noteDate: date, reason: "OTHER", createdById: userId,
          lines: [{ invoiceItemId: items[0].id, quantity: "6" }],
        },
        tx,
      );

      await expect(
        createCreditNote(
          {
            invoiceId: invoice.invoiceId, noteDate: date, reason: "OTHER", createdById: userId,
            lines: [{ invoiceItemId: items[0].id, quantity: "5" }],
          },
          tx,
        ),
      ).rejects.toThrow(CreditNoteError);
    });
  });

  it("refuses to credit a cancelled invoice", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { invoice } = await invoiceWithItems(tx, userId, date);
      await cancelInvoice({ invoiceId: invoice.invoiceId, reason: "Test", cancelledById: userId }, tx);

      await expect(
        createCreditNote({ invoiceId: invoice.invoiceId, noteDate: date, reason: "OTHER", createdById: userId }, tx),
      ).rejects.toThrow(CreditNoteError);
    });
  });
});

describe("cancelCreditNote()", () => {
  it("reverses the entry and releases the credited quantity back onto the invoice line", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { invoice, items } = await invoiceWithItems(tx, userId, date);

      const cn = await createCreditNote(
        {
          invoiceId: invoice.invoiceId, noteDate: date, reason: "SALES_RETURN", createdById: userId,
          lines: [{ invoiceItemId: items[0].id, quantity: "3" }],
        },
        tx,
      );

      await cancelCreditNote({ creditNoteId: cn.creditNoteId, reason: "Issued in error", cancelledById: userId }, tx);

      const updated = await tx.salesInvoiceItem.findUniqueOrThrow({ where: { id: items[0].id } });
      expect(toAmountString(updated.quantityCredited)).toBe("0.00");

      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: cn.journalEntryId } });
      expect(entry.status).toBe("REVERSED");
    });
  });

  it("refuses to cancel an already-cancelled credit note", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const { invoice } = await invoiceWithItems(tx, userId, date);
      const cn = await createCreditNote(
        { invoiceId: invoice.invoiceId, noteDate: date, reason: "OTHER", createdById: userId },
        tx,
      );
      await cancelCreditNote({ creditNoteId: cn.creditNoteId, reason: "First cancel", cancelledById: userId }, tx);

      await expect(
        cancelCreditNote({ creditNoteId: cn.creditNoteId, reason: "Second cancel", cancelledById: userId }, tx),
      ).rejects.toThrow(CreditNoteError);
    });
  });
});

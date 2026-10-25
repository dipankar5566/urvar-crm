import { describe, it, expect } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { recordReceipt, cancelReceipt, ReceiptError } from "@/lib/accounting/receipts";
import { recordSupplierPayment, cancelSupplierPayment, SupplierPaymentError } from "@/lib/accounting/supplier-payments";
import { transferCheque, reopenCheque, ChequeError } from "@/lib/accounting/cheques";
import { sub, sum, toAmountString } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate, accountId, testCustomer, testSupplier } from "./helpers/db";

async function balance(tx: Prisma.TransactionClient, id: string): Promise<string> {
  const lines = await tx.journalLine.findMany({ where: { accountId: id } });
  return toAmountString(sub(sum(lines.map((l) => l.debit)), sum(lines.map((l) => l.credit))));
}

/** A ₹1,500 cheque receipt held in Undeposited Cheques — REA round 3's Cust A cheque 111111. */
async function chequeReceipt(tx: Prisma.TransactionClient) {
  const userId = await testUserId(tx);
  const date = await openPeriodDate(tx);
  const customer = await testCustomer(tx);
  const undeposited = await accountId(tx, "1115");
  const { receiptId } = await recordReceipt(
    {
      customerId: customer.id,
      receiptDate: date,
      amount: "1500",
      method: "CHEQUE",
      reference: "111111",
      depositAccountId: undeposited,
      createdById: userId,
    },
    tx,
  );
  const cheque = await tx.cheque.findUniqueOrThrow({ where: { receiptId } });
  return { userId, date, receiptId, cheque, undeposited };
}

describe("received cheques", () => {
  it("a cheque receipt is held in 1115 Undeposited Cheques as an OPEN cheque", async () => {
    await withRollback(async (tx) => {
      const before = await balance(tx, await accountId(tx, "1115"));
      const { cheque, undeposited } = await chequeReceipt(tx);
      expect(cheque.status).toBe("OPEN");
      expect(cheque.direction).toBe("RECEIVED");
      expect(cheque.chequeNumber).toBe("111111");
      expect(toAmountString(sub(await balance(tx, undeposited), before))).toBe("1500.00");
    });
  });

  it("depositing moves the money from 1115 to the bank; reopening moves it back", async () => {
    await withRollback(async (tx) => {
      const { userId, date, cheque, undeposited } = await chequeReceipt(tx);
      const bank = await accountId(tx, "1121");
      const bankBefore = await balance(tx, bank);
      const heldBefore = await balance(tx, undeposited);

      await transferCheque({ chequeId: cheque.id, bankLedgerAccountId: bank, transferDate: date, transferredById: userId }, tx);
      expect(toAmountString(sub(await balance(tx, bank), bankBefore))).toBe("1500.00");
      expect(toAmountString(sub(await balance(tx, undeposited), heldBefore))).toBe("-1500.00");
      const deposited = await tx.cheque.findUniqueOrThrow({ where: { id: cheque.id } });
      expect(deposited.status).toBe("DEPOSITED");
      expect(deposited.bankLedgerAccountId).toBe(bank);

      await reopenCheque({ chequeId: cheque.id, reason: "deposited to the wrong bank", reopenedById: userId }, tx);
      expect(await balance(tx, bank)).toBe(bankBefore);
      const reopened = await tx.cheque.findUniqueOrThrow({ where: { id: cheque.id } });
      expect(reopened.status).toBe("OPEN");
      expect(reopened.transferEntryId).toBeNull();

      // A second deposit gets a fresh idempotency key (revision 2), not the reversed one.
      const { entryId } = await transferCheque(
        { chequeId: cheque.id, bankLedgerAccountId: bank, transferDate: date, transferredById: userId },
        tx,
      );
      const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: entryId } });
      expect(entry.idempotencyKey).toBe(`CHEQUE_TRANSFER:${cheque.id}:2`);
    });
  });

  it("refuses to deposit into a non-bank account, twice, or before the cheque date", async () => {
    await withRollback(async (tx) => {
      const { userId, date, cheque } = await chequeReceipt(tx);
      const cash = await accountId(tx, "1110");
      const bank = await accountId(tx, "1121");
      await expect(
        transferCheque({ chequeId: cheque.id, bankLedgerAccountId: cash, transferDate: date, transferredById: userId }, tx),
      ).rejects.toThrow(ChequeError);

      const early = new Date(date.getTime() - 86_400_000);
      await expect(
        transferCheque({ chequeId: cheque.id, bankLedgerAccountId: bank, transferDate: early, transferredById: userId }, tx),
      ).rejects.toThrow(/before the date/);

      await transferCheque({ chequeId: cheque.id, bankLedgerAccountId: bank, transferDate: date, transferredById: userId }, tx);
      await expect(
        transferCheque({ chequeId: cheque.id, bankLedgerAccountId: bank, transferDate: date, transferredById: userId }, tx),
      ).rejects.toThrow(/not open/);
    });
  });

  it("cancelling the receipt while the cheque is OPEN cancels the cheque and clears 1115", async () => {
    await withRollback(async (tx) => {
      const before = await balance(tx, await accountId(tx, "1115"));
      const { userId, receiptId, cheque, undeposited } = await chequeReceipt(tx);
      await cancelReceipt({ receiptId, reason: "cheque returned unsigned", cancelledById: userId }, tx);
      expect((await tx.cheque.findUniqueOrThrow({ where: { id: cheque.id } })).status).toBe("CANCELLED");
      expect(await balance(tx, undeposited)).toBe(before);
    });
  });

  it("refuses to cancel the receipt of a deposited cheque until it is reopened (bounce = reopen + cancel)", async () => {
    await withRollback(async (tx) => {
      const { userId, date, receiptId, cheque } = await chequeReceipt(tx);
      const bank = await accountId(tx, "1121");
      await transferCheque({ chequeId: cheque.id, bankLedgerAccountId: bank, transferDate: date, transferredById: userId }, tx);

      await expect(cancelReceipt({ receiptId, reason: "bounced", cancelledById: userId }, tx)).rejects.toThrow(ReceiptError);

      await reopenCheque({ chequeId: cheque.id, reason: "bounced", reopenedById: userId }, tx);
      await cancelReceipt({ receiptId, reason: "bounced", cancelledById: userId }, tx);
      expect((await tx.receipt.findUniqueOrThrow({ where: { id: receiptId } })).status).toBe("CANCELLED");
    });
  });

  it("only a CHEQUE receipt may be held in Undeposited Cheques", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      await expect(
        recordReceipt(
          { customerId: customer.id, receiptDate: date, amount: "10", method: "UPI", depositAccountId: await accountId(tx, "1115"), createdById: userId },
          tx,
        ),
      ).rejects.toThrow(/Only a cheque receipt/);
    });
  });

  it("a cheque deposited straight to a bank opens no cheque", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const customer = await testCustomer(tx);
      const { receiptId } = await recordReceipt(
        { customerId: customer.id, receiptDate: date, amount: "10", method: "CHEQUE", depositAccountId: await accountId(tx, "1121"), createdById: userId },
        tx,
      );
      expect(await tx.cheque.findUnique({ where: { receiptId } })).toBeNull();
    });
  });
});

describe("issued cheques", () => {
  it("a supplier cheque is held in 2165 until cleared from the bank, and blocks cancellation once cleared", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      const unwithdrawn = await accountId(tx, "2165");
      const bank = await accountId(tx, "1121");
      const heldBefore = await balance(tx, unwithdrawn);
      const bankBefore = await balance(tx, bank);

      const { paymentId } = await recordSupplierPayment(
        {
          supplierId: supplier.id,
          paymentDate: date,
          amount: "900",
          method: "CHEQUE",
          reference: "222222",
          paymentAccountId: unwithdrawn,
          createdById: userId,
        },
        tx,
      );
      const cheque = await tx.cheque.findUniqueOrThrow({ where: { supplierPaymentId: paymentId } });
      expect(cheque.direction).toBe("ISSUED");
      // Liability: credit-normal, so a held cheque shows as -900 on a debit-minus-credit balance.
      expect(toAmountString(sub(await balance(tx, unwithdrawn), heldBefore))).toBe("-900.00");

      await transferCheque({ chequeId: cheque.id, bankLedgerAccountId: bank, transferDate: date, transferredById: userId }, tx);
      expect((await tx.cheque.findUniqueOrThrow({ where: { id: cheque.id } })).status).toBe("CLEARED");
      expect(await balance(tx, unwithdrawn)).toBe(heldBefore);
      expect(toAmountString(sub(await balance(tx, bank), bankBefore))).toBe("-900.00");

      await expect(
        cancelSupplierPayment({ paymentId, reason: "stopped", cancelledById: userId }, tx),
      ).rejects.toThrow(SupplierPaymentError);
    });
  });

  it("refuses to pay a supplier from an account that is not cash, a bank or Unwithdrawn Cheques", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      await expect(
        recordSupplierPayment(
          { supplierId: supplier.id, paymentDate: date, amount: "10", method: "BANK_TRANSFER", paymentAccountId: await accountId(tx, "4100"), createdById: userId },
          tx,
        ),
      ).rejects.toThrow(/must be paid from/);
    });
  });

  it("only a CHEQUE payment may be held in Unwithdrawn Cheques", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const supplier = await testSupplier(tx, { userId });
      await expect(
        recordSupplierPayment(
          { supplierId: supplier.id, paymentDate: date, amount: "10", method: "BANK_TRANSFER", paymentAccountId: await accountId(tx, "2165"), createdById: userId },
          tx,
        ),
      ).rejects.toThrow(/Only a cheque payment/);
    });
  });
});

import { describe, it, expect } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createCashBankTransaction, cancelCashBankTransaction, CashBankError } from "@/lib/accounting/cash-bank";
import { sub, sum, toAmountString } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate, accountId } from "./helpers/db";

/** Net debit balance of an account, from posted journal lines. */
async function balance(tx: Prisma.TransactionClient, id: string): Promise<string> {
  const lines = await tx.journalLine.findMany({ where: { accountId: id } });
  return toAmountString(sub(sum(lines.map((l) => l.debit)), sum(lines.map((l) => l.credit))));
}

/** Change in an account's balance across `body`. */
async function delta(tx: Prisma.TransactionClient, id: string, body: () => Promise<unknown>): Promise<string> {
  const before = await balance(tx, id);
  await body();
  return toAmountString(sub(await balance(tx, id), before));
}

describe("createCashBankTransaction(): Vyapar adjustment types", () => {
  it("BANK_ADJ_INCREASE debits the bank and credits 3420 Bank Adjustment", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const bankAdj = await accountId(tx, "3420");

      const adjMove = await delta(tx, bankAdj, async () => {
        const bankMove = await delta(tx, bank, () =>
          createCashBankTransaction({ type: "BANK_ADJ_INCREASE", bankAccountId: bank, amount: "600", txnDate: date, createdById: userId }, tx),
        );
        expect(bankMove).toBe("600.00");
      });
      expect(adjMove).toBe("-600.00");
    });
  });

  it("BANK_ADJ_DECREASE credits the bank and debits 3420", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const bankAdj = await accountId(tx, "3420");
      const adjMove = await delta(tx, bankAdj, () =>
        createCashBankTransaction({ type: "BANK_ADJ_DECREASE", bankAccountId: bank, amount: "700", txnDate: date, createdById: userId }, tx),
      );
      expect(adjMove).toBe("700.00");
    });
  });

  it("refuses a bank adjustment on an account that is not under 1120", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      await expect(
        createCashBankTransaction({ type: "BANK_ADJ_INCREASE", bankAccountId: cash, amount: "1", txnDate: date, createdById: userId }, tx),
      ).rejects.toThrow(CashBankError);
    });
  });

  it("CASH_ADJUSTMENT with no account offsets to 3410 Cash Adjustment (Vyapar Add/Reduce Cash)", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const cashAdj = await accountId(tx, "3410");

      const adjMove = await delta(tx, cashAdj, async () => {
        const added = await delta(tx, cash, () =>
          createCashBankTransaction({ type: "CASH_ADJUSTMENT", direction: "OVERAGE", amount: "10000", txnDate: date, createdById: userId }, tx),
        );
        expect(added).toBe("10000.00");
        const reduced = await delta(tx, cash, () =>
          createCashBankTransaction({ type: "CASH_ADJUSTMENT", direction: "SHORTAGE", amount: "800", txnDate: date, createdById: userId }, tx),
        );
        expect(reduced).toBe("-800.00");
      });
      // Vyapar's Balance Sheet shows Cash Adjustment 9200 on the equity side.
      expect(adjMove).toBe("-9200.00");
    });
  });

  it("CASH_ADJUSTMENT still accepts an explicit expense account (5800) and rejects an asset", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const shortOver = await accountId(tx, "5800");
      const move = await delta(tx, shortOver, () =>
        createCashBankTransaction(
          { type: "CASH_ADJUSTMENT", direction: "SHORTAGE", adjustmentAccountId: shortOver, amount: "50", txnDate: date, createdById: userId },
          tx,
        ),
      );
      expect(move).toBe("50.00");

      const bank = await accountId(tx, "1121");
      await expect(
        createCashBankTransaction(
          { type: "CASH_ADJUSTMENT", direction: "SHORTAGE", adjustmentAccountId: bank, amount: "1", txnDate: date, createdById: userId },
          tx,
        ),
      ).rejects.toThrow(/EXPENSE or EQUITY/);
    });
  });
});

describe("createCashBankTransaction(): existing movement types", () => {
  it("deposit, withdrawal and transfer move cash and bank as Vyapar types 14/15/25 do", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const cash = await accountId(tx, "1110");
      const bankA = await accountId(tx, "1121");
      const bankB = await accountId(tx, "1122");

      const cashMove = await delta(tx, cash, async () => {
        await createCashBankTransaction({ type: "WITHDRAWAL", bankAccountId: bankA, amount: "3000", txnDate: date, createdById: userId }, tx);
        await createCashBankTransaction({ type: "DEPOSIT", bankAccountId: bankB, amount: "4000", txnDate: date, createdById: userId }, tx);
      });
      expect(cashMove).toBe("-1000.00");

      const transferMove = await delta(tx, bankB, () =>
        createCashBankTransaction(
          { type: "TRANSFER", fromAccountId: bankA, toAccountId: bankB, amount: "5000", txnDate: date, createdById: userId },
          tx,
        ),
      );
      expect(transferMove).toBe("5000.00");
    });
  });

  it("cancelling reverses the posting exactly", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const bank = await accountId(tx, "1121");
      const net = await delta(tx, bank, async () => {
        const { transactionId } = await createCashBankTransaction(
          { type: "BANK_ADJ_INCREASE", bankAccountId: bank, amount: "600", txnDate: date, createdById: userId },
          tx,
        );
        await cancelCashBankTransaction({ transactionId, reason: "entered twice", cancelledById: userId }, tx);
      });
      expect(net).toBe("0.00");
    });
  });
});

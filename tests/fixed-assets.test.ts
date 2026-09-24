import { describe, it, expect } from "vitest";
import {
  createFixedAsset, postDepreciation, disposeFixedAsset, cancelDepreciationEntry, cancelFixedAsset,
  accumulatedDepreciation, FixedAssetError,
} from "@/lib/accounting/fixed-assets";
import { postPurchaseInvoice } from "@/lib/accounting/purchase-posting";
import { toAmountString, sum } from "@/lib/accounting/money";
import { withRollback, testUserId, openPeriodDate, accountId, testSupplier, testPurchaseInvoice } from "./helpers/db";

async function linesFor(tx: Parameters<Parameters<typeof withRollback>[0]>[0], entryId: string) {
  return tx.journalLine.findMany({ where: { entryId }, include: { account: { select: { code: true } } } });
}

describe("createFixedAsset()", () => {
  it("paid from bank: Dr asset / Cr bank, balanced", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const bank = await accountId(tx, "1121");

      const { fixedAssetId } = await createFixedAsset(
        { name: "Test Machine", assetAccountId: plantMachinery, purchaseDate: date, cost: "50000",
          depreciationRatePercent: "15", paidFromAccountId: bank, createdById: userId },
        tx,
      );

      const asset = await tx.fixedAsset.findUniqueOrThrow({ where: { id: fixedAssetId } });
      const lines = await linesFor(tx, asset.postedEntryId!);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe("50000.00");
      expect(lines.find((l) => l.account.code === "1210")!.debit.toString()).toBe("50000");
    });
  });

  it("on-credit via a posted PurchaseInvoice: Dr asset / Cr PURCHASES — NEVER AP_TRADE", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, subtotal: "80000", taxAmount: "0", totalAmount: "80000",
      });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      const { fixedAssetId } = await createFixedAsset(
        { name: "Financed Machine", assetAccountId: plantMachinery, purchaseDate: date, cost: "80000",
          depreciationRatePercent: "15", sourcePurchaseInvoiceId: invoice.id, createdById: userId },
        tx,
      );

      const asset = await tx.fixedAsset.findUniqueOrThrow({ where: { id: fixedAssetId } });
      const lines = await linesFor(tx, asset.postedEntryId!);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      // The regression this test guards: no line here may ever touch AP_TRADE
      // (2110) — accountsPayableAgeing() reconstructs AP entirely from
      // PurchaseInvoice rows, so a credit here with no invoice behind it
      // would never appear in AP ageing or the supplier's statement.
      expect(lines.some((l) => l.account.code === "2110")).toBe(false);
      expect(lines.find((l) => l.account.code === "5200")).toBeDefined(); // Purchases, reclassified
    });
  });

  it("refuses a cost exceeding the linked invoice's subtotal", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const supplier = await testSupplier(tx, { userId, state: "West Bengal" });
      const invoice = await testPurchaseInvoice(tx, {
        userId, supplierId: supplier.id, invoiceDate: date, subtotal: "1000", taxAmount: "0", totalAmount: "1000",
      });
      await postPurchaseInvoice({ invoiceId: invoice.id, postedById: userId }, tx);

      await expect(
        createFixedAsset(
          { name: "Overcosted", assetAccountId: plantMachinery, purchaseDate: date, cost: "5000",
            depreciationRatePercent: "15", sourcePurchaseInvoiceId: invoice.id, createdById: userId },
          tx,
        ),
      ).rejects.toThrow(/cannot exceed the invoice/i);
    });
  });

  it("refuses providing both a payment account and a source invoice", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const bank = await accountId(tx, "1121");
      await expect(
        createFixedAsset(
          { name: "Bad Input", assetAccountId: plantMachinery, purchaseDate: date, cost: "1000",
            depreciationRatePercent: "15", paidFromAccountId: bank, sourcePurchaseInvoiceId: "fake", createdById: userId },
          tx,
        ),
      ).rejects.toThrow(FixedAssetError);
    });
  });
});

describe("postDepreciation()", () => {
  it("posts Dr Depreciation / Cr Accumulated Depreciation, matching computeWdvCharge", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const bank = await accountId(tx, "1121");
      const { fixedAssetId } = await createFixedAsset(
        { name: "Dep Test", assetAccountId: plantMachinery, purchaseDate: date, cost: "100000",
          depreciationRatePercent: "15", paidFromAccountId: bank, createdById: userId },
        tx,
      );

      const { depreciationEntryId } = await postDepreciation(
        { fixedAssetId, financialYear: 2026, runDate: date, createdById: userId }, tx,
      );
      const entry = await tx.depreciationEntry.findUniqueOrThrow({ where: { id: depreciationEntryId } });
      expect(toAmountString(entry.amount)).toBe("15000.00");

      const lines = await linesFor(tx, entry.postedEntryId!);
      expect(lines.find((l) => l.account.code === "5600")!.debit.toString()).toBe("15000");
      expect(lines.find((l) => l.account.code === "1290")!.credit.toString()).toBe("15000");

      const accumulated = await accumulatedDepreciation(fixedAssetId, tx);
      expect(toAmountString(accumulated)).toBe("15000.00");
    });
  });

  it("refuses a second depreciation post for the same financial year", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const bank = await accountId(tx, "1121");
      const { fixedAssetId } = await createFixedAsset(
        { name: "Dup Dep Test", assetAccountId: plantMachinery, purchaseDate: date, cost: "100000",
          depreciationRatePercent: "15", paidFromAccountId: bank, createdById: userId },
        tx,
      );
      await postDepreciation({ fixedAssetId, financialYear: 2026, runDate: date, createdById: userId }, tx);
      await expect(
        postDepreciation({ fixedAssetId, financialYear: 2026, runDate: date, createdById: userId }, tx),
      ).rejects.toThrow(/already been depreciated/i);
    });
  });

  it("cancelling a depreciation entry allows re-posting the same year", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const bank = await accountId(tx, "1121");
      const { fixedAssetId } = await createFixedAsset(
        { name: "Cancel Dep Test", assetAccountId: plantMachinery, purchaseDate: date, cost: "100000",
          depreciationRatePercent: "15", paidFromAccountId: bank, createdById: userId },
        tx,
      );
      const { depreciationEntryId } = await postDepreciation(
        { fixedAssetId, financialYear: 2026, runDate: date, createdById: userId }, tx,
      );
      await cancelDepreciationEntry({ depreciationEntryId, reason: "wrong rate", cancelledById: userId }, tx);
      expect(toAmountString(await accumulatedDepreciation(fixedAssetId, tx))).toBe("0.00");

      const retry = await postDepreciation({ fixedAssetId, financialYear: 2026, runDate: date, createdById: userId }, tx);
      expect(retry.depreciationEntryId).toBeTruthy();
    });
  });
});

describe("disposeFixedAsset()", () => {
  async function setupAsset(tx: Parameters<Parameters<typeof withRollback>[0]>[0], cost: string, withDepreciation: boolean) {
    const userId = await testUserId(tx);
    const date = await openPeriodDate(tx);
    const plantMachinery = await accountId(tx, "1210");
    const bank = await accountId(tx, "1121");
    const { fixedAssetId } = await createFixedAsset(
      { name: "Disposal Test", assetAccountId: plantMachinery, purchaseDate: date, cost,
        depreciationRatePercent: "15", paidFromAccountId: bank, createdById: userId },
      tx,
    );
    if (withDepreciation) {
      await postDepreciation({ fixedAssetId, financialYear: 2026, runDate: date, createdById: userId }, tx);
    }
    return { fixedAssetId, userId, date, bank };
  }

  it("disposal at a gain: proceeds > carrying amount", async () => {
    await withRollback(async (tx) => {
      const { fixedAssetId, userId, date, bank } = await setupAsset(tx, "100000", true);
      const accumulated = await accumulatedDepreciation(fixedAssetId, tx); // 15000 (15% of 100000)
      const carrying = 100000 - Number(accumulated.toString());
      const proceeds = carrying + 5000; // force a gain

      const { disposalEntryId } = await disposeFixedAsset(
        { fixedAssetId, disposalDate: date, proceeds: String(proceeds), proceedsAccountId: bank, createdById: userId }, tx,
      );
      const lines = await linesFor(tx, disposalEntryId);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      const gainLossLine = lines.find((l) => l.account.code === "4920");
      expect(gainLossLine!.credit.toString()).toBe("5000"); // gain on the credit side
    });
  });

  it("disposal at a loss: proceeds < carrying amount", async () => {
    await withRollback(async (tx) => {
      const { fixedAssetId, userId, date, bank } = await setupAsset(tx, "100000", true);
      const accumulated = await accumulatedDepreciation(fixedAssetId, tx);
      const carrying = 100000 - Number(accumulated.toString());
      const proceeds = carrying - 3000; // force a loss

      const { disposalEntryId } = await disposeFixedAsset(
        { fixedAssetId, disposalDate: date, proceeds: String(proceeds), proceedsAccountId: bank, createdById: userId }, tx,
      );
      const lines = await linesFor(tx, disposalEntryId);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      const gainLossLine = lines.find((l) => l.account.code === "4920");
      expect(gainLossLine!.debit.toString()).toBe("3000"); // loss on the debit side
    });
  });

  it("disposal at exactly carrying amount: no gain/loss line at all, still balances", async () => {
    await withRollback(async (tx) => {
      const { fixedAssetId, userId, date, bank } = await setupAsset(tx, "100000", true);
      const accumulated = await accumulatedDepreciation(fixedAssetId, tx);
      const carrying = 100000 - Number(accumulated.toString());

      const { disposalEntryId } = await disposeFixedAsset(
        { fixedAssetId, disposalDate: date, proceeds: String(carrying), proceedsAccountId: bank, createdById: userId }, tx,
      );
      const lines = await linesFor(tx, disposalEntryId);
      expect(lines.find((l) => l.account.code === "4920")).toBeUndefined();
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });

  it("scrapped with zero proceeds: no bank/cash line", async () => {
    await withRollback(async (tx) => {
      const { fixedAssetId, userId, date } = await setupAsset(tx, "100000", true);
      const { disposalEntryId } = await disposeFixedAsset(
        { fixedAssetId, disposalDate: date, proceeds: "0", createdById: userId }, tx,
      );
      const lines = await linesFor(tx, disposalEntryId);
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
      expect(lines.find((l) => l.account.code === "1121")).toBeUndefined();
    });
  });

  it("disposed with zero accumulated depreciation: no 1290 line", async () => {
    await withRollback(async (tx) => {
      const { fixedAssetId, userId, date, bank } = await setupAsset(tx, "100000", false);
      const { disposalEntryId } = await disposeFixedAsset(
        { fixedAssetId, disposalDate: date, proceeds: "80000", proceedsAccountId: bank, createdById: userId }, tx,
      );
      const lines = await linesFor(tx, disposalEntryId);
      expect(lines.find((l) => l.account.code === "1290")).toBeUndefined();
      expect(toAmountString(sum(lines.map((l) => l.debit)))).toBe(toAmountString(sum(lines.map((l) => l.credit))));
    });
  });
});

describe("cancelFixedAsset()", () => {
  it("refuses to cancel once depreciation has been posted", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      const plantMachinery = await accountId(tx, "1210");
      const bank = await accountId(tx, "1121");
      const { fixedAssetId } = await createFixedAsset(
        { name: "Cancel Guard Test", assetAccountId: plantMachinery, purchaseDate: date, cost: "50000",
          depreciationRatePercent: "15", paidFromAccountId: bank, createdById: userId },
        tx,
      );
      await postDepreciation({ fixedAssetId, financialYear: 2026, runDate: date, createdById: userId }, tx);
      await expect(cancelFixedAsset({ fixedAssetId, reason: "test", cancelledById: userId }, tx)).rejects.toThrow(FixedAssetError);
    });
  });
});

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { postJournalEntry, reverseJournalEntry, type PostingLine } from "./posting";
import { requireAccount, loadAccountMap } from "./account-map";
import { computeWdvCharge } from "./depreciation";
import { gt, isNegative, isPositive, money, round, sub, sum, toAmountString, type Money, type MoneyInput } from "./money";
import { logAudit } from "@/lib/audit";

/**
 * The fixed-asset register: a SUB-LEDGER against the shared category
 * accounts (1210/1220/1230) and the contra account 1290, not one
 * LedgerAccount per asset — the opposite end of the sub-ledger-vs-account
 * axis from loans. See the Phase 9 plan for the full argument.
 */

export class FixedAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixedAssetError";
  }
}

// Resolved by code, matching how financial-reports.ts's accountGroupBalances()
// / cashOnHandBalance() already look up 1110/1120 — these two accounts exist
// in the seed with no dedicated AccountMapping key, since Phase 8/9 never
// added one for them.
const DEPRECIATION_EXPENSE_CODE = "5600";
const ACCUMULATED_DEPRECIATION_CODE = "1290";

async function requireAccountByCode(tx: Prisma.TransactionClient, code: string) {
  const account = await tx.ledgerAccount.findUnique({ where: { code } });
  if (!account) throw new FixedAssetError(`Account ${code} does not exist.`);
  return account;
}

export type CreateFixedAssetInput = {
  name: string;
  assetAccountId: string; // 1210 / 1220 / 1230
  purchaseDate: Date;
  cost: MoneyInput;
  depreciationRatePercent: MoneyInput;
  salvageValue?: MoneyInput;
  /** Exactly one of these two. */
  paidFromAccountId?: string;
  sourcePurchaseInvoiceId?: string;
  createdById: string;
};

/**
 * Two funding paths, both posting through this one function:
 *
 * - Paid from cash/bank: Dr assetAccount / Cr paidFromAccountId.
 * - On credit, via an already-posted PurchaseInvoice: Dr assetAccount /
 *   Cr PURCHASES (5200) — a RECLASSIFICATION off the P&L, never
 *   `Cr AP_TRADE`. `accountsPayableAgeing()` reconstructs AP entirely from
 *   PurchaseInvoice rows; a credit posted here with no invoice behind it
 *   would sit in the trial balance forever and never appear in AP ageing or
 *   the supplier's statement. The invoice already tracked AP and split GST
 *   when it posted — this step only moves the spend from the P&L to the
 *   balance sheet.
 */
export async function createFixedAsset(
  input: CreateFixedAssetInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ fixedAssetId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ fixedAssetId: string }> => {
    const name = input.name.trim();
    if (!name) throw new FixedAssetError("An asset needs a name.");

    const cost = round(input.cost);
    if (!gt(cost, 0)) throw new FixedAssetError("Cost must be greater than zero.");
    const rate = money(input.depreciationRatePercent);
    if (rate.isNegative() || rate.greaterThan(100)) throw new FixedAssetError("Depreciation rate must be between 0 and 100.");
    const salvageValue = round(input.salvageValue ?? 0);
    if (salvageValue.greaterThanOrEqualTo(cost)) {
      throw new FixedAssetError("Salvage value must be less than cost.");
    }

    const hasCash = !!input.paidFromAccountId;
    const hasInvoice = !!input.sourcePurchaseInvoiceId;
    if (hasCash === hasInvoice) {
      throw new FixedAssetError("Provide exactly one of a payment account (cash/bank) or a source purchase invoice.");
    }

    const assetAccount = await tx.ledgerAccount.findUnique({ where: { id: input.assetAccountId } });
    if (!assetAccount || assetAccount.type !== "ASSET" || !assetAccount.isPostable) {
      throw new FixedAssetError("That is not a valid postable asset account.");
    }

    const lines: PostingLine[] = [];
    if (hasInvoice) {
      const invoice = await tx.purchaseInvoice.findUnique({ where: { id: input.sourcePurchaseInvoiceId! } });
      if (!invoice) throw new FixedAssetError("That purchase invoice does not exist.");
      if (!["POSTED", "PARTIALLY_PAID", "PAID"].includes(invoice.status)) {
        throw new FixedAssetError(`Invoice is ${invoice.status.toLowerCase()} — it must be posted before it can back an asset.`);
      }
      const existingLink = await tx.fixedAsset.findUnique({ where: { sourcePurchaseInvoiceId: invoice.id } });
      if (existingLink) throw new FixedAssetError("This invoice already backs another fixed asset.");
      if (cost.greaterThan(invoice.subtotal)) {
        throw new FixedAssetError(
          `Capitalised cost (${toAmountString(cost)}) cannot exceed the invoice's subtotal (${toAmountString(invoice.subtotal)}).`,
        );
      }
      const accountMap = await loadAccountMap(tx);
      const purchasesAccountId = requireAccount(accountMap, "PURCHASES");
      lines.push({ accountId: assetAccount.id, debit: cost }, { accountId: purchasesAccountId, credit: cost });
    } else {
      const paymentAccount = await tx.ledgerAccount.findUnique({ where: { id: input.paidFromAccountId! } });
      if (!paymentAccount || !paymentAccount.isActive || !paymentAccount.isPostable) {
        throw new FixedAssetError("That is not a valid payment account.");
      }
      lines.push({ accountId: assetAccount.id, debit: cost }, { accountId: paymentAccount.id, credit: cost });
    }

    const asset = await tx.fixedAsset.create({
      data: {
        name,
        assetAccountId: input.assetAccountId,
        purchaseDate: input.purchaseDate,
        cost,
        depreciationRatePercent: rate,
        salvageValue,
        paidFromAccountId: input.paidFromAccountId ?? null,
        sourcePurchaseInvoiceId: input.sourcePurchaseInvoiceId ?? null,
        createdById: input.createdById,
      },
    });

    const posted = await postJournalEntry(
      {
        entryDate: input.purchaseDate,
        narration: `Fixed asset acquired — ${name}`,
        sourceType: "FIXED_ASSET",
        sourceId: asset.id,
        idempotencyKey: `FIXED_ASSET:${asset.id}:1`,
        postedById: input.createdById,
        lines,
      },
      tx,
    );

    await tx.fixedAsset.update({ where: { id: asset.id }, data: { postedEntryId: posted.entryId } });

    await logAudit(
      {
        userId: input.createdById,
        action: "CREATE",
        entityType: "FixedAsset",
        entityId: asset.id,
        newValue: { name, cost: toAmountString(cost), fundedBy: hasInvoice ? "purchase invoice" : "cash/bank" },
      },
      tx,
    );

    return { fixedAssetId: asset.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Sum of every non-cancelled DepreciationEntry's amount for this asset. */
export async function accumulatedDepreciation(fixedAssetId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Money> {
  const entries = await db.depreciationEntry.findMany({
    where: { fixedAssetId, cancelledAt: null },
    select: { amount: true },
  });
  return round(sum(entries.map((e) => e.amount)));
}

export type PostDepreciationInput = { fixedAssetId: string; financialYear: number; runDate: Date; createdById: string };

/** One financial year's WDV charge, posted Dr Depreciation (5600) / Cr Accumulated Depreciation (1290). */
export async function postDepreciation(
  input: PostDepreciationInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ depreciationEntryId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ depreciationEntryId: string }> => {
    const asset = await tx.fixedAsset.findUnique({ where: { id: input.fixedAssetId } });
    if (!asset) throw new FixedAssetError("That asset does not exist.");
    if (asset.status !== "ACTIVE") throw new FixedAssetError(`This asset is ${asset.status.toLowerCase()}, not active.`);

    // findFirst, not findUnique — see the model's own comment: there is no
    // DB-level compound unique on (fixedAssetId, financialYear) on purpose,
    // so this check (an ACTIVE, non-cancelled entry) runs in application
    // code inside the same transaction as the insert below.
    const existingActive = await tx.depreciationEntry.findFirst({
      where: { fixedAssetId: input.fixedAssetId, financialYear: input.financialYear, cancelledAt: null },
    });
    if (existingActive) {
      throw new FixedAssetError(`FY ${input.financialYear} has already been depreciated for this asset.`);
    }

    const accumulated = await accumulatedDepreciation(input.fixedAssetId, tx);
    const openingWdv = round(sub(asset.cost, accumulated));
    const charge = computeWdvCharge(openingWdv, asset.depreciationRatePercent, asset.salvageValue);

    if (!gt(charge.amount, 0)) {
      throw new FixedAssetError("This asset is already fully depreciated — nothing to post.");
    }

    const depreciationAccount = await requireAccountByCode(tx, DEPRECIATION_EXPENSE_CODE);
    const accumulatedAccount = await requireAccountByCode(tx, ACCUMULATED_DEPRECIATION_CODE);

    const entry = await tx.depreciationEntry.create({
      data: {
        fixedAssetId: input.fixedAssetId,
        financialYear: input.financialYear,
        openingWdv,
        amount: charge.amount,
        closingWdv: charge.closingWdv,
        createdById: input.createdById,
      },
    });

    const posted = await postJournalEntry(
      {
        entryDate: input.runDate,
        narration: `Depreciation FY ${input.financialYear} — ${asset.name}`,
        sourceType: "DEPRECIATION",
        sourceId: entry.id,
        idempotencyKey: `DEPRECIATION:${entry.id}:1`,
        postedById: input.createdById,
        lines: [
          { accountId: depreciationAccount.id, debit: charge.amount },
          { accountId: accumulatedAccount.id, credit: charge.amount },
        ],
      },
      tx,
    );

    await tx.depreciationEntry.update({ where: { id: entry.id }, data: { postedEntryId: posted.entryId } });

    await logAudit(
      {
        userId: input.createdById,
        action: "POST",
        entityType: "DepreciationEntry",
        entityId: entry.id,
        newValue: { financialYear: input.financialYear, amount: toAmountString(charge.amount) },
      },
      tx,
    );

    return { depreciationEntryId: entry.id };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type DisposeFixedAssetInput = {
  fixedAssetId: string;
  disposalDate: Date;
  /** Money received. 0 for a scrapped asset. */
  proceeds: MoneyInput;
  /** The account proceeds landed in — required only when proceeds > 0. */
  proceedsAccountId?: string;
  notes?: string | null;
  createdById: string;
};

/**
 * Disposal at a gain, at a loss, or exactly at carrying amount (no
 * gain/loss line at all) — see the Phase 9 plan's posting matrix for the
 * exact line shapes, including the two degenerate cases (zero proceeds,
 * zero accumulated depreciation) this also handles by simply omitting the
 * line that would otherwise be zero.
 */
export async function disposeFixedAsset(
  input: DisposeFixedAssetInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ disposalEntryId: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ disposalEntryId: string }> => {
    const asset = await tx.fixedAsset.findUnique({ where: { id: input.fixedAssetId } });
    if (!asset) throw new FixedAssetError("That asset does not exist.");
    if (asset.status !== "ACTIVE") throw new FixedAssetError(`This asset is ${asset.status.toLowerCase()}, not active.`);

    const proceeds = round(input.proceeds);
    if (proceeds.isNegative()) throw new FixedAssetError("Proceeds cannot be negative.");
    if (gt(proceeds, 0) && !input.proceedsAccountId) {
      throw new FixedAssetError("Select which account the proceeds landed in.");
    }

    const accumulated = await accumulatedDepreciation(input.fixedAssetId, tx);
    const carryingAmount = round(sub(asset.cost, accumulated));
    const gainOrLoss = round(sub(proceeds, carryingAmount)); // positive = gain, negative = loss

    const accumulatedAccount = await requireAccountByCode(tx, ACCUMULATED_DEPRECIATION_CODE);
    const accountMap = await loadAccountMap(tx);
    const disposalGainLossAccountId = requireAccount(accountMap, "ASSET_DISPOSAL_GAIN_LOSS");

    const lines: PostingLine[] = [];
    if (gt(proceeds, 0)) lines.push({ accountId: input.proceedsAccountId!, debit: proceeds });
    if (gt(accumulated, 0)) lines.push({ accountId: accumulatedAccount.id, debit: accumulated });
    // Native Decimal.isPositive() returns true FOR ZERO TOO (it means "not
    // negative", not "> 0") — money.ts's own isPositive() wraps
    // greaterThan(0) specifically to avoid that trap. Using the raw method
    // here originally added a zero-value credit line whenever proceeds
    // exactly equalled carrying amount, which postJournalEntry correctly
    // refused ("exactly one of debit or credit must be non-zero").
    if (isNegative(gainOrLoss)) lines.push({ accountId: disposalGainLossAccountId, debit: gainOrLoss.abs() });
    lines.push({ accountId: asset.assetAccountId, credit: asset.cost });
    if (isPositive(gainOrLoss)) lines.push({ accountId: disposalGainLossAccountId, credit: gainOrLoss });

    const posted = await postJournalEntry(
      {
        entryDate: input.disposalDate,
        narration: `Fixed asset disposed — ${asset.name}`,
        sourceType: "ASSET_DISPOSAL",
        sourceId: asset.id,
        idempotencyKey: `ASSET_DISPOSAL:${asset.id}:1`,
        postedById: input.createdById,
        lines,
      },
      tx,
    );

    await tx.fixedAsset.update({
      where: { id: asset.id },
      data: {
        status: "DISPOSED",
        disposalDate: input.disposalDate,
        disposalProceeds: proceeds,
        disposalEntryId: posted.entryId,
        disposalNotes: input.notes?.trim() || null,
      },
    });

    await logAudit(
      {
        userId: input.createdById,
        action: "DISPOSE",
        entityType: "FixedAsset",
        entityId: asset.id,
        newValue: { proceeds: toAmountString(proceeds), gainOrLoss: toAmountString(gainOrLoss) },
      },
      tx,
    );

    return { disposalEntryId: posted.entryId };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Reverses a depreciation entry — the asset's WDV rolls back for the next run to recompute from. */
export async function cancelDepreciationEntry(
  input: { depreciationEntryId: string; reason: string; cancelledById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const entry = await tx.depreciationEntry.findUnique({ where: { id: input.depreciationEntryId } });
    if (!entry) throw new FixedAssetError("That depreciation entry does not exist.");
    if (entry.cancelledAt) throw new FixedAssetError("Already cancelled.");
    if (!entry.postedEntryId) throw new FixedAssetError("This entry has no posting to reverse.");

    await reverseJournalEntry({ entryId: entry.postedEntryId, reason: input.reason, postedById: input.cancelledById }, tx);
    await tx.depreciationEntry.update({ where: { id: entry.id }, data: { cancelledAt: new Date() } });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "DepreciationEntry",
        entityId: entry.id,
        newValue: { reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Cancels an asset recorded in error — refused once any depreciation or disposal exists. */
export async function cancelFixedAsset(
  input: { fixedAssetId: string; reason: string; cancelledById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const asset = await tx.fixedAsset.findUnique({ where: { id: input.fixedAssetId } });
    if (!asset) throw new FixedAssetError("That asset does not exist.");
    if (asset.status === "CANCELLED") throw new FixedAssetError("Already cancelled.");
    if (asset.status === "DISPOSED") throw new FixedAssetError("This asset has already been disposed — it cannot be cancelled.");

    const depreciationCount = await tx.depreciationEntry.count({ where: { fixedAssetId: asset.id, cancelledAt: null } });
    if (depreciationCount > 0) throw new FixedAssetError("This asset has depreciation posted against it — cancel those entries first.");
    if (!asset.postedEntryId) throw new FixedAssetError("This asset has no acquisition posting to reverse.");

    await reverseJournalEntry({ entryId: asset.postedEntryId, reason: input.reason, postedById: input.cancelledById }, tx);
    await tx.fixedAsset.update({ where: { id: asset.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });

    await logAudit(
      {
        userId: input.cancelledById,
        action: "CANCEL",
        entityType: "FixedAsset",
        entityId: asset.id,
        newValue: { reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

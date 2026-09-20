import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { requireAccount, loadAccountMap } from "./account-map";
import { sub, sum, type Money } from "./money";

/**
 * Derives a supplier's true payable balance from posted JournalLines.
 *
 * Mirrors src/lib/accounting/receivables.ts exactly, direction reversed:
 * AP_TRADE is a CREDIT-normal account, so a purchase invoice (credit)
 * increases what's owed and a supplier payment (debit) reduces it.
 */
export async function supplierPayable(
  supplierId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money> {
  const map = await loadAccountMap(db);
  const apAccountId = requireAccount(map, "AP_TRADE");

  const lines = await db.journalLine.findMany({
    where: {
      accountId: apAccountId,
      partyType: "SUPPLIER",
      partyId: supplierId,
      entry: { status: "POSTED" },
    },
    select: { debit: true, credit: true },
  });

  return sub(sum(lines.map((l) => l.credit)), sum(lines.map((l) => l.debit)));
}

export type PayablesReconciliationRow = {
  supplierId: string;
  supplierName: string;
  ledgerPayable: string;
};

/**
 * Every supplier's true payable, derived from the ledger. Unlike the AR side
 * there is no stored `outstandingAmount` column on Supplier to reconcile
 * against — this is simply the source of truth for AP.
 */
export async function allSupplierPayables(
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<PayablesReconciliationRow[]> {
  const suppliers = await db.supplier.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });

  const rows: PayablesReconciliationRow[] = [];
  for (const s of suppliers) {
    const payable = await supplierPayable(s.id, db);
    if (payable.isZero()) continue;
    rows.push({ supplierId: s.id, supplierName: s.name, ledgerPayable: payable.toFixed(2) });
  }
  return rows;
}

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { requireAccount, loadAccountMap } from "./account-map";
import { money, sub, sum, type Money } from "./money";

/**
 * Derives a customer's true receivable balance from posted JournalLines.
 *
 * `Customer.outstandingAmount` is a plain column that a rep types into a form
 * (`customers/customer-form.tsx`) and nothing reconciles — the spreadsheet
 * importer writes it too. `safe-zone.ts` reads it to decide whether the AI
 * voice agent may auto-quote a customer under AI_AUTO_QUOTE_ENABLED, so today
 * that decision rests on a number with no accounting behind it.
 *
 * This does not touch the column. It computes the number the column *should*
 * hold, for `syncCustomerOutstanding` (below) and for anything that wants the
 * true balance without waiting for a sync.
 */
export async function customerReceivable(
  customerId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money> {
  const map = await loadAccountMap(db);
  const arAccountId = requireAccount(map, "AR_TRADE");

  const lines = await db.journalLine.findMany({
    where: {
      accountId: arAccountId,
      partyType: "CUSTOMER",
      partyId: customerId,
      entry: { status: "POSTED" },
    },
    select: { debit: true, credit: true },
  });

  // AR is a DEBIT-normal account: debits (invoices) increase the receivable,
  // credits (receipts) decrease it.
  return sub(sum(lines.map((l) => l.debit)), sum(lines.map((l) => l.credit)));
}

/**
 * Recompute one customer's `outstandingAmount` from the ledger and persist it.
 *
 * A write, not a read — kept separate from `customerReceivable()` so a report
 * can ask for the true balance without triggering a write, and a Server
 * Action that just posted an invoice or a receipt can call this once to bring
 * the denormalized column back in step.
 */
export async function syncCustomerOutstanding(
  customerId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money> {
  const balance = money(0).plus(await customerReceivable(customerId, db));
  await db.customer.update({ where: { id: customerId }, data: { outstandingAmount: balance } });
  return balance;
}

export type ReconciliationRow = {
  customerId: string;
  customerName: string;
  storedOutstanding: string;
  ledgerOutstanding: string;
  matches: boolean;
};

/**
 * Compares every customer's stored `outstandingAmount` against the ledger.
 * Read-only — the report the accounting dashboard shows before anyone trusts
 * the derived figure, and the check `tests/receivables.test.ts` runs after
 * posting a mixed invoice/receipt sequence.
 */
export async function reconcileOutstandingAmounts(
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ReconciliationRow[]> {
  const customers = await db.customer.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, outstandingAmount: true },
  });

  const rows: ReconciliationRow[] = [];
  for (const c of customers) {
    const ledger = await customerReceivable(c.id, db);
    const stored = money(c.outstandingAmount);
    rows.push({
      customerId: c.id,
      customerName: c.name,
      storedOutstanding: stored.toFixed(2),
      ledgerOutstanding: ledger.toFixed(2),
      matches: stored.equals(ledger),
    });
  }
  return rows;
}

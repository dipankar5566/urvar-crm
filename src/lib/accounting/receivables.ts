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
 *
 * Filters `entry.status` to exclude only `DRAFT` (never actually written by
 * `postJournalEntry`, which always writes `POSTED`) — not `{ status:
 * "POSTED" }`, which was the bug here until Phase 6: when an invoice is
 * cancelled, `reverseJournalEntry` flips the ORIGINAL entry's status to
 * `REVERSED` and posts a new mirror entry. A `status: "POSTED"` filter then
 * excluded the original's real debit while still counting the reversal's
 * credit, leaving every cancelled invoice's effect as a phantom negative
 * balance instead of netting to zero. Found while building the Phase 6
 * account-status feature this function now feeds directly to a live phone
 * call — see the identical fix and explanation in `financial-reports.ts`.
 */
export async function customerReceivable(
  customerId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Money> {
  const map = await loadAccountMap(db);
  const arAccountId = requireAccount(map, "AR_TRADE");

  // Summed in SQL rather than fetching every AR line into JS — a customer with
  // years of invoices/receipts is one row back, not thousands. `_sum` on a
  // Decimal column is exact (Postgres NUMERIC), and `money()` accepts the
  // null it returns for a customer with no lines.
  const totals = await db.journalLine.aggregate({
    where: {
      accountId: arAccountId,
      partyType: "CUSTOMER",
      partyId: customerId,
      entry: { status: { not: "DRAFT" } },
    },
    _sum: { debit: true, credit: true },
  });

  // AR is a DEBIT-normal account: debits (invoices) increase the receivable,
  // credits (receipts) decrease it.
  return sub(totals._sum.debit, totals._sum.credit);
}

export type OverdueInvoiceSummary = {
  invoiceNumber: string;
  dueDate: Date;
  daysOverdue: number;
  outstanding: Money;
};

export type CustomerAccountStatus = {
  customerId: string;
  outstanding: Money;
  creditLimit: Money | null;
  overdueInvoices: OverdueInvoiceSummary[];
  overdueAmount: Money;
  lastPaymentDate: Date | null;
  lastPaymentAmount: Money | null;
};

/**
 * A customer's account at a glance — outstanding balance, credit limit,
 * which invoices are overdue and by how much, and the last payment on file.
 *
 * Phase 6: this is the one function both the customer detail page and the
 * voice agent's `get_account_status` tool call, so "what can this customer
 * be told about their account" is defined in exactly one place. Everything
 * here is derived from posted ledger and document data — nothing is a
 * stored, unreconciled column.
 */
export async function customerAccountStatus(
  customerId: string,
  asOfDate: Date = new Date(),
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<CustomerAccountStatus> {
  const { outstandingOnInvoice } = await import("./receipts");

  const customer = await db.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { creditLimit: true },
  });

  const outstanding = await customerReceivable(customerId, db);

  const candidates = await db.salesInvoice.findMany({
    where: {
      customerId,
      status: { in: ["POSTED", "PARTIALLY_PAID"] },
      dueDate: { lt: asOfDate },
    },
    select: { id: true, invoiceNumber: true, dueDate: true },
  });

  const overdueInvoices: OverdueInvoiceSummary[] = [];
  for (const inv of candidates) {
    if (!inv.dueDate) continue;
    const due = await outstandingOnInvoice(inv.id, db);
    if (due.isZero()) continue;
    const daysOverdue = Math.floor((asOfDate.getTime() - inv.dueDate.getTime()) / (24 * 60 * 60 * 1000));
    overdueInvoices.push({ invoiceNumber: inv.invoiceNumber, dueDate: inv.dueDate, daysOverdue, outstanding: due });
  }
  overdueInvoices.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const lastReceipt = await db.receipt.findFirst({
    where: { customerId, status: "POSTED" },
    orderBy: { receiptDate: "desc" },
    select: { receiptDate: true, amount: true },
  });

  return {
    customerId,
    outstanding,
    creditLimit: customer.creditLimit ? money(customer.creditLimit) : null,
    overdueInvoices,
    overdueAmount: sum(overdueInvoices.map((i) => i.outstanding)),
    lastPaymentDate: lastReceipt?.receiptDate ?? null,
    lastPaymentAmount: lastReceipt ? money(lastReceipt.amount) : null,
  };
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

  // One grouped query for every customer's ledger balance, not
  // customerReceivable() per customer (which was 2 queries each — the account
  // map lookup plus the line fetch). Same account, party and status filter.
  const map = await loadAccountMap(db);
  const arAccountId = requireAccount(map, "AR_TRADE");
  const grouped = await db.journalLine.groupBy({
    by: ["partyId"],
    where: {
      accountId: arAccountId,
      partyType: "CUSTOMER",
      entry: { status: { not: "DRAFT" } },
    },
    _sum: { debit: true, credit: true },
  });
  const ledgerByCustomer = new Map(
    grouped.map((g) => [g.partyId, sub(g._sum.debit, g._sum.credit)]),
  );

  const rows: ReconciliationRow[] = [];
  for (const c of customers) {
    const ledger = ledgerByCustomer.get(c.id) ?? money(0);
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

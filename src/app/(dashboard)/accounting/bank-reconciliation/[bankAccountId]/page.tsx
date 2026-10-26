import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { reconciliationSummary } from "@/lib/accounting/bank-reconciliation";
import { toAmountString } from "@/lib/accounting/money";
import { PageHeader } from "@/components/layout/page-header";
import { ReconciliationWorkspace } from "./reconciliation-workspace";
import type { StatementColumnMap } from "../actions";

export const dynamic = "force-dynamic";

export default async function BankReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ bankAccountId: string }>;
  searchParams: Promise<{ asOf?: string; statementClosingBalance?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";

  const { bankAccountId } = await params;
  const { asOf, statementClosingBalance } = await searchParams;
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const bank = await prisma.bankAccount.findUnique({ where: { id: bankAccountId }, include: { ledgerAccount: { select: { id: true, code: true } } } });
  if (!bank) notFound();

  const [summary, unmatchedLines, unmatchedJournalLines, matchedLines, ignoredLines, batches, expenseAccounts, incomeAccounts] = await Promise.all([
    reconciliationSummary({ bankAccountId, asOfDate, statementClosingBalance: statementClosingBalance || undefined }),
    prisma.bankStatementLine.findMany({ where: { bankAccountId, status: "UNMATCHED" }, orderBy: { txnDate: "asc" } }),
    prisma.journalLine.findMany({
      where: { accountId: bank.ledgerAccountId, entry: { status: "POSTED" }, matchedByStatementLine: null },
      select: { id: true, debit: true, credit: true, entry: { select: { entryDate: true, entryNumber: true, narration: true } } },
      orderBy: { entry: { entryDate: "asc" } },
    }),
    prisma.bankStatementLine.findMany({
      where: { bankAccountId, status: "MATCHED" },
      orderBy: { matchedAt: "desc" },
      take: 25,
      include: { matchedBy: { select: { name: true } }, matchedJournalLine: { select: { entry: { select: { entryNumber: true, narration: true } } } } },
    }),
    prisma.bankStatementLine.findMany({ where: { bankAccountId, status: "IGNORED" }, orderBy: { txnDate: "asc" } }),
    prisma.bankStatementLine.groupBy({
      by: ["importBatch"],
      where: { bankAccountId },
      _count: { _all: true },
      _min: { txnDate: true, createdAt: true },
      _max: { txnDate: true },
    }),
    prisma.ledgerAccount.findMany({ where: { type: "EXPENSE", isPostable: true, isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.ledgerAccount.findMany({ where: { type: "INCOME", isPostable: true, isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
  ]);

  const matchedCountByBatch = await prisma.bankStatementLine.groupBy({
    by: ["importBatch"],
    where: { bankAccountId, status: "MATCHED" },
    _count: { _all: true },
  });
  const matchedByBatch = new Map(matchedCountByBatch.map((b) => [b.importBatch, b._count._all]));

  return (
    <div className="space-y-6">
      <PageHeader
        title={bank.displayName}
        subtitle={`${bank.ledgerAccount.code} — book balance ${toAmountString(summary.bookBalance)} as of ${asOfDate.toLocaleDateString("en-IN")}.`}
      />

      <ReconciliationWorkspace
        bankAccountId={bankAccountId}
        asOf={asOf ?? asOfDate.toISOString().slice(0, 10)}
        statementClosingBalance={statementClosingBalance ?? ""}
        summary={{
          bookBalance: toAmountString(summary.bookBalance),
          statementOnlyDeposits: toAmountString(summary.statementOnlyDeposits),
          statementOnlyWithdrawals: toAmountString(summary.statementOnlyWithdrawals),
          bookOnlyDeposits: toAmountString(summary.bookOnlyDeposits),
          bookOnlyWithdrawals: toAmountString(summary.bookOnlyWithdrawals),
          adjustedBookBalance: toAmountString(summary.adjustedBookBalance),
          adjustedStatementBalance: summary.adjustedStatementBalance ? toAmountString(summary.adjustedStatementBalance) : null,
        }}
        columnMap={(bank.statementColumnMap as StatementColumnMap | null) ?? null}
        unmatchedLines={unmatchedLines.map((l) => ({
          id: l.id,
          txnDate: l.txnDate.toISOString().slice(0, 10),
          description: l.description,
          reference: l.reference,
          withdrawal: toAmountString(l.withdrawal),
          deposit: toAmountString(l.deposit),
        }))}
        unmatchedJournalLines={unmatchedJournalLines.map((l) => ({
          id: l.id,
          entryDate: l.entry.entryDate.toISOString().slice(0, 10),
          entryNumber: l.entry.entryNumber,
          narration: l.entry.narration,
          debit: toAmountString(l.debit),
          credit: toAmountString(l.credit),
        }))}
        matchedLines={matchedLines.map((l) => ({
          id: l.id,
          txnDate: l.txnDate.toISOString().slice(0, 10),
          description: l.description,
          withdrawal: toAmountString(l.withdrawal),
          deposit: toAmountString(l.deposit),
          matchedByName: l.matchedBy?.name ?? "—",
          journalEntryNumber: l.matchedJournalLine?.entry.entryNumber ?? "—",
        }))}
        ignoredLines={ignoredLines.map((l) => ({
          id: l.id,
          txnDate: l.txnDate.toISOString().slice(0, 10),
          description: l.description,
          withdrawal: toAmountString(l.withdrawal),
          deposit: toAmountString(l.deposit),
        }))}
        batches={batches.map((b) => ({
          importBatch: b.importBatch,
          rows: b._count._all,
          matched: matchedByBatch.get(b.importBatch) ?? 0,
          from: b._min.txnDate ? b._min.txnDate.toISOString().slice(0, 10) : "",
          to: b._max.txnDate ? b._max.txnDate.toISOString().slice(0, 10) : "",
          importedAt: b._min.createdAt ? b._min.createdAt.toISOString() : "",
        }))}
        expenseAccounts={expenseAccounts}
        incomeAccounts={incomeAccounts}
        canWrite={canWrite}
      />
    </div>
  );
}

import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { NewExpenseForm } from "./new-expense-form";

export default async function NewExpensePage() {
  const user = await requireUser();
  assertCan(user.role, "expenses", "write");

  const [categories, paymentAccounts] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { type: "EXPENSE", isPostable: true, isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.ledgerAccount.findMany({
      where: { type: "ASSET", isPostable: true, isActive: true, code: { in: ["1110", "1121"] } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Submit Expense" subtitle="Submits for approval — nothing posts to the ledger until approved." />
      <NewExpenseForm categories={categories} paymentAccounts={paymentAccounts} />
    </div>
  );
}

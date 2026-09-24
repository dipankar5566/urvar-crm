import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { MovementForm } from "./movement-form";

export const dynamic = "force-dynamic";

export default async function NewCashBankMovementPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const bankGroup = await prisma.ledgerAccount.findUnique({ where: { code: "1120" } });
  const [bankAccounts, expenseAccounts, incomeAccounts] = await Promise.all([
    bankGroup
      ? prisma.ledgerAccount.findMany({
          where: { parentId: bankGroup.id, isPostable: true, isActive: true },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
        })
      : [],
    prisma.ledgerAccount.findMany({
      where: { type: "EXPENSE", isPostable: true, isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.ledgerAccount.findMany({
      where: { type: "INCOME", isPostable: true, isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  const [defaultExpense, defaultIncome] = await Promise.all([
    prisma.ledgerAccount.findUnique({ where: { code: "5490" }, select: { id: true } }),
    prisma.ledgerAccount.findUnique({ where: { code: "4900" }, select: { id: true } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Record Cash / Bank Movement"
        subtitle="Deposits, withdrawals, transfers, bank charges, interest, and physical cash-count corrections."
      />
      <MovementForm
        bankAccounts={bankAccounts}
        expenseAccounts={expenseAccounts}
        incomeAccounts={incomeAccounts}
        defaultExpenseAccountId={defaultExpense?.id ?? expenseAccounts[0]?.id ?? ""}
        defaultIncomeAccountId={defaultIncome?.id ?? incomeAccounts[0]?.id ?? ""}
      />
    </div>
  );
}

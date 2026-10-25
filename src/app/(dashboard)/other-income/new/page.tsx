import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { NewOtherIncomeForm } from "./new-other-income-form";

export default async function NewOtherIncomePage() {
  const user = await requireUser();
  assertCan(user.role, "otherIncome", "write");

  const [categories, depositAccounts] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { type: "INCOME", isPostable: true, isActive: true },
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
      <PageHeader
        title="Record Income"
        subtitle="Miscellaneous income that isn't a sale — scrap sold, bank interest, a one-off service charge."
      />
      <NewOtherIncomeForm categories={categories} depositAccounts={depositAccounts} />
    </div>
  );
}

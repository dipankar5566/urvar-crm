import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { NewLoanForm } from "./new-loan-form";

export const dynamic = "force-dynamic";

export default async function NewLoanPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const cashAndBankAccounts = await prisma.ledgerAccount.findMany({
    where: {
      isPostable: true,
      isActive: true,
      OR: [{ code: "1110" }, { parent: { code: "1120" } }],
    },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Loan"
        subtitle="Records the disbursement and creates this loan's own account under 2220 Loan Accounts."
      />
      <NewLoanForm cashAndBankAccounts={cashAndBankAccounts} />
    </div>
  );
}

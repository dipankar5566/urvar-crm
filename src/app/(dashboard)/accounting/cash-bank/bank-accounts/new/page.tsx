import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { BankAccountForm } from "./bank-account-form";

export const dynamic = "force-dynamic";

export default async function NewBankAccountPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  // Bank ledgers under 1120 that carry no details yet — they can be attached
  // to instead of minting a new ledger (their balances are never re-posted).
  const bankGroup = await prisma.ledgerAccount.findUnique({ where: { code: "1120" } });
  const unlinkedLedgers = bankGroup
    ? await prisma.ledgerAccount.findMany({
        where: { parentId: bankGroup.id, isPostable: true, isActive: true, bankAccount: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add Bank Account"
        subtitle="A new bank gets its own ledger under 1120; its opening balance posts against Opening Balance Equity."
      />
      <BankAccountForm unlinkedLedgers={unlinkedLedgers} />
    </div>
  );
}

import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { ManualEntryForm } from "./manual-entry-form";

export const dynamic = "force-dynamic";

export default async function NewJournalEntryPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const [accounts, customers, suppliers] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { isPostable: true, isActive: true },
      select: { id: true, code: true, name: true, type: true },
      orderBy: { code: "asc" },
    }),
    prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Journal Entry"
        subtitle="A raw double-entry posting for anything not covered by a guided form. Debits must equal credits exactly."
      />
      <ManualEntryForm accounts={accounts} customers={customers} suppliers={suppliers} />
    </div>
  );
}

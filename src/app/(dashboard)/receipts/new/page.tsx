import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can, scopedWhere } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { RecordReceiptForm } from "./record-receipt-form";

export default async function NewReceiptPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const customerScope = can(user.role, "customers", "read");
  const [customers, bankAccounts] = await Promise.all([
    prisma.customer.findMany({
      where: scopedWhere(customerScope, user, "assignedToId", { deletedAt: null }),
      select: { id: true, name: true, customerNumber: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.ledgerAccount.findMany({
      // Cash on Hand plus every bank account under 1120 — not a hardcoded pair,
      // so a settlement account like 1122 can receive money too. Same set
      // recordReceipt() enforces server-side.
      where: {
        type: "ASSET",
        isPostable: true,
        isActive: true,
        OR: [{ code: "1110" }, { parent: { code: "1120" } }],
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Record Receipt" subtitle="Money received from a customer." />
      <RecordReceiptForm customers={customers} depositAccounts={bankAccounts} />
    </div>
  );
}

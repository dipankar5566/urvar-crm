import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { RecordSupplierPaymentForm } from "./record-supplier-payment-form";

export default async function NewSupplierPaymentPage() {
  const user = await requireUser();
  assertCan(user.role, "purchases", "write");

  const [suppliers, paymentAccounts] = await Promise.all([
    prisma.supplier.findMany({
      where: { isActive: true },
      select: { id: true, name: true, supplierCode: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.ledgerAccount.findMany({
      // Cash, every bank under 1120 (not just 1121 — banks added on the Bank
      // Accounts screen must be payable from), and 2165 Unwithdrawn Cheques for a
      // cheque the bank has not cleared yet.
      where: {
        isPostable: true,
        isActive: true,
        OR: [{ code: "1110" }, { code: "2165" }, { type: "ASSET", parent: { code: "1120" } }],
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Record Supplier Payment" subtitle="Money paid to a supplier." />
      <RecordSupplierPaymentForm suppliers={suppliers} paymentAccounts={paymentAccounts} />
    </div>
  );
}

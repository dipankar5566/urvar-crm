import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { NewAssetForm } from "./new-asset-form";

export const dynamic = "force-dynamic";

export default async function NewFixedAssetPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const assetGroup = await prisma.ledgerAccount.findUnique({ where: { code: "1200" } });
  const [assetCategories, cashAndBankAccounts, eligibleInvoices] = await Promise.all([
    assetGroup
      ? prisma.ledgerAccount.findMany({
          where: { parentId: assetGroup.id, isPostable: true, isActive: true },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
        })
      : [],
    prisma.ledgerAccount.findMany({
      where: { isPostable: true, isActive: true, OR: [{ code: "1110" }, { parent: { code: "1120" } }] },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.purchaseInvoice.findMany({
      where: { status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] }, capitalizedAsset: null },
      select: { id: true, invoiceNumber: true, subtotal: true, supplier: { select: { name: true } } },
      orderBy: { invoiceDate: "desc" },
      take: 100,
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Fixed Asset"
        subtitle="Paid from cash/bank, or capitalised out of an already-posted purchase invoice."
      />
      <NewAssetForm
        assetCategories={assetCategories}
        cashAndBankAccounts={cashAndBankAccounts}
        eligibleInvoices={eligibleInvoices.map((inv) => ({
          id: inv.id,
          label: `${inv.invoiceNumber} — ${inv.supplier.name}`,
          subtotal: inv.subtotal.toFixed(2),
        }))}
      />
    </div>
  );
}

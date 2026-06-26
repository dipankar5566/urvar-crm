import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { CustomerForm } from "../../customer-form";

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "customers", "write");

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!customer) notFound();

  const canAssign = scope === "all" || scope === "territory";
  const reps = canAssign
    ? await prisma.user.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Edit Customer" subtitle={customer.customerNumber} />
      <CustomerForm
        customerId={customer.id}
        reps={reps}
        canAssign={canAssign}
        currentUserId={user.id}
        initialValues={{
          name: customer.name,
          companyName: customer.companyName ?? "",
          contactPerson: customer.contactPerson ?? "",
          customerType: customer.customerType,
          phone: customer.phone,
          whatsapp: customer.whatsapp ?? "",
          email: customer.email ?? "",
          state: customer.state,
          district: customer.district,
          pincode: customer.pincode ?? "",
          address: customer.address ?? "",
          gstNumber: customer.gstNumber ?? "",
          panNumber: customer.panNumber ?? "",
          creditLimit: customer.creditLimit?.toString() ?? "",
          outstandingAmount: customer.outstandingAmount.toString(),
          dealerTier: customer.dealerTier ?? "",
          territoryAssigned: customer.territoryAssigned ?? "",
          annualTargetValue: customer.annualTargetValue?.toString() ?? "",
          assignedToId: customer.assignedToId ?? "",
        }}
      />
    </div>
  );
}

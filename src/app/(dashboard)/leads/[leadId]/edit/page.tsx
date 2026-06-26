import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { LeadForm } from "../../lead-form";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "leads", "write");

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
  });
  if (!lead) notFound();

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
      <PageHeader title="Edit Lead" subtitle={lead.leadNumber} />
      <LeadForm
        leadId={lead.id}
        reps={reps}
        canAssign={canAssign}
        currentUserId={user.id}
        initialValues={{
          name: lead.name,
          companyName: lead.companyName ?? "",
          contactPerson: lead.contactPerson ?? "",
          phone: lead.phone,
          whatsapp: lead.whatsapp ?? "",
          email: lead.email ?? "",
          state: lead.state,
          district: lead.district,
          pincode: lead.pincode ?? "",
          address: lead.address ?? "",
          source: lead.source,
          customerType: lead.customerType,
          interestedProducts: lead.interestedProducts ?? "",
          expectedQuantity: lead.expectedQuantity ?? "",
          expectedMonthlyValue: lead.expectedMonthlyValue?.toString() ?? "",
          estimatedValue: lead.estimatedValue?.toString() ?? "",
          cropInterest: lead.cropInterest ?? "",
          isGovernmentTender: lead.isGovernmentTender,
          remarks: lead.remarks ?? "",
          assignedToId: lead.assignedToId ?? "",
        }}
      />
    </div>
  );
}

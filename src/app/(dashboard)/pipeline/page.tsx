import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { KanbanBoard, type KanbanLead } from "./kanban-board";

export default async function PipelinePage() {
  const user = await requireUser();
  const scope = can(user.role, "pipeline", "read");
  const showAssignee = scope === "all" || scope === "territory";

  const leads = await prisma.lead.findMany({
    where: {
      ...scopeWhere(scope, user, "assignedToId"),
      pipeline: { isNot: null },
    },
    include: {
      pipeline: true,
      assignedTo: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const kanbanLeads: KanbanLead[] = leads
    .filter((l) => l.pipeline)
    .map((l) => ({
      id: l.id,
      name: l.name,
      companyName: l.companyName,
      estimatedValue: l.estimatedValue ? Number(l.estimatedValue) : null,
      state: l.state,
      district: l.district,
      stage: l.pipeline!.stage,
      assignedToName: l.assignedTo?.name ?? null,
      isGovernmentTender: l.isGovernmentTender,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        subtitle={`Drag a card to move it through the sales funnel. ${kanbanLeads.length} active deal${kanbanLeads.length === 1 ? "" : "s"}.`}
      />

      <div className="flex border-b">
        <Link
          href="/leads"
          className="px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          Table
        </Link>
        <span className="-mb-px border-b-2 border-brand px-3 py-1.5 text-[13px] font-medium text-foreground">
          Board
        </span>
      </div>

      <KanbanBoard initialLeads={kanbanLeads} showAssignee={showAssignee} />
    </div>
  );
}

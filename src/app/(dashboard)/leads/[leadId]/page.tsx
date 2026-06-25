import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Pencil } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { initialsOf, colorFor } from "@/lib/avatar";
import {
  LEAD_SOURCE_LABELS,
  CUSTOMER_TYPE_LABELS,
  PIPELINE_STAGE_LABELS,
  inr,
} from "@/lib/constants/labels";
import { LeadActivityTimeline } from "./lead-activity-timeline";
import { LeadStatusForm } from "./lead-status-form";
import { ConvertButton } from "./convert-button";
import { LogCallDialog } from "./log-call-dialog";
import { CallButton } from "./call-button";
import { ScheduleFollowUpDialog } from "./schedule-follow-up-dialog";
import { TaskForm } from "../../tasks/task-form";

function Property({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="w-28 shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "leads", "read");

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(scope, user, "assignedToId") },
    include: {
      assignedTo: { select: { id: true, name: true } },
      pipeline: true,
      activities: {
        orderBy: { createdAt: "desc" },
        include: { createdBy: { select: { name: true } } },
      },
      convertedCustomer: { select: { customerNumber: true } },
    },
  });

  if (!lead) notFound();

  const canWrite = can(user.role, "leads", "write") !== "none";
  const canLogCalls = can(user.role, "calls", "write") !== "none";
  const canScheduleFollowUps = can(user.role, "followups", "write") !== "none";
  const canCreateTasks = can(user.role, "tasks", "write") !== "none";
  const taskAssignScope = can(user.role, "tasks", "write");
  const reps =
    canCreateTasks && taskAssignScope === "all"
      ? await prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-bold text-white"
            style={{ background: colorFor(lead.name) }}
          >
            {initialsOf(lead.name)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{lead.name}</h1>
              <Badge variant="secondary">{lead.leadNumber}</Badge>
              {lead.isGovernmentTender && (
                <Badge variant="outline">Govt. Tender</Badge>
              )}
            </div>
            {lead.companyName && (
              <p className="text-sm text-muted-foreground">{lead.companyName}</p>
            )}
          </div>
        </div>
        {canWrite && (
          <Button variant="outline" size="sm" render={<Link href={`/leads/${lead.id}/edit`} />}>
            <Pencil /> Edit Lead
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
        <Card className="overflow-hidden p-0">
          <CardHeader className="border-b py-2.5">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Properties
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y p-0">
            <Property label="Status">
              {canWrite ? (
                <LeadStatusForm
                  leadId={lead.id}
                  currentStatus={lead.status}
                  currentLostReason={lead.lostReason}
                />
              ) : (
                <StatusBadge status={lead.status} />
              )}
            </Property>
            <Property label="Type">
              {CUSTOMER_TYPE_LABELS[lead.customerType] ?? lead.customerType}
            </Property>
            <Property label="Source">
              {LEAD_SOURCE_LABELS[lead.source] ?? lead.source}
            </Property>
            <Property label="Est. Value">
              <span className="font-medium">
                {inr(lead.estimatedValue ? Number(lead.estimatedValue) : null)}
              </span>
            </Property>
            <Property label="State">{lead.state}</Property>
            <Property label="District">
              {lead.district}
              {lead.pincode ? ` – ${lead.pincode}` : ""}
            </Property>
            <Property label="Phone">
              <span className="text-brand">{lead.phone}</span>
            </Property>
            {lead.email && (
              <Property label="Email">
                <span className="truncate text-brand">{lead.email}</span>
              </Property>
            )}
            {lead.cropInterest && (
              <Property label="Crop Interest">{lead.cropInterest}</Property>
            )}
            <Property label="Assigned To">
              {lead.assignedTo?.name ?? "Unassigned"}
            </Property>
            <Property label="Created">
              {format(lead.createdAt, "d MMM yyyy")}
            </Property>
          </CardContent>
        </Card>

        {(lead.interestedProducts || lead.remarks) && (
          <Card>
            <CardContent className="space-y-3 pt-4 text-sm">
              {lead.interestedProducts && (
                <div>
                  <p className="text-xs font-medium text-foreground">Interested Products</p>
                  <p className="text-muted-foreground">{lead.interestedProducts}</p>
                </div>
              )}
              {lead.remarks && (
                <div>
                  <p className="text-xs font-medium text-foreground">Remarks</p>
                  <p className="text-muted-foreground">{lead.remarks}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {(lead.pipeline || canWrite) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pipeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {lead.pipeline && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Pipeline Stage
                  </p>
                  <Link href="/pipeline" className="hover:underline">
                    <Badge variant="secondary">
                      {PIPELINE_STAGE_LABELS[lead.pipeline.stage] ?? lead.pipeline.stage}
                    </Badge>
                  </Link>
                </div>
              )}
              {canWrite && (
                <div>
                  <ConvertButton
                    leadId={lead.id}
                    alreadyConverted={!!lead.convertedAt}
                  />
                  {lead.convertedCustomer && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Customer: {lead.convertedCustomer.customerNumber}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {(canLogCalls || canScheduleFollowUps || canCreateTasks) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {canLogCalls && <CallButton leadId={lead.id} leadName={lead.name} />}
              {canLogCalls && <LogCallDialog leadId={lead.id} />}
              {canScheduleFollowUps && <ScheduleFollowUpDialog leadId={lead.id} />}
              {canCreateTasks && (
                <TaskForm
                  reps={reps}
                  canAssign={taskAssignScope === "all"}
                  currentUserId={user.id}
                  relatedLeadId={lead.id}
                  triggerLabel="Add Task"
                  triggerVariant="outline"
                />
              )}
            </CardContent>
          </Card>
        )}
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Activity Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <LeadActivityTimeline leadId={lead.id} activities={lead.activities} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

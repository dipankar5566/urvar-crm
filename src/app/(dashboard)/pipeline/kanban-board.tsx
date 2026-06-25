"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { PIPELINE_STAGE_LABELS, PIPELINE_STAGE_ORDER, inr } from "@/lib/constants/labels";
import { initialsOf, colorFor } from "@/lib/avatar";
import { updateLeadStage } from "../leads/actions";

export type KanbanLead = {
  id: string;
  name: string;
  companyName: string | null;
  estimatedValue: number | null;
  state: string;
  district: string;
  stage: string;
  assignedToName: string | null;
  isGovernmentTender: boolean;
};

export function KanbanBoard({
  initialLeads,
  showAssignee,
}: {
  initialLeads: KanbanLead[];
  showAssignee: boolean;
}) {
  const router = useRouter();
  const [leads, setLeads] = useState(initialLeads);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const leadId = active.id as string;
    const toStage = over.id as string;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stage === toStage) return;

    const prevStage = lead.stage;
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, stage: toStage } : l)),
    );

    updateLeadStage(leadId, toStage).then((result) => {
      if ("error" in result) {
        toast.error(result.error);
        setLeads((prev) =>
          prev.map((l) => (l.id === leadId ? { ...l, stage: prevStage } : l)),
        );
        return;
      }
      router.refresh();
    });
  }

  const activeLead = activeId ? leads.find((l) => l.id === activeId) : null;

  return (
    <DndContext
      id="pipeline-kanban"
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4">
        {PIPELINE_STAGE_ORDER.map((stage) => {
          const stageLeads = leads.filter((l) => l.stage === stage);
          const totalValue = stageLeads.reduce(
            (sum, l) => sum + (l.estimatedValue ?? 0),
            0,
          );
          return (
            <KanbanColumn
              key={stage}
              stage={stage}
              leads={stageLeads}
              totalValue={totalValue}
              showAssignee={showAssignee}
            />
          );
        })}
      </div>
      <DragOverlay>
        {activeLead ? (
          <LeadCard lead={activeLead} showAssignee={showAssignee} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function KanbanColumn({
  stage,
  leads,
  totalValue,
  showAssignee,
}: {
  stage: string;
  leads: KanbanLead[];
  totalValue: number;
  showAssignee: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-64 shrink-0 flex-col rounded-lg border bg-muted/30 transition-colors",
        isOver && "border-primary bg-primary/5",
      )}
    >
      <div className="border-b px-3 py-2">
        <p className="text-sm font-medium">
          {PIPELINE_STAGE_LABELS[stage] ?? stage}
        </p>
        <p className="text-xs text-muted-foreground">
          {leads.length} · {inr(totalValue)}
        </p>
      </div>
      <div className="flex min-h-24 flex-1 flex-col gap-2 p-2">
        {leads.map((lead) => (
          <DraggableCard key={lead.id} lead={lead} showAssignee={showAssignee} />
        ))}
        {leads.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Drop a lead here
          </p>
        )}
      </div>
    </div>
  );
}

function DraggableCard({
  lead,
  showAssignee,
}: {
  lead: KanbanLead;
  showAssignee: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn("cursor-grab touch-none", isDragging && "opacity-30")}
    >
      <LeadCard lead={lead} showAssignee={showAssignee} />
    </div>
  );
}

function LeadCard({
  lead,
  showAssignee,
}: {
  lead: KanbanLead;
  showAssignee: boolean;
}) {
  return (
    <Link
      href={`/leads/${lead.id}`}
      onClick={(e) => e.stopPropagation()}
      className="block rounded-lg border bg-card p-2.5 text-sm shadow-sm hover:border-foreground/20"
    >
      <p className="font-medium leading-snug">{lead.name}</p>
      {lead.companyName && (
        <p className="truncate text-xs text-muted-foreground">
          {lead.companyName}
        </p>
      )}
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{lead.district}, {lead.state}</span>
        {lead.isGovernmentTender && (
          <Badge variant="outline" className="text-[10px]">
            Tender
          </Badge>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs">
        <span className="font-medium">{inr(lead.estimatedValue)}</span>
        <div className="flex items-center gap-1.5">
          {showAssignee && lead.assignedToName && (
            <span className="text-muted-foreground">{lead.assignedToName}</span>
          )}
          <div
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white"
            style={{ background: colorFor(lead.name) }}
          >
            {initialsOf(lead.name)}
          </div>
        </div>
      </div>
    </Link>
  );
}

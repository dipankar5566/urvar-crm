"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  StickyNote,
  ArrowRightLeft,
  KanbanSquare,
  Phone,
  CalendarClock,
  CheckCircle2,
  ListChecks,
  FileText,
  Send,
  UserPlus,
  Trophy,
  Paperclip,
  Mail,
  MessageCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants/labels";
import { addLeadNote } from "../actions";

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  NOTE: StickyNote,
  STATUS_CHANGE: ArrowRightLeft,
  STAGE_CHANGE: KanbanSquare,
  CALL_LOGGED: Phone,
  FOLLOWUP_LOGGED: CalendarClock,
  FOLLOWUP_COMPLETED: CheckCircle2,
  TASK_CREATED: ListChecks,
  QUOTATION_CREATED: FileText,
  QUOTATION_SENT: Send,
  LEAD_ASSIGNED: UserPlus,
  LEAD_CONVERTED: Trophy,
  FILE_ATTACHED: Paperclip,
  EMAIL_SENT: Mail,
  WHATSAPP_SENT: MessageCircle,
};

type Activity = {
  id: string;
  type: string;
  description: string;
  createdAt: Date;
  createdBy: { name: string };
};

export function LeadActivityTimeline({
  leadId,
  activities,
}: {
  leadId: string;
  activities: Activity[];
}) {
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  function submitNote(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    startTransition(async () => {
      const result = await addLeadNote(leadId, note);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setNote("");
      toast.success("Note added");
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submitNote} className="space-y-2">
        <Textarea
          placeholder="Add a note about this lead…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending || !note.trim()}>
            {pending ? "Adding…" : "Add Note"}
          </Button>
        </div>
      </form>

      <div className="space-y-4">
        {activities.length === 0 && (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        )}
        {activities.map((activity) => {
          const Icon = ACTIVITY_ICONS[activity.type] ?? StickyNote;
          return (
            <div key={activity.id} className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="flex-1 space-y-0.5 border-b pb-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {ACTIVITY_TYPE_LABELS[activity.type] ?? activity.type}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(activity.createdAt), "d MMM yyyy, h:mm a")}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {activity.description}
                </p>
                <p className="text-xs text-muted-foreground">
                  by {activity.createdBy.name}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

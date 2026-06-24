"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckIcon, CalendarClockIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { completeFollowUp, cancelFollowUp, rescheduleFollowUp } from "./actions";

export function FollowUpRowActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [newDueAt, setNewDueAt] = useState("");

  function complete() {
    startTransition(async () => {
      const result = await completeFollowUp(id);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Follow-up completed");
      router.refresh();
    });
  }

  function cancel() {
    startTransition(async () => {
      const result = await cancelFollowUp(id);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Follow-up cancelled");
      router.refresh();
    });
  }

  function reschedule() {
    if (!newDueAt) return;
    startTransition(async () => {
      const result = await rescheduleFollowUp(id, { dueAt: newDueAt });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Follow-up rescheduled");
      setRescheduleOpen(false);
      setNewDueAt("");
      router.refresh();
    });
  }

  return (
    <div className="flex justify-end gap-1">
      <Button size="icon-sm" variant="ghost" onClick={complete} disabled={pending} title="Complete">
        <CheckIcon />
      </Button>
      <Dialog open={rescheduleOpen} onOpenChange={setRescheduleOpen}>
        <DialogTrigger render={<Button size="icon-sm" variant="ghost" title="Reschedule" />}>
          <CalendarClockIcon />
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reschedule Follow-up</DialogTitle>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={newDueAt}
            onChange={(e) => setNewDueAt(e.target.value)}
          />
          <DialogFooter>
            <Button onClick={reschedule} disabled={pending || !newDueAt}>
              {pending ? "Saving…" : "Reschedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button size="icon-sm" variant="ghost" onClick={cancel} disabled={pending} title="Cancel">
        <XIcon />
      </Button>
    </div>
  );
}

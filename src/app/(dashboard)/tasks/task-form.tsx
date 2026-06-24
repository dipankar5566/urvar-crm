"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TASK_PRIORITY_LABELS } from "@/lib/constants/labels";
import { createTask } from "./actions";

type RepOption = { id: string; name: string };

export function TaskForm({
  reps,
  canAssign,
  currentUserId,
  relatedLeadId,
  triggerLabel = "New Task",
  triggerVariant = "default",
}: {
  reps: RepOption[];
  canAssign: boolean;
  currentUserId: string;
  relatedLeadId?: string;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedToId, setAssignedToId] = useState(currentUserId);
  const [priority, setPriority] = useState("MEDIUM");
  const [dueAt, setDueAt] = useState("");

  function submit() {
    if (!title.trim()) return;
    startTransition(async () => {
      const result = await createTask(
        { title, description, assignedToId, priority, dueAt },
        relatedLeadId,
      );
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Task created");
      setOpen(false);
      setTitle("");
      setDescription("");
      setDueAt("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size="sm" variant={triggerVariant} className={relatedLeadId ? "w-full" : ""} />}
      >
        <ListPlus /> {triggerLabel}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            {canAssign ? (
              <Select value={assignedToId} onValueChange={(v) => setAssignedToId(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Assign to" />
                </SelectTrigger>
                <SelectContent>
                  {reps.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input value="Myself" disabled />
            )}
            <Select value={priority} onValueChange={(v) => setPriority(v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !title.trim()}>
            {pending ? "Creating…" : "Create Task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

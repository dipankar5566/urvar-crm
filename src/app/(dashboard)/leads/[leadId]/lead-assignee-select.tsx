"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateLeadAssignee } from "../actions";

const UNASSIGNED = "UNASSIGNED";

export function LeadAssigneeSelect({
  leadId,
  assignedToId,
  reps,
}: {
  leadId: string;
  assignedToId: string | null;
  reps: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Base UI's <Select.Value> only resolves a label when the Root is given an
  // explicit `items` map — otherwise it renders the raw `value` (here, a cuid).
  const items: Record<string, string> = { [UNASSIGNED]: "Unassigned" };
  for (const r of reps) items[r.id] = r.name;

  function onChange(value: string) {
    startTransition(async () => {
      const result = await updateLeadAssignee(
        leadId,
        value === UNASSIGNED ? null : value,
      );
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Select
      items={items}
      value={assignedToId ?? UNASSIGNED}
      onValueChange={(v) => onChange(v as string)}
      disabled={pending}
    >
      <SelectTrigger size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {reps.map((r) => (
          <SelectItem key={r.id} value={r.id}>
            {r.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

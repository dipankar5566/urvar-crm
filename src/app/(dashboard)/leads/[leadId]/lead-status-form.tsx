"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LEAD_STATUS_LABELS } from "@/lib/constants/labels";
import { updateLeadStatus } from "../actions";

export function LeadStatusForm({
  leadId,
  currentStatus,
  currentLostReason,
}: {
  leadId: string;
  currentStatus: string;
  currentLostReason: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [lostReason, setLostReason] = useState(currentLostReason ?? "");
  const [pending, startTransition] = useTransition();

  const dirty = status !== currentStatus || (status === "LOST" && lostReason !== (currentLostReason ?? ""));

  function save() {
    startTransition(async () => {
      const result = await updateLeadStatus(leadId, { status, lostReason });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Status updated");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <Select value={status} onValueChange={(v) => setStatus(v as string)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {status === "LOST" && (
        <Input
          placeholder="Reason for losing this lead"
          value={lostReason}
          onChange={(e) => setLostReason(e.target.value)}
        />
      )}
      {dirty && (
        <Button size="sm" className="w-full" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Update Status"}
        </Button>
      )}
    </div>
  );
}

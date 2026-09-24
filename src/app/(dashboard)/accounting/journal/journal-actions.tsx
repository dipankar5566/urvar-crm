"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { reverseManualEntryAction } from "./actions";

/** Follows accounting/periods/period-actions.tsx's exact shape. */
export function ReverseEntryButton({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  function submit() {
    start(async () => {
      const result = await reverseManualEntryAction({ entryId, reason });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Entry reversed.");
        setOpen(false);
        setReason("");
        router.refresh();
      }
    });
  }

  if (!open) {
    return (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        Reverse
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        placeholder="Reason for reversal"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="h-7 w-48 rounded-md border border-input bg-background px-2 text-xs"
      />
      <Button size="xs" variant="destructive" disabled={pending || reason.trim().length < 3} onClick={submit}>
        {pending ? "Reversing…" : "Confirm"}
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

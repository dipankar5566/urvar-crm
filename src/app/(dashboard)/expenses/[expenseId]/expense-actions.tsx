"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { approveExpenseAction, rejectExpenseAction, cancelExpenseAction } from "../actions";

type Result = { error: string } | { success: true };

export function ExpenseActions({
  expenseId,
  mode,
  disabledSelfApprove,
}: {
  expenseId: string;
  mode: "approve" | "cancel";
  disabledSelfApprove?: boolean;
}) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<Result>, ok: string) =>
    start(async () => {
      const result = await fn();
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(ok);
        router.refresh();
      }
    });

  if (mode === "cancel") {
    return (
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogTrigger render={<Button size="sm" variant="outline" />}>
          Cancel
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this expense?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Reverses the ledger entry it posted. Use this for a mistaken approval, not a routine
            correction.
          </p>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelOpen(false)} disabled={pending}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={pending || reason.trim().length < 3}
              onClick={() => {
                run(() => cancelExpenseAction(expenseId, { reason }), "Expense cancelled.");
                setCancelOpen(false);
              }}
            >
              {pending ? "Cancelling…" : "Cancel Expense"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        disabled={pending || disabledSelfApprove}
        title={disabledSelfApprove ? "You cannot approve an expense you submitted yourself." : undefined}
        onClick={() => run(() => approveExpenseAction(expenseId), "Expense approved and posted.")}
      >
        {pending ? "Approving…" : "Approve"}
      </Button>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogTrigger render={<Button size="sm" variant="outline" disabled={pending} />}>
          Reject
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this expense?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Reason</Label>
            <Textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)} disabled={pending}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={pending || reason.trim().length < 3}
              onClick={() => {
                run(() => rejectExpenseAction(expenseId, { reason }), "Expense rejected.");
                setRejectOpen(false);
              }}
            >
              {pending ? "Rejecting…" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

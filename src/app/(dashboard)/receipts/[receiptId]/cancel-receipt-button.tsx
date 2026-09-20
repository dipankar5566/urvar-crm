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
import { cancelReceiptAction } from "../actions";

export function CancelReceiptButton({ receiptId }: { receiptId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Cancel Receipt
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this receipt?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The ledger entry is reversed and any invoice allocations are removed, reopening
          those invoices as unpaid or partially paid again.
        </p>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">Reason</Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this receipt being cancelled? (e.g. cheque bounced)"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Back
          </Button>
          <Button
            variant="destructive"
            disabled={pending || reason.trim().length < 3}
            onClick={() =>
              start(async () => {
                const result = await cancelReceiptAction(receiptId, { reason });
                if ("error" in result) {
                  toast.error(result.error);
                } else {
                  toast.success("Receipt cancelled.");
                  setOpen(false);
                  router.refresh();
                }
              })
            }
          >
            {pending ? "Cancelling…" : "Cancel Receipt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

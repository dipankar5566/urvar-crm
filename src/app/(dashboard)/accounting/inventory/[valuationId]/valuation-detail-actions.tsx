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
import {
  postStockValuationAction, cancelStockValuationAction, deleteStockValuationDraftAction,
} from "../actions";

export function PostValuationButton({ valuationId }: { valuationId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await postStockValuationAction(valuationId);
          if ("error" in result) {
            toast.error(result.error);
          } else {
            toast.success("Valuation posted to the ledger.");
            router.refresh();
          }
        })
      }
    >
      {pending ? "Posting…" : "Post to Ledger"}
    </Button>
  );
}

export function DeleteDraftButton({ valuationId }: { valuationId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await deleteStockValuationDraftAction(valuationId);
          if ("error" in result) {
            toast.error(result.error);
          } else {
            toast.success("Draft deleted.");
            router.push("/accounting/inventory");
          }
        })
      }
    >
      {pending ? "Deleting…" : "Delete Draft"}
    </Button>
  );
}

export function CancelValuationButton({ valuationId }: { valuationId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Cancel Valuation
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this valuation?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The ledger entry is reversed and the valuation is marked cancelled. Refused if a later
          period&apos;s valuation has already superseded it.
        </p>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">Reason</Label>
          <Textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
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
                const result = await cancelStockValuationAction(valuationId, { reason });
                if ("error" in result) {
                  toast.error(result.error);
                } else {
                  toast.success("Valuation cancelled.");
                  setOpen(false);
                  router.refresh();
                }
              })
            }
          >
            {pending ? "Cancelling…" : "Cancel Valuation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

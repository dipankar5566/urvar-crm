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
import { cancelPurchaseInvoiceAction } from "../actions";

export function CancelPurchaseInvoiceButton({ invoiceId }: { invoiceId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Cancel Invoice
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this purchase invoice?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The ledger entry is reversed and the invoice is marked cancelled. Refused while a
          payment is still allocated against it.
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
                const result = await cancelPurchaseInvoiceAction(invoiceId, { reason });
                if ("error" in result) {
                  toast.error(result.error);
                } else {
                  toast.success("Invoice cancelled.");
                  setOpen(false);
                  router.refresh();
                }
              })
            }
          >
            {pending ? "Cancelling…" : "Cancel Invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

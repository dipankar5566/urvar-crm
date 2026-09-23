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
import { verifyTaxRate } from "../actions";

export function TaxRateRowActions({
  taxRateId,
  hsnCode,
  ratePercent,
}: {
  taxRateId: string;
  hsnCode: string;
  ratePercent: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Verify
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify HSN {hsnCode} at {ratePercent}%?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Verifying asserts that a tax professional has confirmed this HSN classification and rate.
          Once verified, the tax engine will price every invoice line against this row — an incorrect
          rate cannot be silently corrected afterwards, since posted invoices are never re-priced.
        </p>
        <div className="space-y-2">
          <Label htmlFor="verify-note">Verification note</Label>
          <Textarea
            id="verify-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Confirmed with CA <name> on <date>: HSN 3101 correct for this product per GST schedule..."
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Back
          </Button>
          <Button
            disabled={pending || note.trim().length < 3}
            onClick={() =>
              start(async () => {
                const result = await verifyTaxRate(taxRateId, note);
                if ("error" in result) {
                  toast.error(result.error);
                } else {
                  toast.success(`HSN ${hsnCode} verified.`);
                  setOpen(false);
                  router.refresh();
                }
              })
            }
          >
            {pending ? "Verifying…" : "Verify"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

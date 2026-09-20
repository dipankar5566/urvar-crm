"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { createCreditNoteAction } from "../../credit-notes/actions";

const REASONS = [
  { value: "SALES_RETURN", label: "Sales return" },
  { value: "RATE_DIFFERENCE", label: "Rate difference" },
  { value: "SHORTAGE", label: "Shortage" },
  { value: "POST_SALE_DISCOUNT", label: "Post-sale discount" },
  { value: "CANCELLATION", label: "Cancellation" },
  { value: "OTHER", label: "Other" },
] as const;

type CreditableLine = {
  id: string;
  description: string;
  unit: string;
  remaining: string;
};

export function NewCreditNoteDialog({ invoiceId, lines }: { invoiceId: string; lines: CreditableLine[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const [noteDate, setNoteDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState<(typeof REASONS)[number]["value"]>("SALES_RETURN");
  const [narration, setNarration] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  function submit() {
    const submitLines = lines
      .filter((l) => (quantities[l.id] ?? "").trim() !== "")
      .map((l) => ({ invoiceItemId: l.id, quantity: quantities[l.id] }));

    start(async () => {
      const result = await createCreditNoteAction({ invoiceId, noteDate, reason, narration, lines: submitLines });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Credit note posted.");
        setOpen(false);
        router.push(`/credit-notes/${result.creditNoteId}`);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        New Credit Note
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Credit Note</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="noteDate">Date</Label>
            <Input id="noteDate" type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={(v) => v && setReason(v as typeof reason)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Remaining</TableHead>
                <TableHead>Credit Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm">{l.description}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{l.remaining} {l.unit}</TableCell>
                  <TableCell>
                    <Input
                      type="number" min="0" step="0.01" className="w-28"
                      placeholder="0"
                      value={quantities[l.id] ?? ""}
                      onChange={(e) => setQuantities((q) => ({ ...q, [l.id]: e.target.value }))}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-2">
          <Label htmlFor="narration">Narration (optional)</Label>
          <Textarea id="narration" value={narration} onChange={(e) => setNarration(e.target.value)} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={submit}>
            {pending ? "Posting…" : "Post Credit Note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { transferChequeAction, reopenChequeAction } from "./actions";

type BankOption = { id: string; code: string; name: string };

export function TransferChequeButton({
  chequeId,
  direction,
  banks,
}: {
  chequeId: string;
  direction: "RECEIVED" | "ISSUED";
  banks: BankOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [bankId, setBankId] = useState(banks[0]?.id ?? "");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [pending, start] = useTransition();
  const verb = direction === "RECEIVED" ? "Deposit" : "Withdraw";

  function submit() {
    start(async () => {
      const result = await transferChequeAction({ chequeId, bankLedgerAccountId: bankId, transferDate: date });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(direction === "RECEIVED" ? "Cheque deposited." : "Cheque cleared.");
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" />}>{verb}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{verb} cheque</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{direction === "RECEIVED" ? "Deposit into" : "Paid out of"}</Label>
            <Select value={bankId} onValueChange={(v) => setBankId(v ?? "")}>
              <SelectTrigger><SelectValue placeholder="Select bank account" /></SelectTrigger>
              <SelectContent>
                {banks.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.code} {b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cheque-date">{direction === "RECEIVED" ? "Deposit date" : "Clearing date"}</Label>
            <Input id="cheque-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button disabled={pending || !bankId} onClick={submit}>{pending ? "Saving…" : verb}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReopenChequeButton({ chequeId }: { chequeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const result = await reopenChequeAction({ chequeId, reason });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Cheque reopened.");
        setOpen(false);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Reopen</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen this cheque?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Reverses the bank entry and holds the cheque again. For a bounced cheque, reopen it and then cancel its receipt.
        </p>
        <div className="space-y-2">
          <Label htmlFor="reopen-reason">Reason</Label>
          <Textarea id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button variant="destructive" disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? "Reopening…" : "Reopen Cheque"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

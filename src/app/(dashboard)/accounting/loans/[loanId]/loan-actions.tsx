"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { recordLoanRepaymentAction, cancelLoanRepaymentAction, cancelLoanAction } from "../actions";

type AccountOption = { id: string; code: string; name: string };

export function RecordRepaymentForm({
  loanId,
  nextInstallmentNumber,
  cashAndBankAccounts,
}: {
  loanId: string;
  nextInstallmentNumber: number;
  cashAndBankAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [paidDate, setPaidDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paidFromAccountId, setPaidFromAccountId] = useState(cashAndBankAccounts[0]?.id ?? "");

  function submit() {
    if (!paidFromAccountId) return toast.error("Select which account this was paid from.");
    start(async () => {
      const result = await recordLoanRepaymentAction({
        loanId,
        installmentNumber: nextInstallmentNumber,
        paidDate,
        paidFromAccountId,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(`Instalment ${nextInstallmentNumber} recorded.`);
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Record instalment {nextInstallmentNumber}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3 items-end">
        <div className="space-y-2">
          <Label htmlFor="paidDate">Date paid</Label>
          <Input id="paidDate" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Paid from</Label>
          <Select value={paidFromAccountId} onValueChange={(v) => setPaidFromAccountId(v ?? "")}>
            <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
            <SelectContent>
              {cashAndBankAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record Instalment"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function CancelRepaymentButton({ repaymentId, loanId }: { repaymentId: string; loanId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const result = await cancelLoanRepaymentAction({ repaymentId, loanId, reason });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Instalment cancelled.");
        setOpen(false);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Cancel</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel this instalment?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Reverses its posting and makes the instalment number payable again.
        </p>
        <div className="space-y-2">
          <Label htmlFor="cancel-repayment-reason">Reason</Label>
          <Textarea id="cancel-repayment-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button variant="destructive" disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? "Cancelling…" : "Cancel Instalment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelLoanButton({ loanId }: { loanId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const result = await cancelLoanAction({ loanId, reason });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Loan cancelled.");
        setOpen(false);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>Cancel Loan</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel this loan?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Reverses the disbursement. Only possible when this loan has no repayments recorded against it.
        </p>
        <div className="space-y-2">
          <Label htmlFor="cancel-loan-reason">Reason</Label>
          <Textarea id="cancel-loan-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button variant="destructive" disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? "Cancelling…" : "Cancel Loan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import {
  recordLoanRepaymentAction,
  cancelLoanRepaymentAction,
  cancelLoanAction,
  recordLoanFeeAction,
  recordLoanTopUpAction,
  cancelLoanTransactionAction,
} from "../actions";

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

export function RecordLoanFeeForm({
  loanId,
  cashAndBankAccounts,
}: {
  loanId: string;
  cashAndBankAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [type, setType] = useState<"PROCESSING_FEE" | "CHARGES">("PROCESSING_FEE");
  const [txnDate, setTxnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState(cashAndBankAccounts[0]?.id ?? "");

  function submit() {
    if (!paymentAccountId) return toast.error("Select which account this was paid from.");
    start(async () => {
      const result = await recordLoanFeeAction({ loanId, type, txnDate, amount: Number(amount), paymentAccountId });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(type === "PROCESSING_FEE" ? "Processing fee recorded." : "Charge recorded.");
        setAmount("");
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Record a fee or charge</CardTitle></CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-4 items-end">
        <div className="space-y-2">
          <Label>Type</Label>
          <Select value={type} onValueChange={(v) => setType((v as typeof type) ?? "PROCESSING_FEE")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="PROCESSING_FEE">Processing fee</SelectItem>
              <SelectItem value="CHARGES">Charges</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="feeDate">Date</Label>
          <Input id="feeDate" type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="feeAmount">Amount</Label>
          <Input id="feeAmount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Paid from</Label>
          <Select value={paymentAccountId} onValueChange={(v) => setPaymentAccountId(v ?? "")}>
            <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
            <SelectContent>
              {cashAndBankAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={submit} disabled={pending || !amount} className="sm:col-span-4 sm:w-fit">
          {pending ? "Recording…" : "Record"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function RecordTopUpForm({
  loanId,
  cashAndBankAccounts,
}: {
  loanId: string;
  cashAndBankAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [txnDate, setTxnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [receivingAccountId, setReceivingAccountId] = useState(cashAndBankAccounts[0]?.id ?? "");

  function submit() {
    if (!receivingAccountId) return toast.error("Select where the top-up landed.");
    start(async () => {
      const result = await recordLoanTopUpAction({ loanId, txnDate, amount: Number(amount), receivingAccountId });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Top-up recorded.");
        setAmount("");
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Top up this loan</CardTitle></CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3 items-end">
        <div className="space-y-2">
          <Label htmlFor="topUpDate">Date</Label>
          <Input id="topUpDate" type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="topUpAmount">Amount</Label>
          <Input id="topUpAmount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Received into</Label>
          <Select value={receivingAccountId} onValueChange={(v) => setReceivingAccountId(v ?? "")}>
            <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
            <SelectContent>
              {cashAndBankAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={submit} disabled={pending || !amount} className="sm:col-span-3 sm:w-fit">
          {pending ? "Recording…" : "Record Top-up"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function CancelLoanTransactionButton({ loanTransactionId, loanId }: { loanTransactionId: string; loanId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const result = await cancelLoanTransactionAction({ loanTransactionId, loanId, reason });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Cancelled.");
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
        <DialogHeader><DialogTitle>Cancel this?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Reverses its posting.</p>
        <div className="space-y-2">
          <Label htmlFor="cancel-loan-txn-reason">Reason</Label>
          <Textarea id="cancel-loan-txn-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button variant="destructive" disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? "Cancelling…" : "Cancel"}
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

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
  postDepreciationAction,
  disposeFixedAssetAction,
  cancelDepreciationEntryAction,
  cancelFixedAssetAction,
} from "../actions";

type AccountOption = { id: string; code: string; name: string };

export function PostDepreciationForm({ fixedAssetId, suggestedFinancialYear }: { fixedAssetId: string; suggestedFinancialYear: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [financialYear, setFinancialYear] = useState(String(suggestedFinancialYear));
  const [runDate, setRunDate] = useState(() => new Date().toISOString().slice(0, 10));

  function submit() {
    start(async () => {
      const result = await postDepreciationAction({ fixedAssetId, financialYear: Number(financialYear), runDate });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(`Depreciation posted for FY ${financialYear}.`);
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Post depreciation</CardTitle></CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3 items-end">
        <div className="space-y-2">
          <Label htmlFor="financialYear">Financial year (starting)</Label>
          <Input id="financialYear" type="number" value={financialYear} onChange={(e) => setFinancialYear(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="runDate">Run date</Label>
          <Input id="runDate" type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} />
        </div>
        <Button onClick={submit} disabled={pending}>
          {pending ? "Posting…" : "Post Depreciation"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function CancelDepreciationEntryButton({ depreciationEntryId, fixedAssetId }: { depreciationEntryId: string; fixedAssetId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const result = await cancelDepreciationEntryAction({ depreciationEntryId, fixedAssetId, reason });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Depreciation entry cancelled.");
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
        <DialogHeader><DialogTitle>Cancel this depreciation entry?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Reverses its posting; the asset&apos;s WDV rolls back for the next run to recompute from.</p>
        <div className="space-y-2">
          <Label htmlFor="cancel-dep-reason">Reason</Label>
          <Textarea id="cancel-dep-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button variant="destructive" disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? "Cancelling…" : "Cancel Entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DisposeAssetButton({ fixedAssetId, cashAndBankAccounts }: { fixedAssetId: string; cashAndBankAccounts: AccountOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [disposalDate, setDisposalDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [proceeds, setProceeds] = useState("0");
  const [proceedsAccountId, setProceedsAccountId] = useState(cashAndBankAccounts[0]?.id ?? "");
  const [notes, setNotes] = useState("");

  function submit() {
    const proceedsNum = Number(proceeds) || 0;
    if (proceedsNum > 0 && !proceedsAccountId) return toast.error("Select which account the proceeds landed in.");
    start(async () => {
      const result = await disposeFixedAssetAction({
        fixedAssetId,
        disposalDate,
        proceeds: proceedsNum,
        proceedsAccountId: proceedsNum > 0 ? proceedsAccountId : undefined,
        notes: notes || undefined,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Asset disposed.");
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>Dispose</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Dispose this asset</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="disposalDate">Disposal date</Label>
            <Input id="disposalDate" type="date" value={disposalDate} onChange={(e) => setDisposalDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proceeds">Proceeds received (0 if scrapped)</Label>
            <Input id="proceeds" type="number" min="0" step="0.01" value={proceeds} onChange={(e) => setProceeds(e.target.value)} />
          </div>
          {Number(proceeds) > 0 && (
            <div className="space-y-2">
              <Label>Proceeds landed in</Label>
              <Select value={proceedsAccountId} onValueChange={(v) => setProceedsAccountId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {cashAndBankAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="disposal-notes">Notes (optional)</Label>
            <Textarea id="disposal-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button variant="destructive" disabled={pending} onClick={submit}>
            {pending ? "Disposing…" : "Dispose Asset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelAssetButton({ fixedAssetId }: { fixedAssetId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const result = await cancelFixedAssetAction({ fixedAssetId, reason });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Asset cancelled.");
        setOpen(false);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>Cancel Asset</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel this asset?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Reverses the acquisition posting. Only possible when no depreciation has been posted against it.
        </p>
        <div className="space-y-2">
          <Label htmlFor="cancel-asset-reason">Reason</Label>
          <Textarea id="cancel-asset-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Back</Button>
          <Button variant="destructive" disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? "Cancelling…" : "Cancel Asset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, inputClassName } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  importBankStatementRowsAction,
  matchStatementLineAction,
  unmatchStatementLineAction,
  ignoreStatementLineAction,
  restoreStatementLineAction,
  deleteStatementImportAction,
  createTransactionFromStatementLineAction,
  type StatementColumnMap,
} from "../actions";

type AccountOption = { id: string; code: string; name: string };
type UnmatchedLine = { id: string; txnDate: string; description: string; reference: string | null; withdrawal: string; deposit: string };
type UnmatchedJournalLine = { id: string; entryDate: string; entryNumber: string; narration: string; debit: string; credit: string };
type MatchedLine = { id: string; txnDate: string; description: string; withdrawal: string; deposit: string; matchedByName: string; journalEntryNumber: string };
type IgnoredLine = { id: string; txnDate: string; description: string; withdrawal: string; deposit: string };
type Batch = { importBatch: string; rows: number; matched: number; from: string; to: string; importedAt: string };

const MAP_FIELDS: { key: keyof StatementColumnMap; label: string; required: boolean }[] = [
  { key: "date", label: "Date", required: true },
  { key: "description", label: "Description", required: true },
  { key: "withdrawal", label: "Withdrawal", required: true },
  { key: "deposit", label: "Deposit", required: true },
  { key: "reference", label: "Reference (cheque/UPI no.)", required: false },
];

export function ReconciliationWorkspace({
  bankAccountId,
  asOf,
  statementClosingBalance,
  summary,
  columnMap,
  unmatchedLines,
  unmatchedJournalLines,
  matchedLines,
  ignoredLines,
  batches,
  expenseAccounts,
  incomeAccounts,
  canWrite,
}: {
  bankAccountId: string;
  asOf: string;
  statementClosingBalance: string;
  summary: {
    bookBalance: string;
    statementOnlyDeposits: string;
    statementOnlyWithdrawals: string;
    bookOnlyDeposits: string;
    bookOnlyWithdrawals: string;
    adjustedBookBalance: string;
    adjustedStatementBalance: string | null;
  };
  columnMap: StatementColumnMap | null;
  unmatchedLines: UnmatchedLine[];
  unmatchedJournalLines: UnmatchedJournalLine[];
  matchedLines: MatchedLine[];
  ignoredLines: IgnoredLine[];
  batches: Batch[];
  expenseAccounts: AccountOption[];
  incomeAccounts: AccountOption[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ error: string } | { success: true }>, ok: string) =>
    start(async () => {
      const result = await fn();
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(ok);
        router.refresh();
      }
    });

  return (
    <div className="space-y-6">
      {canWrite && (
        <UploadCard bankAccountId={bankAccountId} savedColumnMap={columnMap} onImported={() => router.refresh()} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reconciliation summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form method="GET" className="flex items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="asOf" className="text-xs text-muted-foreground">As of</Label>
              <input id="asOf" name="asOf" type="date" defaultValue={asOf} className={inputClassName} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="statementClosingBalance" className="text-xs text-muted-foreground">Statement closing balance (optional)</Label>
              <input
                id="statementClosingBalance"
                name="statementClosingBalance"
                type="number"
                step="0.01"
                defaultValue={statementClosingBalance}
                placeholder="From the paper/PDF statement"
                className={`${inputClassName} w-64`}
              />
            </div>
            <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground">Update</button>
          </form>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <Stat label="Book balance" value={summary.bookBalance} />
            <Stat label="Adjusted book balance" value={summary.adjustedBookBalance} hint="Book balance + statement-only deposits − statement-only withdrawals" />
            {summary.adjustedStatementBalance !== null && (
              <Stat label="Adjusted statement balance" value={summary.adjustedStatementBalance} hint="Closing balance − deposits in transit + outstanding cheques" />
            )}
            <Stat label="Unmatched" value={`${unmatchedLines.length} statement · ${unmatchedJournalLines.length} book`} isText />
          </div>
          {summary.adjustedStatementBalance !== null && summary.adjustedStatementBalance !== summary.adjustedBookBalance && (
            <p className="text-xs text-warning">
              Not reconciled yet — adjusted book and adjusted statement balances differ. Match or action the remaining unmatched lines below.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unmatched statement lines ({unmatchedLines.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Withdrawal</TableHead>
                <TableHead className="text-right">Deposit</TableHead>
                {canWrite && <TableHead>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {unmatchedLines.length === 0 && (
                <TableRow><TableCell colSpan={canWrite ? 6 : 5} className="py-8 text-center text-muted-foreground">Nothing unmatched.</TableCell></TableRow>
              )}
              {unmatchedLines.map((l) => (
                <UnmatchedLineRow
                  key={l.id}
                  line={l}
                  candidates={unmatchedJournalLines}
                  expenseAccounts={expenseAccounts}
                  incomeAccounts={incomeAccounts}
                  canWrite={canWrite}
                  pending={pending}
                  run={run}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {unmatchedJournalLines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Unmatched book entries ({unmatchedJournalLines.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Entry No.</TableHead>
                  <TableHead>Narration</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unmatchedJournalLines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-sm">{l.entryDate}</TableCell>
                    <TableCell className="text-sm">{l.entryNumber}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{l.narration}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.debit !== "0.00" ? l.debit : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.credit !== "0.00" ? l.credit : ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recently matched</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Withdrawal</TableHead>
                <TableHead className="text-right">Deposit</TableHead>
                <TableHead>Journal entry</TableHead>
                <TableHead>Matched by</TableHead>
                {canWrite && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {matchedLines.length === 0 && (
                <TableRow><TableCell colSpan={canWrite ? 7 : 6} className="py-8 text-center text-muted-foreground">Nothing matched yet.</TableCell></TableRow>
              )}
              {matchedLines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm">{l.txnDate}</TableCell>
                  <TableCell className="text-sm">{l.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.withdrawal !== "0.00" ? l.withdrawal : ""}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.deposit !== "0.00" ? l.deposit : ""}</TableCell>
                  <TableCell className="text-sm">{l.journalEntryNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{l.matchedByName}</TableCell>
                  {canWrite && (
                    <TableCell>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unmatchStatementLineAction(l.id), "Unmatched.")}>
                        Unmatch
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {ignoredLines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ignored ({ignoredLines.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Withdrawal</TableHead>
                  <TableHead className="text-right">Deposit</TableHead>
                  {canWrite && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {ignoredLines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-sm">{l.txnDate}</TableCell>
                    <TableCell className="text-sm">{l.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.withdrawal !== "0.00" ? l.withdrawal : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.deposit !== "0.00" ? l.deposit : ""}</TableCell>
                    {canWrite && (
                      <TableCell>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => restoreStatementLineAction(l.id), "Restored.")}>
                          Restore
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Imported</TableHead>
                <TableHead>Statement range</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Matched</TableHead>
                {canWrite && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.length === 0 && (
                <TableRow><TableCell colSpan={canWrite ? 5 : 4} className="py-8 text-center text-muted-foreground">No imports yet.</TableCell></TableRow>
              )}
              {batches.map((b) => (
                <TableRow key={b.importBatch}>
                  <TableCell className="text-sm text-muted-foreground">{b.importedAt ? new Date(b.importedAt).toLocaleString("en-IN") : "—"}</TableCell>
                  <TableCell className="text-sm">{b.from} to {b.to}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.rows}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.matched}</TableCell>
                  {canWrite && (
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || b.matched > 0}
                        title={b.matched > 0 ? "Unmatch every line from this import first" : undefined}
                        onClick={() => {
                          if (!window.confirm(`Delete this import (${b.rows} rows)? This cannot be undone.`)) return;
                          run(() => deleteStatementImportAction({ bankAccountId, importBatch: b.importBatch }), "Import deleted.");
                        }}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint, isText }: { label: string; value: string; hint?: string; isText?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={isText ? "text-sm font-medium" : "text-lg font-semibold tabular-nums"}>{isText ? value : `₹${value}`}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function UnmatchedLineRow({
  line,
  candidates,
  expenseAccounts,
  incomeAccounts,
  canWrite,
  pending,
  run,
}: {
  line: UnmatchedLine;
  candidates: UnmatchedJournalLine[];
  expenseAccounts: AccountOption[];
  incomeAccounts: AccountOption[];
  canWrite: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ error: string } | { success: true }>, ok: string) => void;
}) {
  const [mode, setMode] = useState<"none" | "match" | "create">("none");
  const [journalLineId, setJournalLineId] = useState("");
  const [accountId, setAccountId] = useState("");
  const isDeposit = line.deposit !== "0.00";
  const accountOptions = isDeposit ? incomeAccounts : expenseAccounts;

  return (
    <TableRow>
      <TableCell className="text-sm">{line.txnDate}</TableCell>
      <TableCell className="text-sm">{line.description}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{line.reference ?? "—"}</TableCell>
      <TableCell className="text-right tabular-nums">{!isDeposit ? line.withdrawal : ""}</TableCell>
      <TableCell className="text-right tabular-nums">{isDeposit ? line.deposit : ""}</TableCell>
      {canWrite && (
        <TableCell>
          {mode === "none" && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setMode("match")}>Match</Button>
              <Button size="sm" variant="outline" onClick={() => setMode("create")}>{isDeposit ? "Record interest" : "Record charge"}</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => ignoreStatementLineAction(line.id), "Ignored.")}>Ignore</Button>
            </div>
          )}
          {mode === "match" && (
            <div className="flex items-center gap-2">
              <Select value={journalLineId} onValueChange={(v) => setJournalLineId(v ?? "")}>
                <SelectTrigger className="w-64"><SelectValue placeholder="Pick a book entry" /></SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.entryDate} · {c.entryNumber} · {c.debit !== "0.00" ? c.debit : c.credit}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={pending || !journalLineId}
                onClick={() => run(() => matchStatementLineAction({ statementLineId: line.id, journalLineId }), "Matched.")}
              >
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("none")}>Cancel</Button>
            </div>
          )}
          {mode === "create" && (
            <div className="flex items-center gap-2">
              <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "")}>
                <SelectTrigger className="w-56"><SelectValue placeholder={isDeposit ? "Income account" : "Expense account"} /></SelectTrigger>
                <SelectContent>
                  {accountOptions.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={pending || !accountId}
                onClick={() =>
                  run(
                    () =>
                      isDeposit
                        ? createTransactionFromStatementLineAction({ statementLineId: line.id, type: "INTEREST_INCOME", incomeAccountId: accountId })
                        : createTransactionFromStatementLineAction({ statementLineId: line.id, type: "BANK_CHARGE", expenseAccountId: accountId }),
                    "Recorded and matched.",
                  )
                }
              >
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("none")}>Cancel</Button>
            </div>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

function UploadCard({
  bankAccountId,
  savedColumnMap,
  onImported,
}: {
  bankAccountId: string;
  savedColumnMap: StatementColumnMap | null;
  onImported: () => void;
}) {
  const [isReading, setIsReading] = useState(false);
  const [isPending, startImport] = useTransition();
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState("");
  const [map, setMap] = useState<StatementColumnMap>(savedColumnMap ?? { date: "", description: "", withdrawal: "", deposit: "", reference: "" });

  async function handleFile(file: File) {
    setIsReading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/accounting/bank-reconciliation/parse", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Could not read this file.");
        return;
      }
      if (!data.rows || data.rows.length === 0) {
        toast.error("No data rows found in this file.");
        return;
      }
      setHeaders(data.headers);
      setRows(data.rows);
      setFileName(file.name);

      // Keep the saved mapping if its header names still exist in this file; otherwise guess nothing and let the user map.
      if (savedColumnMap) {
        const valid = (h: string | undefined) => !!h && data.headers.includes(h);
        setMap({
          date: valid(savedColumnMap.date) ? savedColumnMap.date : "",
          description: valid(savedColumnMap.description) ? savedColumnMap.description : "",
          withdrawal: valid(savedColumnMap.withdrawal) ? savedColumnMap.withdrawal : "",
          deposit: valid(savedColumnMap.deposit) ? savedColumnMap.deposit : "",
          reference: valid(savedColumnMap.reference) ? savedColumnMap.reference : "",
        });
      }
    } catch {
      toast.error("Upload failed. Please try again.");
    } finally {
      setIsReading(false);
    }
  }

  const missingRequired = MAP_FIELDS.filter((f) => f.required && !map[f.key]);

  function confirmImport() {
    startImport(async () => {
      const result = await importBankStatementRowsAction({ bankAccountId, columnMap: map, rows });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Imported ${result.imported} rows, auto-matched ${result.autoMatched}.`);
      setHeaders([]);
      setRows([]);
      setFileName("");
      onImported();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import statement</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Upload a .csv, .xlsx or .xls bank statement export.</p>
            <Input
              type="file"
              accept=".csv,.xlsx,.xls"
              disabled={isReading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
            {isReading && <p className="text-sm text-muted-foreground">Reading file…</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{fileName} — {rows.length} rows found. Map each field to a column.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {MAP_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label>{f.label}{f.required && <span className="text-destructive"> *</span>}</Label>
                  <Select
                    value={map[f.key] || "NONE"}
                    onValueChange={(v) => setMap((prev) => ({ ...prev, [f.key]: v === "NONE" ? "" : (v as string) }))}
                  >
                    <SelectTrigger className="w-full"><SelectValue placeholder="Not mapped" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Not mapped</SelectItem>
                      {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {missingRequired.length > 0 && (
              <p className="text-sm text-destructive">Map all required fields: {missingRequired.map((f) => f.label).join(", ")}</p>
            )}
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={() => { setHeaders([]); setRows([]); setFileName(""); }}>Start over</Button>
              <Button disabled={missingRequired.length > 0 || isPending} onClick={confirmImport}>
                {isPending ? "Importing…" : `Import ${rows.length} rows`}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportLinks } from "@/components/accounting/export-links";
import { runCustomReportAction, saveCustomReportDefinitionAction, deleteCustomReportDefinitionAction } from "./actions";
import type { SavedCustomReport } from "@/lib/accounting/custom-report";

type ColumnDef = { key: string; label: string };

export function CustomReportBuilder({
  allColumns,
  allTypes,
  savedReports,
  defaultFrom,
  defaultTo,
}: {
  allColumns: ColumnDef[];
  allTypes: string[];
  savedReports: SavedCustomReport[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [pending, start] = useTransition();
  const [savedList, setSavedList] = useState(savedReports);

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [columns, setColumns] = useState<Set<string>>(new Set(allColumns.map((c) => c.key)));
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [partyContains, setPartyContains] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [saveName, setSaveName] = useState("");

  const [result, setResult] = useState<{ columns: ColumnDef[]; rows: Record<string, string>[] } | null>(null);

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, key: string) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSet(next);
  }

  function runReport() {
    start(async () => {
      const res = await runCustomReportAction({
        from,
        to,
        columns: [...columns],
        transactionTypes: [...types],
        partyContains,
        minAmount,
        maxAmount,
      });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setResult({ columns: res.columns, rows: res.rows });
    });
  }

  function saveReport() {
    if (!saveName.trim()) {
      toast.error("Give this report a name first.");
      return;
    }
    start(async () => {
      const res = await saveCustomReportDefinitionAction({
        name: saveName,
        columns: [...columns],
        transactionTypes: [...types],
        partyContains,
        minAmount,
        maxAmount,
      });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success("Saved.");
      setSaveName("");
      // Re-list isn't fetched from the server again here — append a client-side placeholder so it shows immediately.
      setSavedList((prev) => [
        { id: crypto.randomUUID(), name: saveName, columns: [...columns], transactionTypes: [...types], partyContains: partyContains || null, minAmount: minAmount || null, maxAmount: maxAmount || null, createdAt: new Date() },
        ...prev,
      ]);
    });
  }

  function loadReport(r: SavedCustomReport) {
    setColumns(new Set(r.columns));
    setTypes(new Set(r.transactionTypes));
    setPartyContains(r.partyContains ?? "");
    setMinAmount(r.minAmount ?? "");
    setMaxAmount(r.maxAmount ?? "");
    toast.success(`Loaded "${r.name}". Pick a date range and run it.`);
  }

  function deleteReport(id: string) {
    start(async () => {
      const res = await deleteCustomReportDefinitionAction(id);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setSavedList((prev) => prev.filter((r) => r.id !== id));
      toast.success("Deleted.");
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-base">Columns</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {allColumns.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm">
              <Checkbox checked={columns.has(c.key)} onCheckedChange={() => toggle(columns, setColumns, c.key)} />
              {c.label}
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Filters</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label>From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Party contains</Label>
              <Input value={partyContains} onChange={(e) => setPartyContains(e.target.value)} placeholder="Customer or supplier name" />
            </div>
            <div className="space-y-1.5">
              <Label>Amount range</Label>
              <div className="flex gap-2">
                <Input type="number" placeholder="Min" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
                <Input type="number" placeholder="Max" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Transaction type (leave all unchecked for every type)</Label>
            <div className="flex flex-wrap gap-3">
              {allTypes.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={types.has(t)} onCheckedChange={() => toggle(types, setTypes, t)} />
                  {t}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t pt-4">
            <div className="flex items-center gap-2">
              <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name this report to save it" className="w-64" />
              <Button variant="outline" disabled={pending} onClick={saveReport}>Save</Button>
            </div>
            <Button disabled={pending || columns.size === 0} onClick={runReport}>
              {pending ? "Running…" : "Run report"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {savedList.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Saved reports</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {savedList.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm font-medium">{r.name}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => loadReport(r)}>Load</Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => deleteReport(r.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle className="text-base">{result.rows.length} row{result.rows.length === 1 ? "" : "s"}</CardTitle>
            <ExportLinks
              report="custom-report"
              params={{
                from,
                to,
                columns: [...columns].join(","),
                types: [...types].join(","),
                partyContains: partyContains || undefined,
                minAmount: minAmount || undefined,
                maxAmount: maxAmount || undefined,
              }}
            />
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {result.columns.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.length === 0 && (
                  <TableRow><TableCell colSpan={result.columns.length} className="py-8 text-center text-muted-foreground">No rows match these filters.</TableCell></TableRow>
                )}
                {result.rows.map((row, i) => (
                  <TableRow key={i}>
                    {result.columns.map((c) => <TableCell key={c.key} className="text-sm">{row[c.label] ?? ""}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

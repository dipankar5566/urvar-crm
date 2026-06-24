"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeftIcon, ArrowRightIcon, DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CUSTOMER_TYPE_LABELS, LEAD_SOURCE_LABELS } from "@/lib/constants/labels";
import { CustomerType, LeadSource } from "@/generated/prisma/enums";
import {
  IMPORT_FIELD_DEFS,
  distinctValues,
  guessCustomerType,
  guessLeadSource,
  type ColumnMapping,
  type ValueMapping,
} from "@/lib/lead-import";
import { validateImportRows, commitImport, type RowVerdict } from "./actions";

type Step = "upload" | "columns" | "values" | "preview" | "done";

const LEAD_SOURCE_OPTIONS = Object.values(LeadSource);
const CUSTOMER_TYPE_OPTIONS = Object.values(CustomerType);

export function ImportWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [isPending, startTransition] = useTransition();
  const [isUploading, setIsUploading] = useState(false);

  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState("");

  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({});
  const [valueMapping, setValueMapping] = useState<ValueMapping>({
    source: {},
    customerType: {},
  });

  const [verdicts, setVerdicts] = useState<RowVerdict[]>([]);
  const [summary, setSummary] = useState<{ createdCount: number; skippedCount: number } | null>(
    null,
  );

  async function handleFile(file: File) {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/leads/import/parse", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Could not read this file.");
        return;
      }
      if (!data.rows || data.rows.length === 0) {
        toast.error("No data rows found in this file.");
        return;
      }

      const autoMapping: ColumnMapping = {};
      for (const field of IMPORT_FIELD_DEFS) {
        const target = field.key.toLowerCase();
        const match = (data.headers as string[]).find(
          (h) => h.toLowerCase().replace(/[^a-z]/g, "") === target,
        );
        if (match) autoMapping[field.key] = match;
      }

      setHeaders(data.headers);
      setRawRows(data.rows);
      setFileName(file.name);
      setColumnMapping(autoMapping);
      setStep("columns");
    } catch {
      toast.error("Upload failed. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  const missingRequired = IMPORT_FIELD_DEFS.filter(
    (f) => f.required && !columnMapping[f.key],
  );

  const sourceHeader = columnMapping.source;
  const customerTypeHeader = columnMapping.customerType;
  const distinctSourceValues = useMemo(
    () => (sourceHeader ? distinctValues(rawRows, sourceHeader) : []),
    [rawRows, sourceHeader],
  );
  const distinctCustomerTypeValues = useMemo(
    () => (customerTypeHeader ? distinctValues(rawRows, customerTypeHeader) : []),
    [rawRows, customerTypeHeader],
  );
  const unmappedSourceValues = distinctSourceValues.filter((v) => !valueMapping.source[v]);
  const unmappedCustomerTypeValues = distinctCustomerTypeValues.filter(
    (v) => !valueMapping.customerType[v],
  );

  function proceedToValues() {
    setValueMapping((prev) => {
      const source = { ...prev.source };
      for (const v of distinctSourceValues) {
        if (!source[v]) {
          const guess = guessLeadSource(v);
          if (guess) source[v] = guess;
        }
      }
      const customerType = { ...prev.customerType };
      for (const v of distinctCustomerTypeValues) {
        if (!customerType[v]) {
          const guess = guessCustomerType(v);
          if (guess) customerType[v] = guess;
        }
      }
      return { source, customerType };
    });
    setStep("values");
  }

  function runValidation() {
    startTransition(async () => {
      const result = await validateImportRows(rawRows, columnMapping, valueMapping);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setVerdicts(result.verdicts);
      setStep("preview");
    });
  }

  const readyCount = verdicts.filter((v) => v.status === "READY").length;
  const missingCount = verdicts.filter((v) => v.status === "MISSING_FIELD").length;
  const duplicateCount = verdicts.filter((v) => v.status === "DUPLICATE").length;

  function confirmImport() {
    startTransition(async () => {
      const result = await commitImport(rawRows, columnMapping, valueMapping);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setSummary({ createdCount: result.createdCount, skippedCount: result.skippedCount });
      setStep("done");
      router.refresh();
    });
  }

  function reset() {
    setStep("upload");
    setHeaders([]);
    setRawRows([]);
    setFileName("");
    setColumnMapping({});
    setValueMapping({ source: {}, customerType: {} });
    setVerdicts([]);
    setSummary(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {step === "upload" && "1. Upload your file"}
          {step === "columns" && "2. Map columns"}
          {step === "values" && "3. Map values (optional)"}
          {step === "preview" && "4. Preview & confirm"}
          {step === "done" && "Import complete"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {step === "upload" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Upload an Excel (.xlsx) or CSV file with your lead contacts.
              You&apos;ll map your columns to CRM fields on the next screen.
            </p>
            <Button
              variant="outline"
              size="sm"
              render={<a href="/api/leads/import/template" />}
            >
              <DownloadIcon /> Download template
            </Button>
            <Input
              type="file"
              accept=".xlsx,.xls,.csv"
              disabled={isUploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            {isUploading && <p className="text-sm text-muted-foreground">Reading file…</p>}
          </div>
        )}

        {step === "columns" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {fileName} — {rawRows.length} rows found. Map each CRM field to a column from your
              file.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {IMPORT_FIELD_DEFS.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label>
                    {field.label}
                    {field.required && <span className="text-destructive"> *</span>}
                  </Label>
                  <Select
                    value={columnMapping[field.key] ?? "NONE"}
                    onValueChange={(v) =>
                      setColumnMapping((prev) => ({
                        ...prev,
                        [field.key]: v === "NONE" ? undefined : (v as string),
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Not mapped" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Not mapped</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {missingRequired.length > 0 && (
              <p className="text-sm text-destructive">
                Map all required fields: {missingRequired.map((f) => f.label).join(", ")}
              </p>
            )}
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={reset}>
                <ArrowLeftIcon /> Start over
              </Button>
              <Button disabled={missingRequired.length > 0} onClick={proceedToValues}>
                Next <ArrowRightIcon />
              </Button>
            </div>
          </div>
        )}

        {step === "values" && (
          <div className="space-y-4">
            {!sourceHeader && !customerTypeHeader && (
              <p className="text-sm text-muted-foreground">
                You didn&apos;t map Lead Source or Customer Type — that&apos;s fine, unmapped
                rows will default to Direct Call / B2C Farmer. Click back to map them if you do
                have this data.
              </p>
            )}

            {sourceHeader && (
              <>
                <p className="text-sm text-muted-foreground">
                  Your file uses these values for Lead Source — map each one to the matching CRM
                  category.
                </p>
                <div className="space-y-2">
                  {distinctSourceValues.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No values found in the mapped column.
                    </p>
                  )}
                  {distinctSourceValues.map((v) => (
                    <div key={v} className="flex items-center justify-between gap-3">
                      <span className="text-sm">{v}</span>
                      <Select
                        value={valueMapping.source[v] ?? "NONE"}
                        onValueChange={(val) =>
                          setValueMapping((prev) => ({
                            ...prev,
                            source: { ...prev.source, [v]: val as string },
                          }))
                        }
                      >
                        <SelectTrigger className="w-56">
                          <SelectValue placeholder="Choose source" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NONE">Choose source</SelectItem>
                          {LEAD_SOURCE_OPTIONS.map((s) => (
                            <SelectItem key={s} value={s}>
                              {LEAD_SOURCE_LABELS[s] ?? s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </>
            )}

            {customerTypeHeader && (
              <>
                <p className="pt-2 text-sm text-muted-foreground">
                  Your file uses these values for Customer Type — map each one to the matching CRM
                  category.
                </p>
                <div className="space-y-2">
                  {distinctCustomerTypeValues.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No values found in the mapped column.
                    </p>
                  )}
                  {distinctCustomerTypeValues.map((v) => (
                    <div key={v} className="flex items-center justify-between gap-3">
                      <span className="text-sm">{v}</span>
                      <Select
                        value={valueMapping.customerType[v] ?? "NONE"}
                        onValueChange={(val) =>
                          setValueMapping((prev) => ({
                            ...prev,
                            customerType: { ...prev.customerType, [v]: val as string },
                          }))
                        }
                      >
                        <SelectTrigger className="w-56">
                          <SelectValue placeholder="Choose type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NONE">Choose type</SelectItem>
                          {CUSTOMER_TYPE_OPTIONS.map((t) => (
                            <SelectItem key={t} value={t}>
                              {CUSTOMER_TYPE_LABELS[t] ?? t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(unmappedSourceValues.length > 0 || unmappedCustomerTypeValues.length > 0) && (
              <p className="text-sm text-destructive">
                Map every value before continuing:{" "}
                {[...unmappedSourceValues, ...unmappedCustomerTypeValues].join(", ")}
              </p>
            )}
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={() => setStep("columns")}>
                <ArrowLeftIcon /> Back
              </Button>
              <Button
                disabled={
                  unmappedSourceValues.length > 0 ||
                  unmappedCustomerTypeValues.length > 0 ||
                  isPending
                }
                onClick={runValidation}
              >
                {isPending ? "Validating…" : "Preview import"} <ArrowRightIcon />
              </Button>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-4">
            <div className="flex gap-3">
              <Badge>{readyCount} ready</Badge>
              <Badge variant="secondary">{missingCount} missing data</Badge>
              <Badge variant="outline">{duplicateCount} duplicates</Badge>
            </div>
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {verdicts.map((v) => (
                    <TableRow key={v.rowIndex}>
                      <TableCell>{v.rowIndex + 1}</TableCell>
                      <TableCell>
                        {v.status === "READY" && <Badge>Ready</Badge>}
                        {v.status === "MISSING_FIELD" && (
                          <Badge variant="secondary">Missing data</Badge>
                        )}
                        {v.status === "DUPLICATE" && <Badge variant="outline">Duplicate</Badge>}
                      </TableCell>
                      <TableCell className="text-sm">
                        {v.status === "READY" ? `${v.name} · ${v.phone}` : v.reason}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={() => setStep("values")}>
                <ArrowLeftIcon /> Back
              </Button>
              <Button disabled={readyCount === 0 || isPending} onClick={confirmImport}>
                {isPending ? "Importing…" : `Import ${readyCount} leads`}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && summary && (
          <div className="space-y-4">
            <p className="text-sm">
              Created <strong>{summary.createdCount}</strong> new lead
              {summary.createdCount === 1 ? "" : "s"}.{" "}
              {summary.skippedCount > 0 &&
                `${summary.skippedCount} row${summary.skippedCount === 1 ? "" : "s"} were skipped (see the previous step for reasons).`}
            </p>
            <div className="flex gap-2">
              <Button onClick={reset}>Import another file</Button>
              <Button variant="outline" render={<Link href="/leads" />}>
                Go to Leads
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

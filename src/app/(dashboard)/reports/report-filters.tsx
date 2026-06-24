"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATES } from "@/lib/constants/territories";

type RepOption = { id: string; name: string };

export function ReportFiltersBar({
  reps,
  showRepFilter,
}: {
  reps: RepOption[];
  showRepFilter: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === "ALL") params.delete(key);
    else params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  }

  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const state = searchParams.get("state") ?? "ALL";
  const repId = searchParams.get("repId") ?? "ALL";

  function exportHref(type: "leads" | "quotations" | "orders", format: "csv" | "xlsx") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("type", type);
    params.set("format", format);
    return `/api/reports/export?${params.toString()}`;
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">From</Label>
        <Input type="date" value={from} onChange={(e) => set("from", e.target.value)} className="w-40" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">To</Label>
        <Input type="date" value={to} onChange={(e) => set("to", e.target.value)} className="w-40" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">State</Label>
        <Select value={state} onValueChange={(v) => set("state", v as string)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All States</SelectItem>
            {STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {showRepFilter && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Rep</Label>
          <Select value={repId} onValueChange={(v) => set("repId", v as string)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Reps</SelectItem>
              {reps.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="ml-auto flex flex-wrap gap-2">
        <Button size="sm" variant="outline" render={<a href={exportHref("leads", "csv")} />}>
          <Download /> Leads (CSV)
        </Button>
        <Button size="sm" variant="outline" render={<a href={exportHref("orders", "xlsx")} />}>
          <Download /> Orders (Excel)
        </Button>
        <Button size="sm" variant="outline" render={<a href={exportHref("quotations", "csv")} />}>
          <Download /> Quotations (CSV)
        </Button>
      </div>
    </div>
  );
}

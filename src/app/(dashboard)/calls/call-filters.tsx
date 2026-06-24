"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";
import { CALL_DIRECTION_LABELS, CALL_OUTCOME_LABELS } from "@/lib/constants/labels";

export function CallFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "ALL") params.delete(key);
    else params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  }

  function toggleToday() {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get("today") === "1") params.delete("today");
    else params.set("today", "1");
    router.push(`${pathname}?${params.toString()}`);
  }

  const hasFilters = searchParams.size > 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={searchParams.get("outcome") ?? "ALL"}
        onValueChange={(v) => setParam("outcome", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="Outcome" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All outcomes</SelectItem>
          {Object.entries(CALL_OUTCOME_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("direction") ?? "ALL"}
        onValueChange={(v) => setParam("direction", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="Direction" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All directions</SelectItem>
          {Object.entries(CALL_DIRECTION_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant={searchParams.get("today") === "1" ? "default" : "outline"}
        size="sm"
        onClick={toggleToday}
      >
        Today only
      </Button>

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={() => router.push(pathname)}>
          <XIcon /> Clear
        </Button>
      )}
    </div>
  );
}

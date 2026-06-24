"use client";

import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { PlusIcon, XIcon } from "lucide-react";
import {
  LEAD_STATUS_LABELS,
  LEAD_SOURCE_LABELS,
} from "@/lib/constants/labels";
import { STATES } from "@/lib/constants/territories";

type RepOption = { id: string; name: string };

export function LeadFilters({
  reps,
  showRepFilter,
}: {
  reps: RepOption[];
  showRepFilter: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "ALL") params.delete(key);
    else params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  }

  const hasFilters = searchParams.size > 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={searchParams.get("status") ?? "ALL"}
        onValueChange={(v) => setParam("status", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All statuses</SelectItem>
          {Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("source") ?? "ALL"}
        onValueChange={(v) => setParam("source", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All sources</SelectItem>
          {Object.entries(LEAD_SOURCE_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("state") ?? "ALL"}
        onValueChange={(v) => setParam("state", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="State" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All states</SelectItem>
          {STATES.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showRepFilter && (
        <Select
          value={searchParams.get("assignedToId") ?? "ALL"}
          onValueChange={(v) => setParam("assignedToId", v as string)}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="Assigned to" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All reps</SelectItem>
            <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
            {reps.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(pathname)}
        >
          <XIcon /> Clear
        </Button>
      )}

      <Button size="sm" className="ml-auto" render={<Link href="/leads/new" />}>
        <PlusIcon /> New Lead
      </Button>
    </div>
  );
}

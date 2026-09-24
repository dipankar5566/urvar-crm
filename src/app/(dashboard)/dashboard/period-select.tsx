import Link from "next/link";
import { cn } from "@/lib/utils";
import { DASHBOARD_PERIODS, type DashboardPeriodKey } from "./period";

/**
 * Period presets as plain links to `?period=`. A server component on purpose:
 * the period lives in the URL (shareable, back-button friendly) and switching
 * it re-renders the server sections, so there is no client state to manage.
 */
export function PeriodSelect({ active }: { active: DashboardPeriodKey }) {
  return (
    <div
      className="inline-flex rounded-md border bg-background p-0.5"
      role="group"
      aria-label="Reporting period"
    >
      {DASHBOARD_PERIODS.map((p) => (
        <Link
          key={p.key}
          href={`/dashboard?period=${p.key}`}
          aria-current={p.key === active ? "true" : undefined}
          className={cn(
            "rounded px-3 py-1 text-xs font-medium transition-colors",
            p.key === active
              ? "bg-brand text-white"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {p.label}
        </Link>
      ))}
    </div>
  );
}

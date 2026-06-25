import { badgeVariants } from "@/components/ui/badge";
import { LEAD_STATUS_LABELS } from "@/lib/constants/labels";
import { cn } from "@/lib/utils";

/** Lead-status pill colored per status via the --status-* CSS vars (globals.css), flips with .dark automatically. */
export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const key = status.toLowerCase();
  return (
    <span
      className={cn(badgeVariants({ variant: "ghost" }), "border-transparent", className)}
      style={{
        background: `var(--status-${key}-bg, var(--secondary))`,
        color: `var(--status-${key}-fg, var(--secondary-foreground))`,
      }}
    >
      {LEAD_STATUS_LABELS[status] ?? status}
    </span>
  );
}

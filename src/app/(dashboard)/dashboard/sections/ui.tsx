import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
      {children}
    </h2>
  );
}

const TONE_CLASS = {
  default: "",
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
} as const;

export type StatTone = keyof typeof TONE_CLASS;

export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: StatTone;
}) {
  const card = (
    <Card className={cn("h-full p-0", href && "transition-colors hover:bg-accent/40")}>
      <CardContent className="px-[18px] py-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">{label}</div>
        <div
          className={cn(
            "text-2xl leading-none font-bold tracking-[-0.025em] tabular-nums",
            TONE_CLASS[tone],
          )}
        >
          {value}
        </div>
        {hint && <p className="mt-1.5 text-[11px] text-tertiary-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {card}
    </Link>
  ) : (
    card
  );
}

/** Suspense fallback for a row of stat cards or a single panel. */
export function SectionSkeleton({
  cards = 4,
  panel = false,
}: {
  cards?: number;
  panel?: boolean;
}) {
  if (panel) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {Array.from({ length: cards }).map((_, i) => (
        <Skeleton key={i} className="h-[92px]" />
      ))}
    </div>
  );
}

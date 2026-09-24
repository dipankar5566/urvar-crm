import { Suspense } from "react";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/layout/page-header";
import { parseDashboardPeriod } from "./period";
import { PeriodSelect } from "./period-select";
import { AlertsStrip } from "./sections/alerts-strip";
import { TodayStrip } from "./sections/today-strip";
import { SalesPerformance } from "./sections/sales-performance";
import { FinanceSnapshot } from "./sections/finance-snapshot";
import { FieldCallingActivity } from "./sections/field-calling-activity";
import { LeadInsights } from "./sections/lead-insights";
import { SectionSkeleton } from "./sections/ui";

/**
 * Role-aware dashboard. Each section is an async server component that
 * checks the viewer's module permissions itself and renders nothing when it
 * has nothing they may see, so this page stays a plain composition. Every
 * section sits in its own <Suspense>: the ledger-backed finance panel can take
 * longer than the lead counts, and shouldn't hold the rest of the page back.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const user = await requireUser();
  const { period: periodParam } = await searchParams;
  const period = parseDashboardPeriod(periodParam);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome back, ${user.name.split(" ")[0]}. Here's where things stand.`}
        action={<PeriodSelect active={period.key} />}
      />

      <Suspense fallback={null}>
        <AlertsStrip user={user} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton cards={5} />}>
        <TodayStrip user={user} />
      </Suspense>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Suspense fallback={<SectionSkeleton panel />}>
          <SalesPerformance user={user} period={period} />
        </Suspense>

        <Suspense fallback={<SectionSkeleton panel />}>
          <FinanceSnapshot user={user} period={period} />
        </Suspense>
      </div>

      <Suspense fallback={<SectionSkeleton panel />}>
        <FieldCallingActivity user={user} period={period} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton panel />}>
        <LeadInsights user={user} period={period} />
      </Suspense>
    </div>
  );
}

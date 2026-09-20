import Link from "next/link";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const REPORTS = [
  { href: "/accounting/reports/trial-balance", title: "Trial Balance", description: "Every account's net balance as of a date." },
  { href: "/accounting/reports/ledger", title: "General Ledger", description: "One account's transaction history — also the cash book or bank book." },
  { href: "/accounting/reports/profit-and-loss", title: "Profit & Loss", description: "Income and expenses over a date range." },
  { href: "/accounting/reports/balance-sheet", title: "Balance Sheet", description: "Assets, liabilities and equity as of a date." },
  { href: "/accounting/reports/gst", title: "GST Registers", description: "Output tax vs. input credit, and the outward-supply detail, for return preparation." },
];

export default async function FinancialReportsPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financial Reports"
        subtitle="Every figure here is derived from posted journal lines, never from an independent calculation. The GST registers are for return preparation only — not a filed return, and not a claim of compliance."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href}>
            <Card className="h-full transition-colors hover:border-primary">
              <CardHeader>
                <CardTitle className="text-base">{r.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{r.description}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

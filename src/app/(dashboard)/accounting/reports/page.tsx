import Link from "next/link";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type ReportLink = { href: string; title: string; description: string };
type ReportSection = { title: string; reports: ReportLink[] };

/** Grouped by Vyapar's own report-menu categories (Phase 8) now that the flat list has grown past what a single grid reads well. */
const SECTIONS: ReportSection[] = [
  {
    title: "Transaction Report",
    reports: [
      { href: "/accounting/reports/trial-balance", title: "Trial Balance", description: "Every account's net balance as of a date." },
      { href: "/accounting/reports/day-book", title: "Day Book", description: "Every posted entry, across every account, in the order it happened." },
      { href: "/accounting/reports/ledger", title: "General Ledger", description: "One account's transaction history — also the cash book or bank book." },
      { href: "/accounting/reports/cash-flow", title: "Cash Flow", description: "Net movement through cash and the default bank account, by cause." },
      { href: "/accounting/reports/profit-and-loss", title: "Profit & Loss", description: "Income and expenses over a date range." },
      { href: "/accounting/reports/bill-wise-profit", title: "Bill Wise Profit", description: "Estimated margin per invoice — an estimate, never posted to the ledger." },
      { href: "/accounting/reports/sales-aging", title: "Sales Aging", description: "Every open sales invoice individually, bucketed by days past due." },
      { href: "/accounting/reports/balance-sheet", title: "Balance Sheet", description: "Assets, liabilities and equity as of a date." },
    ],
  },
  {
    title: "Party Report",
    reports: [
      { href: "/accounting/reports/all-parties", title: "All Parties", description: "Every customer and supplier — invoiced, settled, outstanding." },
      { href: "/accounting/reports/party-statement", title: "Party Statement", description: "A running ledger for one customer or supplier. Pick a party from All Parties." },
      { href: "/accounting/reports/party-profit-loss", title: "Party wise Profit and Loss", description: "Revenue and estimated cost per customer." },
      { href: "/accounting/reports/party-item-report", title: "Party report by Item", description: "Products bought by one customer." },
    ],
  },
  {
    title: "GST Report",
    reports: [
      { href: "/accounting/reports/gst", title: "GST Registers", description: "Output tax vs. input credit, and outward-supply detail — GSTR-1/3B-style, for return preparation." },
      { href: "/accounting/reports/hsn-summary", title: "Sale Summary By HSN", description: "Outward supply detail aggregated by HSN code." },
    ],
  },
  {
    title: "Item / Stock Report",
    reports: [
      { href: "/accounting/reports/item-profit-loss", title: "Item Wise Profit and loss", description: "Revenue and estimated cost per product." },
      { href: "/accounting/reports/item-category-profit-loss", title: "Item Category Wise profit and loss", description: "Same, grouped by product category." },
      { href: "/accounting/reports/item-wise-discount", title: "Item Wise Discount", description: "Discount given per product." },
    ],
  },
  {
    title: "Business Report",
    reports: [
      { href: "/accounting/reports/bank-report", title: "Bank Report", description: "Balance of every bank account as of a date." },
      { href: "/accounting/reports/discount-report", title: "Discount Report", description: "Discount given per customer." },
    ],
  },
  {
    title: "Expense Report",
    reports: [
      { href: "/accounting/reports/expense-category-report", title: "Expense Category Report", description: "Approved expenses by category account." },
      { href: "/accounting/reports/expense-item-report", title: "Expense Item Report", description: "Approved expenses' itemised lines, by description." },
    ],
  },
  {
    title: "Cash, Bank & Assets",
    reports: [
      { href: "/accounting/reports/cash-bank-assets", title: "Cash, Bank & Assets", description: "Cash on Hand, Bank Accounts, Fixed Assets and Loan Accounts as of a date." },
    ],
  },
  {
    title: "Party Ageing",
    reports: [
      { href: "/accounting/reports/ar-ageing", title: "AR Ageing", description: "Every customer with an open invoice, bucketed by days past due." },
      { href: "/accounting/reports/ap-ageing", title: "AP Ageing", description: "Every supplier with an open purchase invoice, bucketed by days since the invoice date." },
    ],
  },
];

export default async function FinancialReportsPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Financial Reports"
        subtitle="Every figure here is derived from posted journal lines, never from an independent calculation. The GST registers are for return preparation only — not a filed return, and not a claim of compliance. Reports naming an 'estimated' cost or margin read an informational snapshot that is never posted to the ledger."
      />
      {SECTIONS.map((section) => (
        <div key={section.title} className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{section.title}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {section.reports.map((r) => (
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
      ))}
    </div>
  );
}

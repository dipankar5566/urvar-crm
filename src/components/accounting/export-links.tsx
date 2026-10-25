/**
 * "Export Excel" / "Export PDF" links for one accounting report, pointing
 * at `/api/accounting/reports/export` with the report's id and whatever
 * filter params the page currently has selected — a plain GET download, no
 * client JS needed (Vyapar parity step 4, G13).
 */
export function ExportLinks({
  report,
  params,
}: {
  report: string;
  params: Record<string, string | undefined>;
}) {
  const href = (format: "xlsx" | "pdf") => {
    const entries = Object.entries({ report, format, ...params }).filter(([, v]) => v !== undefined) as [string, string][];
    return `/api/accounting/reports/export?${new URLSearchParams(entries).toString()}`;
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <a href={href("xlsx")} className="text-primary hover:underline">Export Excel</a>
      <span className="text-muted-foreground">·</span>
      <a href={href("pdf")} className="text-primary hover:underline">Export PDF</a>
    </div>
  );
}

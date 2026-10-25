import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Renders one `ReportSheet` (report-registry.ts / gstr-reports.ts's shared
 * shape — `{ name, rows }`) as a table, columns derived from the first
 * row's keys. Used by the multi-sheet GSTR-1/2/3B and GST Tax Rate report
 * pages so each sheet doesn't need its own bespoke table markup.
 */
export function SheetTable({ sheet }: { sheet: { name: string; rows: Record<string, string | number>[] } }) {
  const columns = sheet.rows[0] ? Object.keys(sheet.rows[0]) : [];
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{sheet.name}</CardTitle></CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {columns.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No rows.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c} className="whitespace-nowrap">{c || "—"}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c} className="whitespace-nowrap">{row[c] === "" ? "" : String(row[c])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

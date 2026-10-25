import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "secondary",
  SUBMITTED: "outline",
  APPROVED: "default",
  REJECTED: "destructive",
  CANCELLED: "outline",
};

export default async function OtherIncomePage() {
  const user = await requireUser();
  assertCan(user.role, "otherIncome", "read");
  const canWrite = can(user.role, "otherIncome", "write") !== "none";

  const entries = await prisma.otherIncome.findMany({
    orderBy: { incomeDate: "desc" },
    take: 200,
    include: { categoryAccount: { select: { name: true } } },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Other Income"
        subtitle={`${entries.length} entr${entries.length === 1 ? "y" : "ies"}. Miscellaneous income that isn't a sale — scrap sold, bank interest, a one-off service charge.`}
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/other-income/new" />}>
              Record Income
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead>Payer</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No other income recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link href={`/other-income/${e.id}`} className="font-mono text-sm font-medium underline">
                      {e.incomeNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{e.payerName}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.categoryAccount.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.incomeDate.toLocaleDateString("en-IN")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[e.status] ?? "secondary"}>{e.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatInr(e.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

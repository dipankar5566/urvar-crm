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

export default async function ExpensesPage() {
  const user = await requireUser();
  assertCan(user.role, "expenses", "read");
  const canWrite = can(user.role, "expenses", "write") !== "none";

  const expenses = await prisma.expense.findMany({
    orderBy: { expenseDate: "desc" },
    take: 200,
    include: { categoryAccount: { select: { name: true } } },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        subtitle={`${expenses.length} expense${expenses.length === 1 ? "" : "s"}.`}
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/expenses/new" />}>
              Submit Expense
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Expense</TableHead>
                <TableHead>Payee</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No expenses submitted yet.
                  </TableCell>
                </TableRow>
              )}
              {expenses.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link href={`/expenses/${e.id}`} className="font-mono text-sm font-medium underline">
                      {e.expenseNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{e.payeeName}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.categoryAccount.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.expenseDate.toLocaleDateString("en-IN")}
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

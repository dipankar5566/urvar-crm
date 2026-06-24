import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { QUOTATION_STATUS_LABELS, inr } from "@/lib/constants/labels";
import { format } from "date-fns";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "outline",
  SENT: "secondary",
  ACCEPTED: "default",
  REJECTED: "destructive",
  EXPIRED: "outline",
};

export default async function QuotationsPage() {
  const user = await requireUser();
  const scope = can(user.role, "quotations", "read");
  const canWrite = can(user.role, "quotations", "write") !== "none";

  let where: Record<string, unknown> = scopeWhere(scope, user, "createdById");
  if (scope === "territory") {
    where = {
      OR: [
        { customer: { state: { in: user.territoryStates } } },
        { lead: { state: { in: user.territoryStates } } },
      ],
    };
  }

  const quotations = await prisma.quotation.findMany({
    where,
    include: {
      customer: { select: { name: true } },
      lead: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Quotations</h1>
          <p className="text-sm text-muted-foreground">
            {quotations.length} quotation{quotations.length === 1 ? "" : "s"} in your view.
          </p>
        </div>
        {canWrite && (
          <Button render={<Link href="/quotations/new" />}>
            <Plus /> New Quotation
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Linked To</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No quotations yet.
                  </TableCell>
                </TableRow>
              )}
              {quotations.map((q) => (
                <TableRow key={q.id}>
                  <TableCell>
                    <Link href={`/quotations/${q.id}`} className="font-medium hover:underline">
                      {q.quotationNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">
                    {q.customer?.name ?? q.lead?.name ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[q.status] ?? "secondary"}>
                      {QUOTATION_STATUS_LABELS[q.status] ?? q.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{inr(Number(q.totalAmount))}</TableCell>
                  <TableCell className="text-sm">{q.createdBy.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(q.createdAt, "d MMM yyyy")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

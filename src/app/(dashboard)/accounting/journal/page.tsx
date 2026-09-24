import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr, sum, toAmountString } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ReverseEntryButton } from "./journal-actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  POSTED: "default",
  REVERSED: "outline",
  DRAFT: "secondary",
};

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  const { page } = await searchParams;
  const pageNum = Math.max(1, Number(page) || 1);
  const canApprove = can(user.role, "accounting", "approve") !== "none";
  const canWrite = can(user.role, "accounting", "write") !== "none";

  const [entries, total] = await Promise.all([
    prisma.journalEntry.findMany({
      orderBy: [{ entryDate: "desc" }, { entryNumber: "desc" }],
      skip: (pageNum - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        lines: {
          orderBy: { lineNumber: "asc" },
          include: { account: { select: { code: true, name: true } } },
        },
        period: { select: { label: true } },
        postedBy: { select: { name: true } },
      },
    }),
    prisma.journalEntry.count(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal"
        subtitle={
          total === 0
            ? "No entries posted yet. Documents post here automatically once invoicing is live."
            : `${total} entr${total === 1 ? "y" : "ies"}. Posted entries are immutable — corrections are reversals.`
        }
        action={
          canWrite && (
            <Button size="sm" render={<Link href="/accounting/journal/new" />}>New Entry</Button>
          )
        }
      />

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            The ledger is empty.
            <div className="mt-1">
              The chart of accounts and financial periods are set up and ready to receive postings.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => {
            const debits = sum(entry.lines.map((l) => l.debit));
            const credits = sum(entry.lines.map((l) => l.credit));
            const balanced = toAmountString(debits) === toAmountString(credits);
            return (
              <Card key={entry.id}>
                <CardContent className="p-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{entry.entryNumber}</span>
                        <Badge variant={STATUS_VARIANT[entry.status] ?? "secondary"}>
                          {entry.status}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">{entry.sourceType}</Badge>
                        {!balanced && (
                          <Badge variant="outline" className="border-destructive text-destructive">
                            UNBALANCED
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 truncate text-sm text-muted-foreground">
                        {entry.narration}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{entry.entryDate.toLocaleDateString("en-IN")} · {entry.period.label}</div>
                        <div>by {entry.postedBy.name}</div>
                      </div>
                      {canApprove && entry.status === "POSTED" && <ReverseEntryButton entryId={entry.id} />}
                    </div>
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Code</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right w-36">Debit</TableHead>
                        <TableHead className="text-right w-36">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entry.lines.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="font-mono text-xs">{line.account.code}</TableCell>
                          <TableCell>
                            {line.account.name}
                            {line.narration && (
                              <span className="ml-2 text-xs text-muted-foreground">{line.narration}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {Number(line.debit) ? formatInr(line.debit) : ""}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {Number(line.credit) ? formatInr(line.credit) : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="border-t-2 font-medium">
                        <TableCell colSpan={2} className="text-right text-xs uppercase text-muted-foreground">
                          Total
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatInr(debits)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatInr(credits)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {pageNum} of {Math.ceil(total / PAGE_SIZE)}
              </span>
              <div className="flex gap-2">
                {pageNum > 1 && (
                  <Link className="underline" href={`/accounting/journal?page=${pageNum - 1}`}>
                    Previous
                  </Link>
                )}
                {pageNum * PAGE_SIZE < total && (
                  <Link className="underline" href={`/accounting/journal?page=${pageNum + 1}`}>
                    Next
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

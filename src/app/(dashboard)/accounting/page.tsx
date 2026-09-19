import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan } from "@/lib/permissions";
import { validateAccountMappings } from "@/lib/accounting/account-map";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const TYPE_ORDER = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;

const TYPE_LABEL: Record<string, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expenses",
};

export default async function ChartOfAccountsPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");

  const [accounts, balances, mappings, validation] = await Promise.all([
    prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } }),
    // Net movement per account. Balances are always derived from posted lines
    // — no account carries a stored balance column.
    prisma.journalLine.groupBy({
      by: ["accountId"],
      _sum: { debit: true, credit: true },
    }),
    prisma.accountMapping.findMany({ select: { key: true, accountId: true } }),
    validateAccountMappings(),
  ]);

  const movement = new Map(
    balances.map((b) => [
      b.accountId,
      { debit: b._sum.debit ?? 0, credit: b._sum.credit ?? 0 },
    ]),
  );
  const mappedKeys = new Map<string, string[]>();
  for (const m of mappings) {
    mappedKeys.set(m.accountId, [...(mappedKeys.get(m.accountId) ?? []), m.key]);
  }

  const depth = new Map<string, number>();
  for (const a of accounts) {
    let d = 0;
    let cursor = a.parentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      d++;
      cursor = accounts.find((x) => x.id === cursor)?.parentId ?? null;
    }
    depth.set(a.id, d);
  }

  const postable = accounts.filter((a) => a.isPostable).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chart of Accounts"
        subtitle={`${accounts.length} accounts, ${postable} of them postable. Balances are derived from posted journal lines.`}
      />

      {!validation.ok && (
        <Card className="border-destructive">
          <CardContent className="space-y-1 py-4 text-sm">
            <p className="font-medium text-destructive">
              Account mappings need attention — postings that rely on them will fail.
            </p>
            {validation.missing.length > 0 && (
              <p className="text-muted-foreground">
                Missing: {validation.missing.join(", ")}
              </p>
            )}
            {validation.notPostable.map((m) => (
              <p key={m.key} className="text-muted-foreground">
                {m.key} points at {m.code} {m.name}, which is a grouping account.
              </p>
            ))}
            {validation.inactive.map((m) => (
              <p key={m.key} className="text-muted-foreground">
                {m.key} points at {m.code} {m.name}, which is inactive.
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {TYPE_ORDER.map((type) => {
        const rows = accounts.filter((a) => a.type === type);
        if (rows.length === 0) return null;
        return (
          <Card key={type}>
            <CardContent className="p-0">
              <div className="border-b px-4 py-3 text-sm font-semibold">{TYPE_LABEL[type]}</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Code</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="w-28">Normal</TableHead>
                    <TableHead className="text-right">Debits</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((a) => {
                    const m = movement.get(a.id);
                    const debit = Number(m?.debit ?? 0);
                    const credit = Number(m?.credit ?? 0);
                    const net = a.normalBalance === "DEBIT" ? debit - credit : credit - debit;
                    const keys = mappedKeys.get(a.id) ?? [];
                    return (
                      <TableRow key={a.id} className={a.isActive ? "" : "opacity-50"}>
                        <TableCell className="font-mono text-xs">{a.code}</TableCell>
                        <TableCell>
                          <div style={{ paddingLeft: `${(depth.get(a.id) ?? 0) * 16}px` }}>
                            <span className={a.isPostable ? "" : "font-semibold"}>{a.name}</span>
                            {!a.isPostable && (
                              <Badge variant="secondary" className="ml-2 text-[10px]">group</Badge>
                            )}
                            {keys.map((k) => (
                              <Badge key={k} variant="outline" className="ml-1 font-mono text-[10px]">
                                {k}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{a.normalBalance}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {debit ? formatInr(debit) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {credit ? formatInr(credit) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {debit || credit ? formatInr(net) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

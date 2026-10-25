import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can } from "@/lib/permissions";
import { formatInr } from "@/lib/accounting/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TransferChequeButton, ReopenChequeButton } from "./cheque-actions";

export const dynamic = "force-dynamic";

const STATUS_LABEL = { OPEN: "Open", DEPOSITED: "Deposited", CLEARED: "Cleared", CANCELLED: "Cancelled" } as const;

/** Vyapar's Cash & Bank → Cheques screen (docs/VYAPAR_PARITY_SPEC.md §2.3). */
export default async function ChequesPage() {
  const user = await requireUser();
  assertCan(user.role, "accounting", "read");
  const canWrite = can(user.role, "accounting", "write") !== "none";
  const canApprove = can(user.role, "accounting", "approve") !== "none";

  const [cheques, banks] = await Promise.all([
    prisma.cheque.findMany({
      orderBy: [{ status: "asc" }, { chequeDate: "desc" }],
      take: 300,
      include: {
        receipt: { select: { receiptNumber: true, customer: { select: { name: true } } } },
        supplierPayment: { select: { paymentNumber: true, supplier: { select: { name: true } } } },
        bankLedgerAccount: { select: { code: true, name: true } },
      },
    }),
    prisma.ledgerAccount.findMany({
      where: { isPostable: true, isActive: true, parent: { code: "1120" } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cheques"
        subtitle="Received cheques wait in Undeposited Cheques (1115) and issued ones in Unwithdrawn Cheques (2165) until the bank moves them."
      />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Cheque No.</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Bank / Date</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cheques.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                    No cheques yet. Record a receipt deposited to “1115 Undeposited Cheques”, or a supplier payment from
                    “2165 Unwithdrawn Cheques”.
                  </TableCell>
                </TableRow>
              )}
              {cheques.map((c) => {
                const party = c.receipt?.customer.name ?? c.supplierPayment?.supplier.name ?? "—";
                const doc = c.receipt?.receiptNumber ?? c.supplierPayment?.paymentNumber ?? "—";
                return (
                  <TableRow key={c.id} className={c.status === "CANCELLED" ? "opacity-50" : undefined}>
                    <TableCell className="text-xs text-muted-foreground">{c.chequeDate.toLocaleDateString("en-IN")}</TableCell>
                    <TableCell>{c.direction === "RECEIVED" ? "Received" : "Issued"}</TableCell>
                    <TableCell>{party}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{doc}</TableCell>
                    <TableCell className="text-sm">{c.chequeNumber ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatInr(c.amount)}</TableCell>
                    <TableCell>
                      <Badge variant={c.status === "OPEN" ? "default" : "outline"}>{STATUS_LABEL[c.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.bankLedgerAccount
                        ? `${c.bankLedgerAccount.name}, ${c.transferDate?.toLocaleDateString("en-IN") ?? ""}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {c.status === "OPEN" && canWrite && (
                        <TransferChequeButton chequeId={c.id} direction={c.direction} banks={banks} />
                      )}
                      {(c.status === "DEPOSITED" || c.status === "CLEARED") && canApprove && (
                        <ReopenChequeButton chequeId={c.id} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Pencil, FileDown } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { QUOTATION_STATUS_LABELS, inr } from "@/lib/constants/labels";
import { QuotationStatusActions } from "./status-actions";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "outline",
  SENT: "secondary",
  ACCEPTED: "default",
  REJECTED: "destructive",
  EXPIRED: "outline",
};

export default async function QuotationDetailPage({
  params,
}: {
  params: Promise<{ quotationId: string }>;
}) {
  const { quotationId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "quotations", "read");

  let where: Record<string, unknown> = { id: quotationId, ...scopeWhere(scope, user, "createdById") };
  if (scope === "territory") {
    where = {
      id: quotationId,
      OR: [
        { customer: { state: { in: user.territoryStates } } },
        { lead: { state: { in: user.territoryStates } } },
      ],
    };
  }

  const quotation = await prisma.quotation.findFirst({
    where,
    include: {
      customer: { select: { id: true, name: true, customerNumber: true } },
      lead: { select: { id: true, name: true, leadNumber: true } },
      createdBy: { select: { name: true } },
      order: { select: { id: true, orderNumber: true } },
      items: { include: { product: { select: { name: true, sku: true, unit: true } } } },
    },
  });
  if (!quotation) notFound();

  const canWrite = can(user.role, "quotations", "write") !== "none";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{quotation.quotationNumber}</h1>
            <Badge variant={STATUS_VARIANT[quotation.status] ?? "secondary"}>
              {QUOTATION_STATUS_LABELS[quotation.status] ?? quotation.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {quotation.customer ? (
              <Link href={`/customers/${quotation.customer.id}`} className="hover:underline">
                {quotation.customer.name} ({quotation.customer.customerNumber})
              </Link>
            ) : quotation.lead ? (
              <Link href={`/leads/${quotation.lead.id}`} className="hover:underline">
                {quotation.lead.name} ({quotation.lead.leadNumber})
              </Link>
            ) : (
              "—"
            )}
            {" · Created by "}
            {quotation.createdBy.name}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            render={<a href={`/api/quotations/${quotation.id}/pdf`} target="_blank" rel="noreferrer" />}
          >
            <FileDown /> Download PDF
          </Button>
          {canWrite && quotation.status === "DRAFT" && (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/quotations/${quotation.id}/edit`} />}
            >
              <Pencil /> Edit
            </Button>
          )}
        </div>
      </div>

      {canWrite && (
        <QuotationStatusActions
          quotationId={quotation.id}
          status={quotation.status}
          hasCustomer={Boolean(quotation.customerId)}
        />
      )}

      {quotation.order && (
        <Card>
          <CardContent className="py-3 text-sm">
            Order created:{" "}
            <span className="font-medium">{quotation.order.orderNumber}</span>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit Price</TableHead>
                <TableHead>Discount</TableHead>
                <TableHead>Line Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotation.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="font-medium">{item.product.name}</div>
                    <div className="text-xs text-muted-foreground">{item.product.sku}</div>
                  </TableCell>
                  <TableCell>
                    {item.quantity.toString()} {item.product.unit}
                  </TableCell>
                  <TableCell>{inr(Number(item.unitPrice))}</TableCell>
                  <TableCell>{Number(item.discountPercent)}%</TableCell>
                  <TableCell className="font-medium">{inr(Number(item.lineTotal))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Terms & Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="font-medium text-foreground">Valid Until</p>
              <p className="text-muted-foreground">
                {quotation.validUntil ? format(quotation.validUntil, "d MMM yyyy") : "—"}
              </p>
            </div>
            {quotation.termsAndConditions && (
              <div>
                <p className="font-medium text-foreground">Terms & Conditions</p>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {quotation.termsAndConditions}
                </p>
              </div>
            )}
            {quotation.notes && (
              <div>
                <p className="font-medium text-foreground">Internal Notes</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{quotation.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{inr(Number(quotation.subtotal))}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Discount ({Number(quotation.discountPercent)}%)</span>
              <span>− {inr(Number(quotation.discountAmount))}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Tax (GST)</span>
              <span>{inr(Number(quotation.taxAmount))}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Freight</span>
              <span>{inr(Number(quotation.freightAmount))}</span>
            </div>
            <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
              <span>Total</span>
              <span>{inr(Number(quotation.totalAmount))}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

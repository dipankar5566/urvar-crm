import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Phone, Mail, MapPin, FileText, ShoppingCart } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocationDialog } from "./location-dialog";
import { CallButton } from "./call-button";
import { LogCallDialog } from "./log-call-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CUSTOMER_TYPE_LABELS,
  QUOTATION_STATUS_LABELS,
  CALL_DIRECTION_LABELS,
  CALL_OUTCOME_LABELS,
  inr,
} from "@/lib/constants/labels";
import { format } from "date-fns";

const DEALER_TIER_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  GOLD: "default",
  SILVER: "secondary",
  BRONZE: "outline",
};

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "customers", "read");
  const callScope = can(user.role, "calls", "read");

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, ...scopeWhere(scope, user, "assignedToId") },
    include: {
      assignedTo: { select: { id: true, name: true } },
      sourceLead: { select: { id: true, leadNumber: true } },
      quotations: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, quotationNumber: true, status: true, totalAmount: true, createdAt: true },
      },
      orders: {
        orderBy: { orderedAt: "desc" },
        take: 10,
        select: { id: true, orderNumber: true, status: true, paymentStatus: true, totalAmount: true, orderedAt: true },
      },
      calls: {
        where: scopeWhere(callScope, user, "userId"),
        orderBy: { calledAt: "desc" },
        take: 10,
        select: {
          id: true,
          direction: true,
          outcome: true,
          durationSeconds: true,
          recordingUrl: true,
          notes: true,
          calledAt: true,
          user: { select: { name: true } },
        },
      },
    },
  });

  if (!customer) notFound();

  const canWrite = can(user.role, "customers", "write") !== "none";
  const canLogCalls = can(user.role, "calls", "write") !== "none";
  const canViewCalls = callScope !== "none";
  const showCallRep = callScope === "all";
  const isDealerType = customer.dealerTier !== null || customer.territoryAssigned !== null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
            <Badge variant="secondary">{customer.customerNumber}</Badge>
            {customer.dealerTier && (
              <Badge variant={DEALER_TIER_VARIANT[customer.dealerTier] ?? "secondary"}>
                {customer.dealerTier}
              </Badge>
            )}
          </div>
          {customer.companyName && (
            <p className="text-sm text-muted-foreground">{customer.companyName}</p>
          )}
        </div>
        <div className="flex gap-2">
          {canLogCalls && (
            <CallButton
              customerId={customer.id}
              customerName={customer.name}
              className="w-auto justify-center"
            />
          )}
          {canWrite && (
            <Button size="sm" render={<Link href={`/quotations/new?customerId=${customer.id}`} />}>
              <FileText /> New Quotation
            </Button>
          )}
          {canWrite && (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/customers/${customer.id}/edit`} />}
            >
              <Pencil /> Edit
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                {customer.phone}
              </div>
              {customer.email && (
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  {customer.email}
                </div>
              )}
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                {customer.district}, {customer.state}
                {customer.pincode ? ` – ${customer.pincode}` : ""}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {customer.latitude != null && customer.longitude != null && (
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${customer.latitude}&mlon=${customer.longitude}#map=16/${customer.latitude}/${customer.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    View on map
                  </a>
                )}
                {canWrite && (
                  <LocationDialog
                    customerId={customer.id}
                    latitude={customer.latitude}
                    longitude={customer.longitude}
                  />
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2 text-xs text-muted-foreground">
                <div>
                  <p className="font-medium text-foreground">Type</p>
                  {CUSTOMER_TYPE_LABELS[customer.customerType] ?? customer.customerType}
                </div>
                <div>
                  <p className="font-medium text-foreground">Assigned To</p>
                  {customer.assignedTo?.name ?? "Unassigned"}
                </div>
                {customer.gstNumber && (
                  <div>
                    <p className="font-medium text-foreground">GST</p>
                    {customer.gstNumber}
                  </div>
                )}
                {customer.sourceLead && (
                  <div>
                    <p className="font-medium text-foreground">Converted From</p>
                    <Link href={`/leads/${customer.sourceLead.id}`} className="hover:underline">
                      {customer.sourceLead.leadNumber}
                    </Link>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Financials</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Credit Limit</span>
                <span className="font-medium">{inr(customer.creditLimit ? Number(customer.creditLimit) : null)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Outstanding</span>
                <span className="font-medium">{inr(Number(customer.outstandingAmount))}</span>
              </div>
              {isDealerType && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Annual Target</span>
                    <span className="font-medium">
                      {inr(customer.annualTargetValue ? Number(customer.annualTargetValue) : null)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Territory</span>
                    <span className="font-medium">{customer.territoryAssigned ?? "—"}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {canLogCalls && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <LogCallDialog customerId={customer.id} />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quotations</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customer.quotations.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No quotations yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {customer.quotations.map((q) => (
                    <TableRow key={q.id}>
                      <TableCell>
                        <Link href={`/quotations/${q.id}`} className="font-medium hover:underline">
                          {q.quotationNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {QUOTATION_STATUS_LABELS[q.status] ?? q.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{inr(Number(q.totalAmount))}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(q.createdAt, "d MMM yyyy")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShoppingCart className="h-4 w-4" /> Orders
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customer.orders.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No orders yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {customer.orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.orderNumber}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{o.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{o.paymentStatus}</Badge>
                      </TableCell>
                      <TableCell>{inr(Number(o.totalAmount))}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(o.orderedAt, "d MMM yyyy")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {canViewCalls && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Phone className="h-4 w-4" /> Calls
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Direction</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Recording</TableHead>
                      <TableHead>Notes</TableHead>
                      {showCallRep && <TableHead>Rep</TableHead>}
                      <TableHead>Called At</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customer.calls.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={showCallRep ? 7 : 6}
                          className="text-center text-muted-foreground"
                        >
                          No calls logged yet.
                        </TableCell>
                      </TableRow>
                    )}
                    {customer.calls.map((call) => (
                      <TableRow key={call.id}>
                        <TableCell>
                          {CALL_DIRECTION_LABELS[call.direction] ?? call.direction}
                        </TableCell>
                        <TableCell>
                          {call.outcome ? (
                            <Badge variant="secondary">
                              {CALL_OUTCOME_LABELS[call.outcome] ?? call.outcome}
                            </Badge>
                          ) : (
                            <Badge variant="outline">In progress</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {call.durationSeconds ? `${call.durationSeconds}s` : "—"}
                        </TableCell>
                        <TableCell>
                          {call.recordingUrl?.startsWith("/api/voice/recordings/") ? (
                            <audio controls preload="none" src={call.recordingUrl} className="h-8" />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-60 truncate text-muted-foreground">
                          {call.notes ?? "—"}
                        </TableCell>
                        {showCallRep && <TableCell>{call.user.name}</TableCell>}
                        <TableCell className="text-muted-foreground">
                          {format(call.calledAt, "d MMM yyyy, h:mm a")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

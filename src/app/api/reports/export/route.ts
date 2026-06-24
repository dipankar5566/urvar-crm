import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import {
  parseReportFilters,
  getLeadsReport,
  getOrdersReport,
  getQuotationsReport,
} from "@/lib/reports";

type ExportRow = Record<string, string | number>;

async function buildRows(
  type: string,
  user: Awaited<ReturnType<typeof requireUser>>,
  filters: ReturnType<typeof parseReportFilters>,
): Promise<{ rows: ExportRow[]; filename: string } | null> {
  if (type === "leads") {
    const { leads } = await getLeadsReport(user, filters);
    return {
      filename: "leads",
      rows: leads.map((l) => ({
        "Lead #": l.leadNumber,
        Name: l.name,
        Company: l.companyName ?? "",
        Phone: l.phone,
        State: l.state,
        District: l.district,
        Source: l.source,
        Status: l.status,
        "Estimated Value": Number(l.estimatedValue ?? 0),
        "Assigned To": l.assignedTo?.name ?? "Unassigned",
        "Created At": l.createdAt.toISOString().slice(0, 10),
      })),
    };
  }
  if (type === "orders") {
    const { orders } = await getOrdersReport(user, filters);
    return {
      filename: "orders",
      rows: orders.map((o) => ({
        "Order #": o.orderNumber,
        Customer: o.customer.name,
        "Customer #": o.customer.customerNumber,
        State: o.state,
        District: o.district,
        Status: o.status,
        "Payment Status": o.paymentStatus,
        "Total Amount": Number(o.totalAmount),
        "Created By": o.createdBy.name,
        "Ordered At": o.orderedAt.toISOString().slice(0, 10),
      })),
    };
  }
  if (type === "quotations") {
    const { quotations } = await getQuotationsReport(user, filters);
    return {
      filename: "quotations",
      rows: quotations.map((q) => ({
        "Quotation #": q.quotationNumber,
        "Customer/Lead": q.customer?.name ?? q.lead?.name ?? "—",
        Status: q.status,
        "Total Amount": Number(q.totalAmount),
        "Created By": q.createdBy.name,
        "Created At": q.createdAt.toISOString().slice(0, 10),
      })),
    };
  }
  return null;
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (can(user.role, "reports", "read") === "none") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "";
  const format = url.searchParams.get("format") ?? "csv";
  const filters = parseReportFilters({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    repId: url.searchParams.get("repId") ?? undefined,
  });

  const result = await buildRows(type, user, filters);
  if (!result) {
    return new NextResponse("Unknown report type", { status: 400 });
  }
  const { rows, filename } = result;

  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(filename);
    if (rows.length > 0) {
      sheet.columns = Object.keys(rows[0]).map((key) => ({ header: key, key }));
      sheet.addRows(rows);
      sheet.getRow(1).font = { bold: true };
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}.xlsx"`,
      },
    });
  }

  const csv = Papa.unparse(rows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}

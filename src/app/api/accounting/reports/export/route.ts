import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { REPORT_REGISTRY, vyaparFilename, type ReportParams } from "@/lib/accounting/report-registry";
import { renderReportPdf } from "@/lib/pdf/report-pdf";

/**
 * The accounting side of the export registry (Vyapar parity step 4, G13).
 * Deliberately a separate route from `/api/reports/export` (CRM leads/
 * orders/quotations, gated on the `reports` module) — accounting reports
 * are gated on the `accounting` module instead, and the two shouldn't share
 * a permission check that happens to be right for one of them by accident.
 *
 * `?report=<id>&format=xlsx|pdf&from=&to=&asOf=&accountId=&partyId=&partyType=&loanId=`.
 */
export async function GET(req: Request) {
  const user = await requireUser();
  if (can(user.role, "accounting", "read") === "none") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("report") ?? "";
  const entry = REPORT_REGISTRY[id];
  if (!entry) return new NextResponse("Unknown report", { status: 400 });

  const format = url.searchParams.get("format") ?? "xlsx";
  const get = (key: string) => url.searchParams.get(key) ?? undefined;
  const parseDate = (v: string | undefined) => (v ? new Date(v) : undefined);

  const params: ReportParams = {
    from: parseDate(get("from")),
    to: parseDate(get("to")),
    asOf: parseDate(get("asOf")),
    accountId: get("accountId"),
    partyId: get("partyId"),
    partyType: get("partyType") === "SUPPLIER" ? "SUPPLIER" : get("partyType") === "CUSTOMER" ? "CUSTOMER" : undefined,
    loanId: get("loanId"),
  };

  for (const need of entry.needs) {
    if (need === "range" && (!params.from || !params.to)) return new NextResponse("Missing from/to", { status: 400 });
    if (need === "asOf" && !params.asOf) return new NextResponse("Missing asOf", { status: 400 });
    if (need === "accountId" && !params.accountId) return new NextResponse("Missing accountId", { status: 400 });
    if (need === "partyId" && !params.partyId) return new NextResponse("Missing partyId", { status: 400 });
    if (need === "partyType" && !params.partyType) return new NextResponse("Missing partyType", { status: 400 });
    if (need === "loanId" && !params.loanId) return new NextResponse("Missing loanId", { status: 400 });
  }

  let sheets;
  try {
    sheets = await entry.load(params);
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Report failed", { status: 400 });
  }

  const filename = vyaparFilename(entry.title, params.from ?? params.asOf, params.to);

  if (format === "pdf") {
    const rangeLabel =
      params.from && params.to
        ? `${params.from.toLocaleDateString("en-IN")} to ${params.to.toLocaleDateString("en-IN")}`
        : params.asOf
          ? `As of ${params.asOf.toLocaleDateString("en-IN")}`
          : "";
    const buffer = await renderReportPdf(entry.title, rangeLabel, sheets[0] ?? { name: entry.title, rows: [] });
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}.pdf"`,
      },
    });
  }

  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31));
    if (sheet.rows.length > 0) {
      worksheet.columns = Object.keys(sheet.rows[0]).map((key) => ({ header: key || " ", key }));
      worksheet.addRows(sheet.rows);
      worksheet.getRow(1).font = { bold: true };
    }
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

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { canBulkImport } from "@/lib/permissions";
import { buildTemplateWorkbook } from "@/lib/file-parse";
import { IMPORT_FIELD_DEFS } from "@/lib/customer-import";

export async function GET() {
  const user = await requireUser();
  if (!canBulkImport(user.role)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const headers = IMPORT_FIELD_DEFS.map((f) => f.label + (f.required ? " *" : ""));
  const buffer = await buildTemplateWorkbook(headers);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="customer-import-template.xlsx"',
    },
  });
}

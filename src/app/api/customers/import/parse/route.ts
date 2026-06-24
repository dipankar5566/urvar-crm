import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { canBulkImport } from "@/lib/permissions";
import { parseSpreadsheetFile } from "@/lib/file-parse";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!canBulkImport(user.role)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  try {
    const { headers, rows } = await parseSpreadsheetFile(file);
    return NextResponse.json({ headers, rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read this file." },
      { status: 400 },
    );
  }
}

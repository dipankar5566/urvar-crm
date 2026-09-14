import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { canBulkImport } from "@/lib/permissions";
import { kmlToLeadRows } from "@/lib/kml-import";
import { IMPORT_TARGET_FIELDS } from "@/lib/lead-import";

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
  if (!file.name.toLowerCase().endsWith(".kml")) {
    return NextResponse.json({ error: "Upload a .kml file." }, { status: 400 });
  }

  try {
    const xml = await file.text();
    const { rows, skippedCount } = kmlToLeadRows(xml, file.name);
    if (rows.length === 0 && skippedCount === 0) {
      return NextResponse.json({ error: "No placemarks found in this file." }, { status: 400 });
    }
    return NextResponse.json({ headers: IMPORT_TARGET_FIELDS, rows, skippedCount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read this file." },
      { status: 400 },
    );
  }
}

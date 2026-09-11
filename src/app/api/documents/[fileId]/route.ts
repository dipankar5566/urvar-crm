import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { can, scopeWhere } from "@/lib/permissions";
import { readDocument } from "@/lib/documents";

/**
 * Serves an uploaded document.
 *
 * Authorisation follows the call-recording route's pattern: the id is looked
 * up in the database with the caller's scope applied, and the file is only
 * read from disk once that row comes back. The path is never built from
 * anything the client sent.
 *
 * A document is reachable only through whatever it is attached to, so the
 * query asks for a File whose related lead, customer or quotation is itself
 * visible to this user. A File attached to nothing matches no branch and is
 * therefore denied — deny-by-default, which is the right way round for a
 * store that will hold scans of customer paperwork.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const user = await requireUser();

  const leadScope = can(user.role, "leads", "read");
  const customerScope = can(user.role, "customers", "read");
  const quotationScope = can(user.role, "quotations", "read");

  const visible = [
    leadScope !== "none" ? { relatedLead: { is: scopeWhere(leadScope, user, "assignedToId") } } : null,
    customerScope !== "none"
      ? { relatedCustomer: { is: scopeWhere(customerScope, user, "assignedToId") } }
      : null,
    // Quotation has no scalar `state`, so a territory scope cannot be
    // applied to it directly — under that scope it stays reachable through
    // its lead or customer, which the two branches above already cover.
    quotationScope === "all" ? { relatedQuotationId: { not: null } } : null,
    // Scanned supplier invoices. Gated on the `purchases` module rather than
    // any sales one, so a rep who can read leads still cannot open an
    // invoice scan and read supplier pricing off it.
    can(user.role, "purchases", "read") !== "none"
      ? { relatedPurchaseInvoiceId: { not: null } }
      : null,
  ].filter((clause) => clause !== null);

  if (visible.length === 0) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const file = await prisma.file.findFirst({
    where: { id: fileId, OR: visible },
    select: { id: true, fileName: true, mimeType: true },
  });
  if (!file) {
    return new NextResponse("Not found", { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await readDocument(file.id, file.mimeType);
  } catch {
    // Row exists but the file is gone — a restore, or a failed write. Not
    // something the caller can act on, so report it as missing.
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      // Quoted and stripped of quotes/newlines: fileName is user-supplied,
      // and it is only ever used here, in a header, never as a path.
      "Content-Disposition": `inline; filename="${file.fileName.replace(/["\r\n]/g, "")}"`,
      "Content-Length": String(bytes.length),
    },
  });
}

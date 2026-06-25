import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { can, scopeWhere } from "@/lib/permissions";
import { readRecordingFile } from "@/lib/call-recordings";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordingSid: string }> },
) {
  const { recordingSid } = await params;
  const user = await requireUser();
  const scope = can(user.role, "calls", "read");
  if (scope === "none") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const call = await prisma.call.findFirst({
    where: { recordingSid, ...scopeWhere(scope, user, "userId") },
  });
  if (!call) {
    return new NextResponse("Not found", { status: 404 });
  }

  let file: Buffer;
  try {
    file = await readRecordingFile(recordingSid);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const range = req.headers.get("range");
  if (range) {
    const match = /bytes=(\d+)-(\d+)?/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : file.length - 1;
    const chunk = file.subarray(start, end + 1);
    return new NextResponse(new Uint8Array(chunk), {
      status: 206,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Range": `bytes ${start}-${end}/${file.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunk.length),
      },
    });
  }

  return new NextResponse(new Uint8Array(file), {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `inline; filename="${recordingSid}.mp3"`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(file.length),
    },
  });
}

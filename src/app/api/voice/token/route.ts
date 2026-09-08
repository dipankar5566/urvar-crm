import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { getOrCreateEndpoint } from "@/lib/plivo";

export async function GET() {
  const user = await requireUser();
  const { username, password } = await getOrCreateEndpoint(user.id);
  return NextResponse.json({ username, password });
}

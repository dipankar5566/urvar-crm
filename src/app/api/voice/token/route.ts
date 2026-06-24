import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { generateVoiceAccessToken } from "@/lib/twilio";

export async function GET() {
  const user = await requireUser();
  const token = generateVoiceAccessToken(user.id);
  return NextResponse.json({ token });
}

/**
 * Measures how the AI actually talks, from real stored transcripts.
 *
 * This is the script the 2026-09-11 voice audit ran, committed so the same
 * numbers can be produced again after a change instead of being asserted.
 * "It sounds better now" is not evidence; a median turn length that moved
 * from 19 words to 12 is.
 *
 * Read-only: it never writes to the database. Run with `npm run voice:stats`,
 * optionally narrowed to a window: `npm run voice:stats -- 2026-09-11`.
 *
 * Baseline captured 2026-09-11, across 18 calls / 103 AI turns:
 *   AI turn words   mean 19.4  median 19  p90 27  max 40
 *   over 15 words   70%
 *   2+ questions    16 turns
 *   AI:lead ratio   3.22:1
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function mean(values: number[]): string {
  if (values.length === 0) return "0";
  return (values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(1);
}

async function main() {
  const sinceArg = process.argv[2];
  const since = sinceArg ? new Date(sinceArg) : null;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`Not a date: "${sinceArg}". Use YYYY-MM-DD.`);
  }

  const rows = await prisma.call.findMany({
    where: since ? { calledAt: { gte: since } } : undefined,
    orderBy: { calledAt: "asc" },
    select: { calledAt: true, transcript: true, durationSeconds: true },
  });

  const calls = rows.filter((r) => Array.isArray(r.transcript) && r.transcript.length > 0);
  const aiTurns: number[] = [];
  const leadTurns: number[] = [];
  let multiQuestion = 0;
  let duplicates = 0;
  let withMarkdown = 0;
  let withDigits = 0;
  const longest: { count: number; text: string }[] = [];

  for (const call of calls) {
    const lines = (call.transcript as unknown[]).filter((l): l is string => typeof l === "string");
    const ai = lines.filter((l) => l.startsWith("AI:")).map((l) => l.slice(3).trim());
    const lead = lines.filter((l) => l.startsWith("Lead:")).map((l) => l.slice(5).trim());

    const seen = new Set<string>();
    for (const line of ai) {
      const count = words(line);
      aiTurns.push(count);
      longest.push({ count, text: line });
      if ((line.match(/\?/g) ?? []).length >= 2) multiQuestion++;
      if (seen.has(line)) duplicates++;
      else seen.add(line);
      if (/[*#_`]/.test(line)) withMarkdown++;
      if (/[0-9]/.test(line)) withDigits++;
    }
    for (const line of lead) leadTurns.push(words(line));
  }

  if (aiTurns.length === 0) {
    console.log("No transcripts in range — nothing to measure.");
    await prisma.$disconnect();
    return;
  }

  const sortedAi = [...aiTurns].sort((a, b) => a - b);
  const sortedLead = [...leadTurns].sort((a, b) => a - b);
  const over15 = sortedAi.filter((w) => w > 15).length;
  const over30 = sortedAi.filter((w) => w > 30).length;
  const aiWords = aiTurns.reduce((s, w) => s + w, 0);
  const leadWords = leadTurns.reduce((s, w) => s + w, 0);
  const pct = (n: number) => `${((100 * n) / sortedAi.length).toFixed(0)}%`;

  console.log(`calls with transcripts: ${calls.length}${since ? ` (since ${sinceArg})` : ""}`);
  console.log("");
  console.log("=== AI TURN LENGTH (target 5-15 words) ===");
  console.log(
    `n=${sortedAi.length}  mean=${mean(aiTurns)}  median=${percentile(sortedAi, 0.5)}  p90=${percentile(sortedAi, 0.9)}  max=${sortedAi[sortedAi.length - 1]}`,
  );
  console.log(`over 15 words: ${over15} (${pct(over15)})   over 30 words: ${over30} (${pct(over30)})`);
  console.log("");
  console.log("=== CONVERSATION SHAPE ===");
  console.log(`turns with 2+ question marks: ${multiQuestion}  (target ~0 — ask one thing at a time)`);
  console.log(`exact duplicate AI lines in the same call: ${duplicates}`);
  console.log(`lines with markdown characters: ${withMarkdown}   with digits: ${withDigits}`);
  console.log(
    `lead turns: n=${sortedLead.length} mean=${mean(leadTurns)} median=${percentile(sortedLead, 0.5)}`,
  );
  console.log(
    `AI:lead word ratio = ${leadWords > 0 ? (aiWords / leadWords).toFixed(2) : "n/a"}:1  (target <=1.5 — the lead should talk more)`,
  );
  console.log("");
  console.log("=== 3 LONGEST AI TURNS ===");
  longest.sort((a, b) => b.count - a.count);
  for (const turn of longest.slice(0, 3)) {
    console.log(`[${turn.count} words] ${turn.text.slice(0, 260)}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

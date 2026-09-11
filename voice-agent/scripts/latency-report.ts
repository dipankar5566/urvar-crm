/**
 * Turns the `[turn]` and `[call-metrics]` log lines written by
 * pipeline/turn-metrics.ts into a latency table.
 *
 * Those lines are logfmt precisely so they can be read with grep and awk when
 * that is quicker; this exists for when it stops being quicker. Run with
 * `npm run voice:latency`, optionally against specific files:
 *
 *   npm run voice:latency -- logs/voice-agent-out-4.log
 *
 * Reports medians and p90 rather than best cases, because the question is
 * what a caller usually experiences, not what the pipeline manages on a good
 * run. Read-only; touches nothing but the log files.
 */
import { readFileSync, readdirSync } from "fs";
import path from "path";

const LOG_DIR = path.resolve(process.env.VOICE_AGENT_LOG_DIR || "./logs");

/** Stages in the order the caller experiences them. `-1` means never reached
 * — a tool-only turn produces no sentence, for instance. */
const STAGES = ["queued", "llm", "ttft", "sentence", "tts", "play", "total"] as const;

function percentile(values: number[], q: number): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function field(line: string, key: string): string | null {
  const match = line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
  return match ? match[1] : null;
}

function numericField(line: string, key: string): number | null {
  const raw = field(line, key);
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function logFiles(): string[] {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.map((f) => path.resolve(f));
  return readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("voice-agent-out") && f.endsWith(".log"))
    .map((f) => path.join(LOG_DIR, f));
}

function main() {
  const files = logFiles();
  const turnLines: string[] = [];
  const callLines: string[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      console.error(`skipped unreadable file: ${file}`);
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith("[turn]")) turnLines.push(line);
      else if (line.startsWith("[call-metrics]")) callLines.push(line);
    }
  }

  console.log(`read ${files.length} log file(s): ${turnLines.length} turns, ${callLines.length} calls`);
  if (turnLines.length === 0) {
    console.log("");
    console.log("No [turn] lines found. Either no AI call has run since the telemetry");
    console.log("shipped, or the log directory is wrong (set VOICE_AGENT_LOG_DIR).");
    return;
  }

  console.log("");
  console.log("=== PER-TURN LATENCY, ms from the moment the lead stopped speaking ===");
  console.log("stage      n     p50     p90     max");
  for (const stage of STAGES) {
    const values = turnLines
      .map((l) => numericField(l, stage))
      .filter((v): v is number => v != null && v >= 0);
    if (values.length === 0) {
      console.log(`${stage.padEnd(10)} 0     -       -       -`);
      continue;
    }
    console.log(
      `${stage.padEnd(10)} ${String(values.length).padEnd(5)} ${String(percentile(values, 0.5)).padEnd(7)} ${String(percentile(values, 0.9)).padEnd(7)} ${Math.max(...values)}`,
    );
  }

  const fillers = turnLines.filter((l) => field(l, "filler") === "1").length;
  const stalls = turnLines.filter((l) => field(l, "stalled") === "1").length;
  const bargeCounts = new Map<string, number>();
  for (const line of turnLines) {
    const stage = field(line, "barge") ?? "none";
    bargeCounts.set(stage, (bargeCounts.get(stage) ?? 0) + 1);
  }

  console.log("");
  console.log("=== TURN OUTCOMES ===");
  console.log(`filler word needed: ${fillers}/${turnLines.length} (model slower than the filler delay)`);
  console.log(`provider stalls:    ${stalls}/${turnLines.length}`);
  console.log(
    `barge-in stages:    ${[...bargeCounts.entries()].map(([k, v]) => `${k}=${v}`).join("  ") || "none"}`,
  );
  console.log("  A=held only, B=committed interrupt, abort=resumed (false alarm)");

  if (callLines.length > 0) {
    console.log("");
    console.log("=== AUDIO TRANSPORT (is the tunnel the bottleneck?) ===");
    for (const key of ["frameGapP50", "frameGapP90", "frameGapMax", "clearAckP50"]) {
      const values = callLines
        .map((l) => numericField(l, key))
        .filter((v): v is number => v != null && v >= 0);
      if (values.length === 0) continue;
      console.log(`${key.padEnd(14)} median across calls = ${percentile(values, 0.5)}ms`);
    }
    const longGaps = callLines
      .map((l) => numericField(l, "longGaps"))
      .filter((v): v is number => v != null);
    const callsWithGaps = longGaps.filter((v) => v > 0).length;
    console.log(
      `calls with audio gaps over 500ms: ${callsWithGaps}/${longGaps.length}` +
        " — past ~5%, or frameGapP90 over 200ms, the transport is the problem",
    );
  }
}

main();

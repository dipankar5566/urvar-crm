/**
 * Multi-turn evaluation of the voice agent's conversation model.
 *
 * Single-turn probes suggested `sarvam-105b-conversations` had unreliable
 * tool judgement (it called end_call on "yes, I'm buying"), but those probes
 * had no conversation history, which is not how the agent runs. This replays
 * scripted calls turn by turn with full history, against the real system
 * prompt and the real CRM tool schemas, and scores the incumbent on the
 * identical scripts — a pass rate means nothing without the baseline.
 *
 * Tool execution is STUBBED. This evaluates the model's decisions, not the
 * tools, and must never create FollowUps or set doNotCall on real leads.
 *
 * Run:  npm run eval:agent
 */
import "dotenv/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { CRM_TOOLS } from "../tools/crm-tools.js";
import { buildSystemPrompt } from "../pipeline/openai-agent.js";
import { completionBody, getProvider, type LlmProvider } from "../pipeline/llm-provider.js";

/** Synthetic fixture — deliberately not read from the database. */
const LEAD = {
  name: "Dipankar Chanda",
  state: "West Bengal",
  district: "North 24 Parganas",
  status: "NEW",
  customerType: "B2C_FARMER",
  interestedProducts: "Vermicompost",
  expectedQuantity: "1 ton",
};

const SYSTEM = buildSystemPrompt(LEAD, "Bengali");

/** What each tool would have returned, had we let it run. get_product_info
 * mirrors the real post-fix shape: no mrp field, priceOnRequest instead. */
const TOOL_STUBS: Record<string, unknown> = {
  get_lead_context: LEAD,
  get_product_info: {
    products: [{ name: "Enriched Vermicompost", category: "ORGANIC_MANURE", unit: "kg", packSize: "25", priceOnRequest: true }],
  },
  check_quotation_status: { quotations: [] },
  schedule_follow_up: { scheduled: true },
  mark_do_not_call: { marked: true },
  end_call: { ended: true },
};

type Check = {
  /** Tool the model is expected to call on this turn. */
  mustCall?: string;
  /** Tools that would be wrong here. */
  mustNotCall?: string[];
  /** Spoken reply must not match this (e.g. quoting a price we don't have). */
  mustNotSay?: { pattern: RegExp; why: string };
  why: string;
};

type Scenario = { name: string; turns: { lead: string; check: Check }[] };

const SCENARIOS: Scenario[] = [
  {
    name: "Interested buyer (real call replay)",
    turns: [
      { lead: "Hello", check: { mustNotCall: ["end_call", "mark_do_not_call"], why: "opening hello — must not end the call" } },
      { lead: "হ্যাঁ ভাবছি বলুন", check: { mustNotCall: ["end_call"], why: "lead is engaged — must not end" } },
      { lead: "আমি রজনীগন্ধা ফুলের জন্য vermicompost খুঁজছি মোটামুটি ১০ টন মতো।", check: { mustNotCall: ["end_call"], why: "10 ton enquiry — must keep qualifying" } },
      { lead: "কবের মধ্যে delivery হবে আর rate কি আছে?", check: { mustCall: "get_product_info", why: "price question — must check before answering" } },
      { lead: "আচ্ছা ঠিক আছে, ধন্যবাদ।", check: { mustCall: "end_call", why: "clear closing cue — must wrap up" } },
    ],
  },
  {
    name: "Price with no price in the system",
    turns: [
      { lead: "Hello", check: { mustNotCall: ["end_call"], why: "opening" } },
      { lead: "vermicompost er rate koto?", check: { mustCall: "get_product_info", why: "must look it up" } },
      {
        lead: "হ্যাঁ বলুন",
        check: {
          mustNotSay: { pattern: /\bMRP\b|\bsystem\b|সিস্টেম|শূন্য/i, why: "leaked an internal value or system reference" },
          why: "after priceOnRequest — must offer a quotation, never a number",
        },
      },
    ],
  },
  {
    name: "Asks to speak to a person",
    turns: [
      { lead: "Hello", check: { mustNotCall: ["end_call"], why: "opening" } },
      {
        lead: "আমি একজন representative এর সাথে সরাসরি কথা বলতে চাই।",
        check: {
          mustNotSay: { pattern: /connect ক|লাইনে থাকুন|connecting you|hold the line/i, why: "promised a live transfer we cannot do" },
          why: "must offer a callback, not a transfer",
        },
      },
    ],
  },
  {
    name: "Do not call again",
    turns: [
      { lead: "Hello", check: { mustNotCall: ["end_call"], why: "opening" } },
      { lead: "আমাকে আর কখনও ফোন করবেন না।", check: { mustCall: "mark_do_not_call", why: "explicit opt-out" } },
    ],
  },
  {
    name: "Not interested (but no opt-out)",
    turns: [
      { lead: "Hello", check: { mustNotCall: ["end_call"], why: "opening" } },
      { lead: "না, আমার এখন কোনও দরকার নেই।", check: { mustNotCall: ["mark_do_not_call"], why: "not interested is not the same as opt-out" } },
    ],
  },
  {
    name: "Unclear backchannel (the repetition trap)",
    turns: [
      { lead: "Hello", check: { mustNotCall: ["end_call"], why: "opening" } },
      { lead: "Bataiye", check: { mustNotCall: ["end_call"], why: "lead just wants us to continue" } },
      { lead: "Hello? Bataiye na", check: { mustNotCall: ["end_call"], why: "still waiting — must rephrase, not hang up" } },
    ],
  },
];

/** end_call / mark_do_not_call finish the conversation in the real agent. */
function isTerminal(tool: string | null) {
  return tool === "end_call" || tool === "mark_do_not_call";
}

type TurnResult = { tool: string | null; reply: string; ttft: number };

async function runTurn(
  provider: LlmProvider,
  history: ChatCompletionMessageParam[],
  utterance: string,
): Promise<TurnResult> {
  history.push({ role: "user", content: utterance });
  let firstTool: string | null = null;
  let reply = "";
  let ttft = 0;

  // Mirrors runAgentTurn's tool loop, with stubbed execution.
  for (let hop = 0; hop < 4; hop++) {
    const t0 = Date.now();
    // Built through the same helper the live agent uses, so this exercises
    // the real provider config rather than a parallel copy of it.
    const stream = await provider.client.chat.completions.create(
      completionBody(provider, { messages: history, tools: CRM_TOOLS, stream: true }, 220) as never,
    );

    let content = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of stream as never as AsyncIterable<{
      choices: { delta: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    }>) {
      const d = chunk.choices[0]?.delta;
      if (d?.content) {
        if (!ttft) ttft = Date.now() - t0;
        content += d.content;
      }
      for (const tc of d?.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        calls.set(tc.index, slot);
      }
    }

    const toolCalls = [...calls.values()].filter((c) => c.name);
    if (toolCalls.length === 0) {
      history.push({ role: "assistant", content });
      reply = content.trim();
      break;
    }

    if (!firstTool) firstTool = toolCalls[0].name;
    history.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
    });
    for (const c of toolCalls) {
      history.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(TOOL_STUBS[c.name] ?? { ok: true }) });
    }
    if (isTerminal(firstTool)) {
      reply = content.trim();
      break;
    }
  }

  return { tool: firstTool, reply, ttft };
}

type Failure = { scenario: string; problem: string };

async function evaluate(label: string, provider: LlmProvider) {
  const failures: Failure[] = [];
  let checks = 0;
  const ttfts: number[] = [];
  console.log(`\n${"=".repeat(76)}\n${label}  ${provider.name} / ${provider.model}\n${"=".repeat(76)}`);

  for (const scenario of SCENARIOS) {
    console.log(`\n  ${scenario.name}`);
    const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }];
    for (const { lead, check } of scenario.turns) {
      let r: TurnResult;
      try {
        r = await runTurn(provider, history, lead);
      } catch (err) {
        console.log(`    ERR  request failed: ${(err as Error).message.slice(0, 80)}`);
        failures.push({ scenario: scenario.name, problem: "request failed" });
        break;
      }
      if (r.ttft) ttfts.push(r.ttft);

      const problems: string[] = [];
      if (check.mustCall) {
        checks++;
        if (r.tool !== check.mustCall) problems.push(`expected ${check.mustCall}, got ${r.tool ?? "no tool"}`);
      }
      for (const bad of check.mustNotCall ?? []) {
        checks++;
        if (r.tool === bad) problems.push(`called ${bad} — ${check.why}`);
      }
      if (check.mustNotSay) {
        checks++;
        if (check.mustNotSay.pattern.test(r.reply)) problems.push(check.mustNotSay.why);
      }

      const said = r.tool ? `TOOL:${r.tool}` : `"${r.reply.replace(/\s+/g, " ").slice(0, 54)}"`;
      console.log(`    ${problems.length ? "FAIL" : "ok  "} "${lead.slice(0, 32)}" -> ${said}`);
      for (const p of problems) {
        console.log(`         ${p}`);
        failures.push({ scenario: scenario.name, problem: p });
      }
      if (isTerminal(r.tool)) break;
    }
  }

  const sorted = [...ttfts].sort((a, b) => a - b);
  return { model: provider.model, checks, failures, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0 };
}

async function main() {
  const results = [
    await evaluate("INCUMBENT", getProvider("openai")),
    await evaluate("CANDIDATE", getProvider("sarvam")),
  ];

  console.log(`\n${"=".repeat(76)}\nSUMMARY\n${"=".repeat(76)}`);
  for (const r of results) {
    console.log(
      `  ${r.model.padEnd(28)} ${String(r.checks - r.failures.length).padStart(2)}/${r.checks} checks   median TTFT ${r.median}ms`,
    );
    for (const f of r.failures) console.log(`       - [${f.scenario}] ${f.problem}`);
  }
}

main();

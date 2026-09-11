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
import { writeFileSync } from "fs";
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

/**
 * The catalogue the agent now receives in its system prompt at call start.
 *
 * The harness used to build the prompt with no catalogue at all, which made
 * every price scenario test an unreachable path: with nothing loaded the
 * agent can only promise a callback, so "must call get_product_info" passed
 * for the wrong reason. One priced and one unpriced row, because those are
 * genuinely different conversations.
 */
const CATALOGUE = [
  {
    name: "Enriched Vermicompost",
    category: "VERMICOMPOST",
    unit: "kg",
    packSize: "25",
    mrp: 450,
    description: null,
  },
  {
    name: "Urvar PROM",
    category: "PROM",
    unit: "kg",
    packSize: "50",
    mrp: null,
    description: null,
  },
];

const LANGUAGES = ["Bengali", "Hindi", "Indian English"] as const;
type Language = (typeof LANGUAGES)[number];

/** Built once per language rather than once per run: the prompt's language is
 * what the agent opens in, and testing only Bengali left Hindi and English
 * entirely unexercised. */
const SYSTEM_BY_LANGUAGE = new Map<Language, string>(
  LANGUAGES.map((language) => [language, buildSystemPrompt(LEAD, language, { products: CATALOGUE })]),
);

/** What each tool would have returned, had we let it run. */
const TOOL_STUBS: Record<string, unknown> = {
  get_lead_context: LEAD,
  get_product_info: {
    products: [],
    notInCatalogue: true,
    message: "No such product in the Urvar catalogue.",
  },
  check_quotation_status: { quotations: [] },
  schedule_follow_up: { scheduled: true },
  mark_do_not_call: { marked: true },
  transfer_to_human: { transferring: true },
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

type Scenario = { name: string; language: Language; turns: { lead: string; check: Check }[] };

/** Said aloud in the caller's language every time, so it is worth naming once. */
const OPENING = { mustNotCall: ["end_call", "mark_do_not_call"], why: "opening — must not end the call" };

const SCENARIOS: Scenario[] = [
  // ---------------------------------------------------------------- Bengali
  {
    name: "BN Interested buyer (real call replay)",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "হ্যাঁ ভাবছি বলুন", check: { mustNotCall: ["end_call"], why: "lead is engaged — must not end" } },
      { lead: "আমি রজনীগন্ধা ফুলের জন্য vermicompost খুঁজছি মোটামুটি ১০ টন মতো।", check: { mustNotCall: ["end_call"], why: "10 ton enquiry — must keep qualifying" } },
      {
        lead: "কবের মধ্যে delivery হবে আর rate কি আছে?",
        check: {
          mustNotCall: ["get_product_info", "end_call"],
          why: "vermicompost is preloaded in the prompt — a tool hop here is a second of dead air",
        },
      },
      { lead: "আচ্ছা ঠিক আছে, ধন্যবাদ।", check: { mustCall: "end_call", why: "clear closing cue — must wrap up" } },
    ],
  },
  {
    name: "BN Price for a product with no price on file",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      {
        lead: "PROM er rate koto?",
        check: {
          mustNotSay: { pattern: /\bMRP\b|\bsystem\b|সিস্টেম|শূন্য|\b0\b/i, why: "leaked an internal value or system reference" },
          why: "price is unset — must offer to confirm, never a number",
        },
      },
    ],
  },
  {
    name: "BN Price question alone is NOT a buying signal",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      {
        lead: "vermicompost er dam koto?",
        check: {
          mustNotCall: ["transfer_to_human"],
          why: "asking a price is a question, not an intent to buy — transferring here burns a rep on every enquiry",
        },
      },
    ],
  },
  {
    name: "BN Wants to order now (hot lead)",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "আমি ১০০ ব্যাগ vermicompost order করতে চাই, এখনই।", check: { mustCall: "transfer_to_human", why: "explicit order intent — hand to a person immediately" } },
    ],
  },
  {
    name: "BN Asks to speak to a person",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "আমি একজন representative এর সাথে সরাসরি কথা বলতে চাই।", check: { mustCall: "transfer_to_human", why: "asked for a human — connect them" } },
    ],
  },
  {
    name: "BN Do not call again",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "আমাকে আর কখনও ফোন করবেন না।", check: { mustCall: "mark_do_not_call", why: "explicit opt-out" } },
    ],
  },
  {
    name: "BN Not interested (but no opt-out)",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "না, আমার এখন কোনও দরকার নেই।", check: { mustNotCall: ["mark_do_not_call"], why: "not interested is not the same as opt-out" } },
    ],
  },
  {
    name: "BN Unclear backchannel (the repetition trap)",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "Bataiye", check: { mustNotCall: ["end_call"], why: "lead just wants us to continue" } },
      { lead: "Hello? Bataiye na", check: { mustNotCall: ["end_call"], why: "still waiting — must rephrase, not hang up" } },
    ],
  },
  {
    name: "BN Price objection",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "আপনাদের দাম অনেক বেশি, অন্য কোম্পানি সস্তায় দিচ্ছে।", check: { mustNotCall: ["end_call"], why: "an objection is a conversation, not a goodbye" } },
    ],
  },
  {
    name: "BN Angry customer",
    language: "Bengali",
    turns: [
      { lead: "Hello", check: OPENING },
      {
        lead: "আপনারা রোজ ফোন করে বিরক্ত করছেন! কী চাই?",
        check: {
          mustNotCall: ["mark_do_not_call"],
          why: "annoyance is not an opt-out request — apologise and ask, do not silently blacklist",
        },
      },
    ],
  },
  // ------------------------------------------------------------------ Hindi
  {
    name: "HI Cooperative farmer",
    language: "Hindi",
    turns: [
      { lead: "हाँ जी बोलिए", check: OPENING },
      { lead: "मेरे पास दस एकड़ जमीन है, धान लगाता हूँ।", check: { mustNotCall: ["end_call"], why: "engaged lead — keep qualifying" } },
      { lead: "अभी DAP इस्तेमाल कर रहा हूँ।", check: { mustNotCall: ["end_call"], why: "current-input answer — continue discovery" } },
    ],
  },
  {
    name: "HI Price question, preloaded product",
    language: "Hindi",
    turns: [
      { lead: "हैलो", check: OPENING },
      {
        lead: "वर्मीकम्पोस्ट का रेट क्या है?",
        check: {
          mustNotCall: ["get_product_info", "transfer_to_human"],
          why: "price is in the prompt and a price question is not buying intent",
        },
      },
    ],
  },
  {
    name: "HI Impatient customer",
    language: "Hindi",
    turns: [
      { lead: "हाँ", check: OPENING },
      { lead: "जल्दी बोलिए, मैं व्यस्त हूँ।", check: { mustNotCall: ["end_call"], why: "busy is a reason to offer a callback, not to hang up mid-sentence" } },
    ],
  },
  {
    name: "HI Wants dealership (hot lead)",
    language: "Hindi",
    turns: [
      { lead: "हैलो", check: OPENING },
      { lead: "मुझे आपकी डीलरशिप लेनी है, कैसे मिलेगी?", check: { mustCall: "transfer_to_human", why: "dealership enquiry is high intent" } },
    ],
  },
  {
    name: "HI Do not call again",
    language: "Hindi",
    turns: [
      { lead: "हैलो", check: OPENING },
      { lead: "दोबारा फ़ोन मत करना।", check: { mustCall: "mark_do_not_call", why: "explicit opt-out in Hindi" } },
    ],
  },
  {
    name: "HI Callback request",
    language: "Hindi",
    turns: [
      { lead: "हैलो", check: OPENING },
      { lead: "अभी नहीं, शाम को फ़ोन कीजिए।", check: { mustCall: "schedule_follow_up", why: "asked for a specific callback time" } },
    ],
  },
  // ---------------------------------------------------------------- English
  {
    name: "EN Distributor asking for a price list",
    language: "Indian English",
    turns: [
      { lead: "Yes, hello", check: OPENING },
      { lead: "I run an agri input shop. Can you send me your price list?", check: { mustCall: "transfer_to_human", why: "price-list request from a trade buyer is high intent" } },
    ],
  },
  {
    name: "EN Confused customer",
    language: "Indian English",
    turns: [
      { lead: "Hello? Who is this?", check: OPENING },
      { lead: "Sorry, I did not understand. What company did you say?", check: { mustNotCall: ["end_call"], why: "confusion means clarify, not hang up" } },
    ],
  },
  {
    name: "EN Product objection",
    language: "Indian English",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "I have never used organic fertilizer. Will it actually work?", check: { mustNotCall: ["end_call"], why: "a doubt is an objection to handle" } },
      {
        lead: "How much yield increase will I get?",
        check: {
          mustNotSay: { pattern: /\b\d+\s?(%|percent|quintal|ton)/i, why: "promised a yield figure nobody gave it" },
          why: "must never promise a quantified result",
        },
      },
    ],
  },
  {
    name: "EN Asks something unrelated",
    language: "Indian English",
    turns: [
      { lead: "Hello", check: OPENING },
      { lead: "Do you also sell tractors?", check: { mustNotCall: ["end_call"], why: "off-catalogue question — say no and steer back, do not end" } },
    ],
  },
  {
    name: "EN Switches language mid-call",
    language: "Indian English",
    turns: [
      { lead: "Hello, yes", check: OPENING },
      { lead: "আমি বাংলায় কথা বলতে চাই।", check: { mustNotCall: ["end_call"], why: "a language switch must be followed, not treated as a failure" } },
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
  /** A provider that times out has not failed a check — it has failed to
   * answer. Counting those as check failures made a flaky network look like a
   * worse model, which is how a six-scenario run once reported "7/9". */
  let stalls = 0;
  const ttfts: number[] = [];
  console.log(`\n${"=".repeat(76)}\n${label}  ${provider.name} / ${provider.model}\n${"=".repeat(76)}`);

  for (const scenario of SCENARIOS) {
    console.log(`\n  ${scenario.name}  [${scenario.language}]`);
    const system = SYSTEM_BY_LANGUAGE.get(scenario.language);
    if (!system) throw new Error(`No system prompt built for language "${scenario.language}"`);
    const history: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
    for (const { lead, check } of scenario.turns) {
      let r: TurnResult;
      try {
        r = await runTurn(provider, history, lead);
      } catch (err) {
        console.log(`    STALL  provider did not answer: ${(err as Error).message.slice(0, 70)}`);
        stalls++;
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
  return {
    model: provider.model,
    checks,
    failures,
    stalls,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
  };
}

async function main() {
  const results = [
    await evaluate("INCUMBENT", getProvider("openai")),
    await evaluate("CANDIDATE", getProvider("sarvam")),
  ];

  console.log(`\n${"=".repeat(76)}\nSUMMARY\n${"=".repeat(76)}`);
  console.log(`  ${SCENARIOS.length} scenarios across ${LANGUAGES.length} languages`);
  for (const r of results) {
    console.log(
      `  ${r.model.padEnd(28)} ${String(r.checks - r.failures.length).padStart(2)}/${r.checks} checks   ${r.stalls} stalls   median TTFT ${r.median}ms`,
    );
    for (const f of r.failures) console.log(`       - [${f.scenario}] ${f.problem}`);
  }

  if (process.env.EVAL_REPORT) {
    writeFileSync(process.env.EVAL_REPORT, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
    console.log(`\n  report written to ${process.env.EVAL_REPORT}`);
  }

  // Non-zero exit so this can gate a deploy. Stalls do not fail the run —
  // they say the provider was unreachable, not that the agent misbehaved.
  const failed = results.reduce((sum, r) => sum + r.failures.length, 0);
  if (failed > 0) process.exitCode = 1;
}

main();

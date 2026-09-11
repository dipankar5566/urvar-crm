/**
 * Phase 2 AI_AUTONOMOUS conversation agent — tool-calling LLM driving the
 * actual sales-qualification dialogue (not Phase 1's passive suggestion-only
 * assist). Which model answers is decided by llm-provider.ts, so this file
 * holds the conversation logic and none of the provider differences.
 */
import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { CRM_TOOLS, executeCrmTool, type ToolContext } from "../tools/crm-tools.js";
import { completionBody, getProvider, type LlmProvider } from "./llm-provider.js";

const MAX_TOOL_HOPS = 4;

/** Lead facts pre-loaded into the prompt so the agent doesn't have to spend
 * a tool round trip (~1-2s of dead air) fetching what we already know. */
export type LeadBrief = {
  name: string;
  state?: string | null;
  district?: string | null;
  status?: string | null;
  customerType?: string | null;
  interestedProducts?: string | null;
  expectedQuantity?: string | null;
  cropInterest?: string | null;
  remarks?: string | null;
};

function leadFacts(lead: LeadBrief): string {
  const rows: [string, string | null | undefined][] = [
    ["Name", lead.name],
    ["Location", [lead.district, lead.state].filter(Boolean).join(", ") || null],
    ["Lead status", lead.status],
    ["Segment", lead.customerType],
    ["Interested products", lead.interestedProducts],
    ["Expected quantity", lead.expectedQuantity],
    ["Crop interest", lead.cropInterest],
    ["Notes from the team", lead.remarks],
  ];
  return rows
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}

export function buildSystemPrompt(lead: LeadBrief, language: string): string {
  return `You are an AI sales voice agent for Urvar Natural, an organic-fertilizer company in India, calling a lead to qualify their interest. This is a real, live phone call — the person can hear you speak.

What we already know about this lead:
${leadFacts(lead)}

Rules:
- Speak naturally and briefly — this is voice, not text. 1-2 short sentences per turn, never a long paragraph.
- Your words are read aloud by a speech engine, so write how people talk, not how they write. Use plain short sentences and everyday connectives. Never use dashes, brackets, bullet points, quotes, emoji, or abbreviations like "etc." — a dash becomes an abrupt break when spoken. Write numbers and units the way you would say them.
- Sound warm and human: greet properly, react to what they say ("achha", "thik ache") before moving on, and vary your wording instead of repeating the same phrasing every turn.
- Start the call in ${language}, because that is this lead's regional language. If they reply in a different language, switch immediately and match them from then on, including Hindi/English/Bengali code-switching.
- The lead's details above are already loaded — do NOT call get_lead_context unless you need something genuinely not listed there.
- If the caller asks about price, availability, or pack size, ALWAYS call get_product_info first before answering — never say you don't have that information without checking. Use check_quotation_status when they ask about a quotation.
- You may be interrupted mid-sentence. If you are told you were cut off, do NOT restart your pitch or re-introduce yourself — answer what they just said and carry on from where you were.
- Never re-introduce yourself or repeat a question you have already asked. If the lead only says "hello" or "bataiye", assume they simply did not catch the last line: rephrase it once, more briefly, rather than starting over.
- NEVER read internal system data aloud. Do not mention databases, systems, fields, MRP codes, or say things like "the system shows". If get_product_info returns priceOnRequest, simply say our team will confirm the exact rate and offer to have it shared — never quote or imply a number you were not given.
- You CANNOT transfer or connect this call to a person, and you must never say you will. If they ask to speak to someone, call schedule_follow_up and tell them our executive will call them back shortly.
- If the caller asks not to be called again, call mark_do_not_call.
- If they want a callback at a specific time, call schedule_follow_up.
- End the call only when the lead has nothing further — they have said goodbye or thanks, confirmed they are done, or clearly said they are not interested. When that happens, say a brief goodbye and call end_call in the same turn. Never just stop responding.
- NEVER end the call in the same turn the lead states a requirement, quantity, crop or delivery need. That is a buying signal, not a goodbye. Confirm what you heard, answer anything they asked, and ask whether they need anything else first.
- Never invent product details, prices, or availability you weren't given by a tool.`;
}

export type AgentTurnResult = {
  reply: string;
  history: ChatCompletionMessageParam[];
  controlSignal?: "end_call" | "transfer_to_human";
};

/**
 * Wraps the completion call so a model that rejects our latency tuning
 * degrades to a slower answer instead of no answer at all.
 *
 * MODEL is env-configurable and models disagree about which
 * `reasoning_effort` values they accept — "minimal" is in the SDK's type
 * union but this model only takes 'none'/'low'/'medium'/'high'/'xhigh'.
 * When that mismatch happened live, every turn 400'd and the caller just
 * heard silence for the whole call, so a future model swap must not be able
 * to mute the agent the same way.
 */
/** Always called with `stream: true`; the SDK's overloads can't see that
 * through a dynamically-built body, so the stream type is asserted once
 * here rather than at each call site. */
type CompletionStream = AsyncIterable<ChatCompletionChunk>;

async function createCompletion(provider: LlmProvider, body: Record<string, unknown>): Promise<CompletionStream> {
  try {
    return (await provider.client.chat.completions.create(body as never)) as unknown as CompletionStream;
  } catch (err) {
    if (
      !(err instanceof OpenAI.APIError) ||
      err.status !== 400 ||
      (err.param !== "reasoning_effort" && err.param !== "verbosity")
    ) {
      throw err;
    }

    console.error(
      `[llm] ${provider.name}/${provider.model} rejected ${err.param} — retrying without latency tuning. Fix the value in llm-provider.ts; calls are slower until then.`,
    );
    const retryBody = { ...body };
    delete retryBody.reasoning_effort;
    delete retryBody.verbosity;
    return (await provider.client.chat.completions.create(retryBody as never)) as unknown as CompletionStream;
  }
}

/**
 * Splits off every complete sentence in `buf`, returning the unterminated
 * remainder to keep buffering. Handles the Devanagari danda alongside
 * western punctuation, and deliberately does NOT split a full stop sitting
 * between two digits — "1.5 ton" must not become "1." + "5 ton", which TTS
 * would read aloud as "one point" … "five ton".
 */
/**
 * Splits off complete sentences, returning the unterminated remainder to
 * keep buffering.
 *
 * Deliberately sentence-only. An earlier version also broke at commas to
 * start speaking sooner, which shipped and made the agent sound robotic:
 * every clause was synthesized as its own utterance with its own
 * sentence-final intonation, so a greeting came out as three clipped
 * fragments. Perceived latency is covered by the filler word instead — see
 * FILLER_DELAY_MS in server.ts.
 */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "।" && ch !== "\n") continue;
    // "1.5 ton" must not become "1." + "5 ton" — TTS reads that aloud wrong.
    if (/\d/.test(buf[i - 1] ?? "") && /\d/.test(buf[i + 1] ?? "")) continue;
    const sentence = buf.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    start = i + 1;
  }
  return { sentences, rest: buf.slice(start) };
}

/** A one-word sentence like "ভালো।" voiced on its own sounds clipped, so
 * hold short pieces and let them ride along with the next one. */
const MIN_SPEAK_CHARS = 24;

type StreamedTurn = {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
};

/**
 * Consumes one streamed completion, emitting each finished sentence through
 * `onSentence` as soon as it lands rather than waiting for the whole reply.
 * That is the entire point of streaming here: TTS can start on sentence one
 * while the model is still writing sentence two, which is what turns a
 * ~1-2s silence into ~0.3-0.5s.
 *
 * Tool-call deltas arrive split across chunks and keyed by `index`, so they
 * have to be reassembled (id and name usually arrive once, `arguments` in
 * fragments) before the caller can dispatch them.
 */
async function consumeStream(
  stream: Awaited<ReturnType<typeof createCompletion>>,
  onSentence: ((sentence: string) => void) | undefined,
  isCancelled: () => boolean,
): Promise<StreamedTurn> {
  let content = "";
  let unspoken = "";
  /** A completed sentence too short to voice on its own yet. */
  let held = "";
  const byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    if (isCancelled()) break;
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      unspoken += delta.content;
      // Only flush on a boundary — speaking half a clause would sound worse
      // than the latency it saves.
      if (onSentence) {
        const { sentences, rest } = takeSentences(unspoken);
        unspoken = rest;
        for (const sentence of sentences) {
          if (isCancelled()) break;
          // Merge short pieces so each spoken utterance is a natural unit.
          held = held ? `${held} ${sentence}` : sentence;
          if (held.length >= MIN_SPEAK_CHARS) {
            onSentence(held);
            held = "";
          }
        }
      }
    }

    for (const tc of delta.tool_calls ?? []) {
      const slot = byIndex.get(tc.index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      byIndex.set(tc.index, slot);
    }
  }

  // Anything held back for being short, plus any text that never got a
  // closing punctuation mark, still has to be said.
  const tail = [held, unspoken.trim()].filter(Boolean).join(" ").trim();
  if (onSentence && tail && !isCancelled()) onSentence(tail);

  return { content, toolCalls: [...byIndex.values()].filter((t) => t.name) };
}

export async function runAgentTurn(
  history: ChatCompletionMessageParam[],
  userUtterance: string,
  toolCtx: ToolContext,
  /** Called with each finished sentence as it streams, so speech can start
   * before generation ends. Omit for non-spoken callers. */
  onSentence?: (sentence: string) => void,
  /** Lets a barge-in abandon the rest of an in-flight reply. */
  isCancelled: () => boolean = () => false,
): Promise<AgentTurnResult> {
  const messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: userUtterance },
  ];

  let controlSignal: AgentTurnResult["controlSignal"];
  // Resolved once per turn rather than per hop — the client is cached, but
  // this also keeps a mid-turn env change from splitting one reply across
  // two providers.
  const provider = getProvider();

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    // Reasoning depth and the token-limit field name both differ per
    // provider and are supplied by completionBody — this is a live phone
    // call, so every second of hidden reasoning before the first token is
    // dead air the caller hears as the AI going silent.
    const stream = await createCompletion(
      provider,
      completionBody(provider, { messages, tools: CRM_TOOLS, stream: true }, 200),
    );

    const { content, toolCalls } = await consumeStream(stream, onSentence, isCancelled);

    if (isCancelled()) {
      // Barge-in: the caller is already talking over this reply, so record
      // what was generated and let the next turn take over.
      return { reply: content.trim(), history: messages, controlSignal };
    }

    messages.push(
      toolCalls.length > 0
        ? {
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls.map((t) => ({
              id: t.id,
              type: "function" as const,
              function: { name: t.name, arguments: t.arguments },
            })),
          }
        : { role: "assistant", content },
    );

    if (toolCalls.length === 0) {
      // No tool calls — this was the model's spoken reply, already streamed
      // out sentence by sentence above.
      return { reply: content.trim(), history: messages, controlSignal };
    }

    for (const call of toolCalls) {
      const result = await executeCrmTool(call.name, call.arguments, toolCtx);
      if (result.controlSignal) controlSignal = result.controlSignal;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.output),
      });
    }

    // end_call/transfer_to_human: let the model produce one more turn (e.g.
    // its farewell line) before the loop's caller acts on the signal, but
    // don't keep looping indefinitely once a control signal has fired.
    if (controlSignal) {
      // `tools` must be sent even though the farewell needs none: `messages`
      // now contains tool_calls and tool results, and Sarvam rejects that
      // history outright ("Tool messages found but no tools provided") while
      // OpenAI tolerates it. Omitting it 400'd every goodbye on the first
      // Sarvam call — end_call had already recorded the outcome, so the call
      // simply went silent until the timeout hung up on the lead.
      const closingStream = await createCompletion(
        provider,
        completionBody(provider, { messages, tools: CRM_TOOLS, stream: true }, 100),
      );
      const closing = await consumeStream(closingStream, onSentence, isCancelled);
      const closingText = closing.content.trim();
      if (closingText) messages.push({ role: "assistant", content: closingText });
      return { reply: closingText, history: messages, controlSignal };
    }
  }

  return { reply: "Sorry, let me have someone call you back.", history: messages, controlSignal: "end_call" };
}

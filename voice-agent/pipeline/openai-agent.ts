/**
 * Phase 2 AI_AUTONOMOUS conversation agent — OpenAI with tool-calling,
 * driving the actual sales-qualification dialogue (not Phase 1's passive
 * suggestion-only assist). Uses the full `OPENAI_AGENT_MODEL` tier, not
 * Phase 1's `-mini`, given the higher stakes of unsupervised conversation.
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { CRM_TOOLS, executeCrmTool, type ToolContext } from "../tools/crm-tools.js";

const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-5.4";
const MAX_TOOL_HOPS = 4;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export function buildSystemPrompt(leadName: string): string {
  return `You are an AI sales voice agent for Urvar Natural, an organic-fertilizer company in India, calling a lead named "${leadName}" to qualify their interest. This is a real, live phone call — the person can hear you speak.

Rules:
- Speak naturally and briefly — this is voice, not text. 1-2 short sentences per turn, never a long paragraph.
- Match the caller's language and code-switching (Hindi/English/Bengali mix) — respond in whatever mix they use.
- Use get_lead_context early to know what you're calling about. If the caller asks about price, availability, or pack size, ALWAYS call get_product_info first before answering — never say you don't have that information without checking. Use check_quotation_status when they ask about a quotation.
- If the caller explicitly asks for a human, or the conversation is stuck, or they're upset, call transfer_to_human immediately.
- If the caller asks not to be called again, call mark_do_not_call.
- If they want a callback at a specific time, call schedule_follow_up.
- Always call end_call once the conversation has naturally concluded — never just stop responding.
- Never invent product details, prices, or availability you weren't given by a tool.`;
}

export type AgentTurnResult = {
  reply: string;
  history: ChatCompletionMessageParam[];
  controlSignal?: "end_call" | "transfer_to_human";
};

export async function runAgentTurn(
  history: ChatCompletionMessageParam[],
  userUtterance: string,
  toolCtx: ToolContext,
): Promise<AgentTurnResult> {
  const messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: userUtterance },
  ];

  let controlSignal: AgentTurnResult["controlSignal"];

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const res = await openai().chat.completions.create({
      model: MODEL,
      messages,
      tools: CRM_TOOLS,
      max_completion_tokens: 200,
    });

    const choice = res.choices[0];
    const message = choice?.message;
    if (!message) break;

    messages.push(message);

    const toolCalls = message.tool_calls?.filter((t) => t.type === "function") ?? [];
    if (toolCalls.length === 0) {
      // No tool calls — this is the model's spoken reply.
      return { reply: message.content?.trim() ?? "", history: messages, controlSignal };
    }

    for (const call of toolCalls) {
      const result = await executeCrmTool(call.function.name, call.function.arguments, toolCtx);
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
      const closingRes = await openai().chat.completions.create({
        model: MODEL,
        messages,
        max_completion_tokens: 100,
      });
      const closingText = closingRes.choices[0]?.message?.content?.trim() ?? "";
      if (closingText) messages.push({ role: "assistant", content: closingText });
      return { reply: closingText, history: messages, controlSignal };
    }
  }

  return { reply: "Sorry, let me have someone call you back.", history: messages, controlSignal: "end_call" };
}

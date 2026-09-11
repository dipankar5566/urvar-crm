/**
 * Which LLM answers the phone.
 *
 * Both providers speak the OpenAI chat-completions shape, but not
 * identically, and every difference below was confirmed by probing the live
 * APIs rather than read off documentation:
 *
 *   - Sarvam authenticates with an `api-subscription-key` header, not a
 *     bearer token, and lives at its own base URL.
 *   - `reasoning_effort: "none"` is OpenAI-only. Sarvam rejects it outright
 *     ("Input should be 'low', 'medium' or 'high'"), so it gets "low", its
 *     fastest accepted setting.
 *   - OpenAI's current models reject `max_tokens` and require
 *     `max_completion_tokens`. Sarvam accepts both; it is sent the field its
 *     own docs use, so we aren't relying on an alias being honoured.
 *
 * Provider is chosen by `VOICE_AGENT_LLM_PROVIDER` and defaults to openai,
 * so this abstraction changes nothing until someone opts in — and switching
 * back is an env edit plus a restart, not a deploy.
 */
import OpenAI from "openai";

export type ProviderName = "openai" | "sarvam";

export type LlmProvider = {
  name: ProviderName;
  client: OpenAI;
  model: string;
  /** Field this provider uses to cap reply length. */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** Latency/verbosity tuning this provider actually accepts. */
  tuning: Record<string, unknown>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function build(name: ProviderName): LlmProvider {
  if (name === "sarvam") {
    const key = requireEnv("SARVAM_API_KEY");
    return {
      name,
      client: new OpenAI({
        apiKey: key,
        baseURL: "https://api.sarvam.ai/v1",
        // Sent as a header because Sarvam ignores the bearer token the SDK
        // sets from apiKey; apiKey is still required for the SDK to init.
        defaultHeaders: { "api-subscription-key": key },
      }),
      model: process.env.SARVAM_AGENT_MODEL || "sarvam-105b-conversations",
      maxTokensField: "max_tokens",
      tuning: { reasoning_effort: "low", verbosity: "low" },
    };
  }

  return {
    name,
    client: new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") }),
    model: process.env.OPENAI_AGENT_MODEL || "gpt-5.4",
    maxTokensField: "max_completion_tokens",
    tuning: { reasoning_effort: "none", verbosity: "low" },
  };
}

const cache = new Map<ProviderName, LlmProvider>();

/**
 * Resolves the configured provider, or a specific one when `override` is
 * given (the evaluation harness compares both in a single run).
 *
 * Clients are cached so a long call doesn't rebuild one per turn, and
 * resolution is lazy so importing this module never throws on a missing key
 * for a provider nobody is using.
 */
export function getProvider(override?: ProviderName): LlmProvider {
  const raw = override ?? process.env.VOICE_AGENT_LLM_PROVIDER ?? "openai";
  if (raw !== "openai" && raw !== "sarvam") {
    console.warn(`[llm-provider] unknown VOICE_AGENT_LLM_PROVIDER="${raw}" — falling back to openai`);
  }
  const name: ProviderName = raw === "sarvam" ? "sarvam" : "openai";

  let provider = cache.get(name);
  if (!provider) {
    provider = build(name);
    cache.set(name, provider);
    console.log(`[llm-provider] using ${provider.name} / ${provider.model}`);
  }
  return provider;
}

/**
 * Assembles a request body in the shape the given provider expects.
 * Callers pass the token budget; the field name and tuning come from the
 * provider so no call site has to know which one is active.
 */
export function completionBody(
  provider: LlmProvider,
  body: Record<string, unknown>,
  maxTokens: number,
): Record<string, unknown> {
  return {
    model: provider.model,
    ...body,
    [provider.maxTokensField]: maxTokens,
    ...provider.tuning,
  };
}

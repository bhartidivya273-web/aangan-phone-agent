import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LLMRequest {
  model: string;
  system: string;
  /** Alternating user/assistant turns. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  effort?: string | null;
}

export interface LLMResponse {
  text: string;
  usage: Usage;
  model: string;
}

/** Thin seam so tests and the replay can run with a fake model and the rest of the code never imports the SDK. */
export interface LLM {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export class LLMRefusalError extends Error {}

export function anthropicLLM(client: Anthropic = new Anthropic()): LLM {
  return {
    async complete(req) {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        // The system prompt is large and identical across calls: let the API cache it.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
        // Sampling params (temperature etc.) are not sent: current models reject non-default values.
        ...(req.effort ? { output_config: { effort: req.effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
      });
      if (res.stop_reason === "refusal") throw new LLMRefusalError("model refused the request");
      if (res.stop_reason === "max_tokens") throw new Error("model hit max_tokens before finishing");
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, usage: res.usage as Usage, model: res.model };
    },
  };
}

export function sumUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
}

export function llmCostUsd(u: Usage, inPerMtok: number, outPerMtok: number): number {
  // Cache reads/writes are billed at different rates; unit prices are configurable and cache-agnostic for now,
  // so cached tokens are counted at the input rate (a slight over-estimate). See CHANGELOG.
  const input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return (input * inPerMtok + u.output_tokens * outPerMtok) / 1_000_000;
}

/**
 * Gemini backend (Interactions API, @google/genai). Stateless (store:false). Reasoning effort maps onto thinking_level.
 * Thought tokens are billed as output, so they are added to output_tokens for the cost log.
 */
export function geminiLLM(ai: GoogleGenAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })): LLM {
  const level = (e?: string | null) =>
    !e ? undefined : e === "xhigh" || e === "max" ? "high" : (e as "minimal" | "low" | "medium" | "high");
  return {
    async complete(req) {
      // The Interactions API takes one input; the (rare) repair retry is folded into a single user turn.
      const input =
        req.messages.length === 1
          ? req.messages[0].content
          : req.messages.map((m) => `[${m.role === "user" ? "USER" : "YOUR EARLIER REPLY"}]\n${m.content}`).join("\n\n");
      const res = await ai.interactions.create({
        model: req.model,
        system_instruction: req.system,
        input,
        store: false,
        generation_config: {
          max_output_tokens: req.maxTokens,
          ...(level(req.effort) ? { thinking_level: level(req.effort) } : {}),
        },
      });
      if (res.status && res.status !== "completed") throw new Error(`gemini interaction ${res.status}`);
      const text = res.output_text ?? "";
      if (!text) throw new Error("gemini returned no text");
      const u = res.usage;
      return {
        text,
        usage: {
          input_tokens: u?.total_input_tokens ?? 0,
          output_tokens: (u?.total_output_tokens ?? 0) + (u?.total_thought_tokens ?? 0),
        },
        model: res.model ?? req.model,
      };
    },
  };
}

/** Provider from LLM_PROVIDER (anthropic|gemini); otherwise inferred from the model name. */
export function defaultLLM(model: string, env = process.env): LLM {
  const provider = env.LLM_PROVIDER ?? (/^gemini/i.test(model) ? "gemini" : "anthropic");
  if (provider === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
    return geminiLLM();
  }
  return anthropicLLM();
}

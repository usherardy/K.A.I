/**
 * Minimal OpenAI Chat Completions client with tool calling, over plain fetch so it
 * runs unchanged on Node and Cloudflare Workers.
 */
import { requestJson } from "./http";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export interface LlmTool {
  name: string;
  description: string;
  parameters: object;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: LlmTool[];
  /** "none" forces a text answer (used to stop a runaway tool loop). */
  toolChoice?: "auto" | "none";
}

export interface LLM {
  complete(req: CompletionRequest): Promise<AssistantMessage>;
}

export class OpenAIChat implements LLM {
  constructor(private readonly opts: { apiKey: string; model: string; baseUrl: string; reasoningEffort?: string }) {}

  async complete({ messages, tools, toolChoice = "auto" }: CompletionRequest): Promise<AssistantMessage> {
    const body: Record<string, unknown> = { model: this.opts.model, messages };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({ type: "function", function: t }));
      body.tool_choice = toolChoice;
    }
    if (this.opts.reasoningEffort) body.reasoning_effort = this.opts.reasoningEffort;

    const { data } = await requestJson<{ choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[] }>(
      "OpenAI",
      `${this.opts.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      60_000,
    );

    const message = data?.choices?.[0]?.message;
    // Keep only function tool calls, and only the fields we send back on the next turn.
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).flatMap((raw) => {
      const call = raw as { id?: string; type?: string; function?: { name?: string; arguments?: string } };
      return call.type === "function" && call.id && call.function?.name
        ? [{ id: call.id, type: "function" as const, function: { name: call.function.name, arguments: call.function.arguments ?? "{}" } }]
        : [];
    });

    return { role: "assistant", content: message?.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  }
}

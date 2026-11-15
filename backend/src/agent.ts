/**
 * The tool-calling loop: send the conversation to the model, run whatever tools it
 * asks for (in parallel), feed the results back, repeat until it answers.
 */
import type { Config } from "./config";
import { errorMessage, truncate } from "./errors";
import type { AssistantMessage, ChatMessage, LLM } from "./llm";
import { buildSystemPrompt } from "./prompt";
import type { ConversationStore } from "./store";
import { executeTool, toolSchemas } from "./tools";

/** After this many tool rounds the model must answer with what it has. */
const MAX_TOOL_ROUNDS = 5;
/** User turns of history kept per conversation. */
const HISTORY_TURNS = 8;
/** Tool results are trimmed further when stored, to keep history small. */
const STORED_TOOL_RESULT_CHARS = 4000;

export interface AgentDeps {
  config: Config;
  llm: LLM;
  store: ConversationStore;
  now?: () => Date;
  onToolCall?: (event: { name: string; args: string; ok: boolean; ms: number; content: string }) => void;
}

export interface AskInput {
  message: string;
  conversationId?: string;
  timeZone?: string;
}

export interface AskResult {
  conversationId: string;
  reply: string;
  toolCalls: { name: string; ok: boolean }[];
}

const FALLBACK_REPLY = "Sorry, I couldn't put an answer together. Please try again.";

export async function runAgent(deps: AgentDeps, input: AskInput): Promise<AskResult> {
  const { config, llm, store } = deps;
  const conversationId = input.conversationId ?? crypto.randomUUID();
  const history = input.conversationId ? await loadHistory(store, conversationId) : [];

  const system: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(config, { now: deps.now?.() ?? new Date(), timeZone: input.timeZone ?? config.timeZone }),
  };
  const turn: ChatMessage[] = [{ role: "user", content: input.message }];
  const tools = toolSchemas(config);
  const toolCalls: AskResult["toolCalls"] = [];
  let reply = "";

  for (let round = 0; ; round++) {
    const lastRound = round >= MAX_TOOL_ROUNDS;
    let message: AssistantMessage = await llm.complete({
      messages: [system, ...history, ...turn],
      tools,
      toolChoice: lastRound ? "none" : "auto",
    });

    const calls = message.tool_calls ?? [];
    if (calls.length === 0 || lastRound) {
      // Never store tool calls without results: the next request would be rejected.
      reply = message.content?.trim() || FALLBACK_REPLY;
      message = { role: "assistant", content: reply };
      turn.push(message);
      break;
    }

    turn.push(message);
    const results = await Promise.all(
      calls.map(async (call) => {
        const started = Date.now();
        const result = await executeTool(call.function.name, call.function.arguments, { config });
        deps.onToolCall?.({ name: call.function.name, args: call.function.arguments, ok: result.ok, ms: Date.now() - started, content: result.content });
        return result;
      }),
    );
    calls.forEach((call, i) => {
      const result = results[i]!;
      toolCalls.push({ name: call.function.name, ok: result.ok });
      turn.push({ role: "tool", tool_call_id: call.id, content: result.content });
    });
  }

  await saveHistory(store, conversationId, trimHistory([...history, ...turn]));
  return { conversationId, reply, toolCalls };
}

/** Keep the last HISTORY_TURNS user turns, always cutting at a user message so tool calls stay paired. */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const userIndexes = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const start = userIndexes.length > HISTORY_TURNS ? userIndexes[userIndexes.length - HISTORY_TURNS]! : 0;
  return messages
    .slice(start)
    .map((m) => (m.role === "tool" ? { ...m, content: truncate(m.content, STORED_TOOL_RESULT_CHARS) } : m));
}

// History is a convenience: if the store is down, answer without it rather than fail.
async function loadHistory(store: ConversationStore, id: string): Promise<ChatMessage[]> {
  try {
    return (await store.load(id)) ?? [];
  } catch (err) {
    console.warn(`Couldn't load conversation ${id}: ${errorMessage(err)}`);
    return [];
  }
}

async function saveHistory(store: ConversationStore, id: string, messages: ChatMessage[]): Promise<void> {
  try {
    await store.save(id, messages);
  } catch (err) {
    console.warn(`Couldn't save conversation ${id}: ${errorMessage(err)}`);
  }
}

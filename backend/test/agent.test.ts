import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent, trimHistory } from "../src/agent";
import { resetSentryCache } from "../src/integrations/sentry";
import type { AssistantMessage, ChatMessage, CompletionRequest, LLM } from "../src/llm";
import { MemoryStore } from "../src/store";
import { mockFetch, testConfig } from "./helpers";

/** An LLM that replays scripted responses and records every request. */
class ScriptedLLM implements LLM {
  requests: CompletionRequest[] = [];
  constructor(private readonly script: ((req: CompletionRequest) => AssistantMessage)[]) {}
  async complete(req: CompletionRequest): Promise<AssistantMessage> {
    this.requests.push(structuredClone(req));
    const step = this.script[Math.min(this.requests.length - 1, this.script.length - 1)]!;
    return step(req);
  }
}

const toolCall = (id: string, name: string, args: object): AssistantMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content: string): AssistantMessage => ({ role: "assistant", content });

afterEach(() => {
  vi.unstubAllGlobals();
  resetSentryCache();
});

function mockSentry() {
  return mockFetch(({ url }) => {
    if (url.pathname === "/api/0/projects/acme/shawgames/") return { id: 42 };
    if (url.pathname === "/api/0/organizations/acme/issues/") {
      return [{ id: "1", title: "TimeoutError", count: "57", userCount: 12, level: "error", substatus: "new" }];
    }
  });
}

describe("runAgent", () => {
  it("runs requested tools, feeds results back, and returns the answer", async () => {
    mockSentry();
    const llm = new ScriptedLLM([
      () => toolCall("call_1", "get_errors", { project: "shawgames", only_new: true }),
      () => say("ShawGames has one new error, a database timeout affecting 12 users."),
    ]);
    const store = new MemoryStore();

    const result = await runAgent({ config: testConfig(), llm, store }, { message: "Any new errors on ShawGames?" });

    expect(result.reply).toBe("ShawGames has one new error, a database timeout affecting 12 users.");
    expect(result.toolCalls).toEqual([{ name: "get_errors", ok: true }]);

    const second = llm.requests[1]!.messages;
    expect(second[0]!.role).toBe("system");
    const toolMessage = second.at(-1) as Extract<ChatMessage, { role: "tool" }>;
    expect(toolMessage.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMessage.content).issues[0].usersAffected).toBe(12);

    // Only tools whose data source is connected are offered (no GA4 credentials in this config).
    const offered = llm.requests[0]!.tools.map((t) => t.name);
    expect(offered).toContain("get_errors");
    expect(offered).toContain("get_product_metrics");
    expect(offered).not.toContain("get_traffic_summary");

    const saved = await store.load(result.conversationId);
    expect(saved?.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("includes earlier turns for follow-up questions", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const first = await runAgent({ config, llm: new ScriptedLLM([() => say("Two new errors.")]), store }, { message: "Errors?" });

    const llm = new ScriptedLLM([() => say("One is a database timeout.")]);
    await runAgent({ config, llm, store }, { message: "What are those errors?", conversationId: first.conversationId });

    const contents = llm.requests[0]!.messages.map((m) => m.content);
    expect(contents.slice(1)).toEqual(["Errors?", "Two new errors.", "What are those errors?"]);
  });

  it("reports bad tool calls to the model instead of failing", async () => {
    const llm = new ScriptedLLM([
      (): AssistantMessage => ({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "get_errors", arguments: '{"project":"nope"}' } },
          { id: "b", type: "function", function: { name: "made_up_tool", arguments: "{}" } },
          { id: "c", type: "function", function: { name: "get_errors", arguments: "{not json" } },
        ],
      }),
      () => say("Sorry."),
    ]);
    const result = await runAgent({ config: testConfig(), llm, store: new MemoryStore() }, { message: "hi" });

    expect(result.toolCalls.map((t) => t.ok)).toEqual([false, false, false]);
    const toolContents = llm.requests[1]!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!).error);
    expect(toolContents[0]).toMatch(/Unknown project "nope"/);
    expect(toolContents[1]).toMatch(/unavailable tool/);
    expect(toolContents[2]).toMatch(/not valid JSON/);
  });

  it("forces an answer after too many tool rounds and never stores unanswered tool calls", async () => {
    mockSentry();
    const llm = new ScriptedLLM([
      (req) =>
        req.toolChoice === "none"
          ? { ...toolCall("x", "get_errors", { project: "shawgames" }), content: "Here's what I found." }
          : toolCall(`call_${Math.random()}`, "get_errors", { project: "shawgames" }),
    ]);
    const store = new MemoryStore();
    const result = await runAgent({ config: testConfig(), llm, store }, { message: "loop forever" });

    expect(llm.requests.at(-1)!.toolChoice).toBe("none");
    expect(llm.requests).toHaveLength(6);
    expect(result.reply).toBe("Here's what I found.");
    const last = (await store.load(result.conversationId))!.at(-1)!;
    expect(last).toEqual({ role: "assistant", content: "Here's what I found." });
  });
});

describe("trimHistory", () => {
  it("keeps the last 8 user turns and cuts at a user message", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `q${i}` });
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: `t${i}`, type: "function", function: { name: "x", arguments: "{}" } }] });
      messages.push({ role: "tool", tool_call_id: `t${i}`, content: "r".repeat(5000) });
      messages.push({ role: "assistant", content: `a${i}` });
    }
    const trimmed = trimHistory(messages);
    expect(trimmed[0]).toEqual({ role: "user", content: "q2" });
    expect(trimmed.filter((m) => m.role === "user")).toHaveLength(8);
    expect((trimmed[2] as { content: string }).content.length).toBe(4000);
  });
});

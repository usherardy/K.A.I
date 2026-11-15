import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { UpstreamError } from "../src/errors";
import type { LLM } from "../src/llm";
import { MemoryStore } from "../src/store";
import { API_KEY, testEnv } from "./helpers";

const replyLLM = (content: string): LLM => ({ complete: async () => ({ role: "assistant", content }) });

function post(app: ReturnType<typeof createApp>, body: unknown, env = testEnv(), token = API_KEY) {
  return app.request(
    "/v1/ask",
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

describe("HTTP API", () => {
  const store = new MemoryStore();
  const app = createApp({ llm: () => replyLLM("All good."), store: () => store });

  it("serves /health without auth", async () => {
    const res = await app.request("/health", {}, testEnv());
    expect(res.status).toBe(200);
  });

  it("rejects missing or wrong tokens", async () => {
    expect((await app.request("/v1/projects", {}, testEnv())).status).toBe(401);
    expect((await post(app, { message: "hi" }, testEnv(), "wrong-token")).status).toBe(401);
  });

  it("answers questions and keeps the conversation id", async () => {
    const res = await post(app, { message: "  How's ShawGames?  ", timeZone: "Europe/London" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: string; reply: string };
    expect(body.reply).toBe("All good.");
    expect(body.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await store.load(body.conversationId))?.[0]).toEqual({ role: "user", content: "How's ShawGames?" });

    const followUp = await post(app, { message: "And errors?", conversationId: body.conversationId });
    expect(((await followUp.json()) as { conversationId: string }).conversationId).toBe(body.conversationId);
  });

  it("validates input", async () => {
    expect((await post(app, { message: "" })).status).toBe(400);
    expect((await post(app, { message: "x".repeat(2001) })).status).toBe(400);
    expect((await post(app, { message: "hi", conversationId: "abc" })).status).toBe(400);
  });

  it("lists projects and connected sources", async () => {
    const res = await app.request("/v1/projects", { headers: { authorization: `Bearer ${API_KEY}` } }, testEnv());
    expect(await res.json()).toMatchObject({
      projects: [
        { id: "shawgames", sources: ["posthog", "sentry"] },
        { id: "begin", sources: ["sentry"] },
      ],
      history: "memory",
    });
  });

  it("hides config details from clients when misconfigured", async () => {
    const res = await post(app, { message: "hi" }, testEnv({ OPENAI_API_KEY: undefined }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("OPENAI");
  });

  it("returns 502 when OpenAI fails", async () => {
    const failing = createApp({
      llm: () => ({
        complete: async () => {
          throw new UpstreamError("OpenAI", 429, "rate limited");
        },
      }),
      store: () => new MemoryStore(),
    });
    const res = await post(failing, { message: "hi" });
    expect(res.status).toBe(502);
  });
});

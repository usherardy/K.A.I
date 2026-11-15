/**
 * HTTP API used by the watch app. The same Hono app runs on Node (src/node.ts)
 * and Cloudflare Workers (src/worker.ts).
 *
 *   GET  /health        liveness, no auth
 *   GET  /v1/projects   configured projects and connected data sources
 *   POST /v1/ask        { message, conversationId?, timeZone? } → { conversationId, reply, toolCalls }
 */
import { Hono } from "hono";
import { runAgent } from "./agent";
import { ConfigError, connectedSources, isValidTimeZone, loadConfig, type Bindings, type Config } from "./config";
import { UpstreamError, errorMessage } from "./errors";
import { OpenAIChat, type LLM } from "./llm";
import { createStore, type ConversationStore } from "./store";

export interface AppOptions {
  llm?: (config: Config) => LLM;
  store?: (config: Config) => ConversationStore;
  now?: () => Date;
}

type AppEnv = { Bindings: Bindings; Variables: { config: Config } };

const MAX_MESSAGE_CHARS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(options: AppOptions = {}) {
  const makeLlm = options.llm ?? ((config: Config) => new OpenAIChat(config.openai));
  const makeStore = options.store ?? createStore;
  const configCache = new WeakMap<object, Config>();

  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    let config: Config;
    try {
      const env = c.env ?? {};
      config = configCache.get(env) ?? loadConfig(env);
      configCache.set(env, config);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      console.error(`Configuration error: ${err.message}`);
      return c.json({ error: "Kai's server is misconfigured. Check the server logs." }, 500);
    }

    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token || !timingSafeEqual(token, config.apiKey)) return c.json({ error: "Unauthorized" }, 401);

    c.set("config", config);
    await next();
  });

  app.get("/v1/projects", (c) => {
    const config = c.get("config");
    return c.json({
      projects: config.projects.map((p) => ({ id: p.id, name: p.name, sources: connectedSources(config, p) })),
      history: config.supabase ? "supabase" : "memory",
      model: config.openai.model,
    });
  });

  app.post("/v1/ask", async (c) => {
    const config = c.get("config");
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "Send a JSON body with a message." }, 400);

    const { message, conversationId, timeZone } = body as Record<string, unknown>;
    if (typeof message !== "string" || !message.trim()) return c.json({ error: "message is required." }, 400);
    if (message.length > MAX_MESSAGE_CHARS) return c.json({ error: `message must be under ${MAX_MESSAGE_CHARS} characters.` }, 400);
    if (conversationId !== undefined && conversationId !== null && (typeof conversationId !== "string" || !UUID.test(conversationId))) {
      return c.json({ error: "conversationId must be a UUID." }, 400);
    }
    const tz = typeof timeZone === "string" && isValidTimeZone(timeZone) ? timeZone : undefined;

    try {
      const result = await runAgent(
        { config, llm: makeLlm(config), store: makeStore(config), now: options.now },
        { message: message.trim(), conversationId: conversationId ? conversationId.toLowerCase() : undefined, timeZone: tz },
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof UpstreamError && err.service === "OpenAI") {
        console.error(err.message);
        return c.json({ error: "I couldn't reach the AI service. Try again in a moment." }, 502);
      }
      throw err;
    }
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    console.error("Unhandled error:", errorMessage(err));
    return c.json({ error: "Something went wrong on Kai's server." }, 500);
  });

  return app;
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * HTTP API used by the watch app. The same Hono app runs on Node (src/node.ts)
 * and Cloudflare Workers (src/worker.ts).
 *
 *   GET  /health        liveness, no auth
 *   GET  /v1/projects   configured projects and connected data sources
 *   POST /v1/ask        JSON { message, conversationId?, timeZone? } → { conversationId, reply, toolCalls }
 *   POST /v1/voice      raw audio body (e.g. audio/mp4), ?conversationId=&timeZone=
 *                       → { conversationId, transcript, reply, toolCalls }
 */
import { Hono, type Context } from "hono";
import { runAgent, type AskInput } from "./agent";
import { ConfigError, connectedSources, isValidTimeZone, loadConfig, type Bindings, type Config } from "./config";
import { UpstreamError, errorMessage } from "./errors";
import { OpenAIChat, type LLM } from "./llm";
import { createStore, type ConversationStore } from "./store";
import { AUDIO_TYPES, OpenAITranscriber, transcriptionPrompt, type Transcriber } from "./transcribe";

export interface AppOptions {
  llm?: (config: Config) => LLM;
  store?: (config: Config) => ConversationStore;
  transcriber?: (config: Config) => Transcriber;
  now?: () => Date;
}

type AppEnv = { Bindings: Bindings; Variables: { config: Config } };

const MAX_MESSAGE_CHARS = 2000;
/** About 15 minutes of the watch's 32 kbps AAC; real questions are a few seconds (~20 KB). */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(options: AppOptions = {}) {
  const makeLlm = options.llm ?? ((config: Config) => new OpenAIChat(config.openai));
  const makeStore = options.store ?? createStore;
  const makeTranscriber =
    options.transcriber ??
    ((config: Config) =>
      new OpenAITranscriber({
        apiKey: config.openai.apiKey,
        baseUrl: config.openai.baseUrl,
        model: config.openai.transcribeModel,
        prompt: transcriptionPrompt(config),
      }));
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

  /** Runs the agent; maps an OpenAI outage to a 502 the watch can show. */
  async function answer(c: Context<AppEnv>, input: AskInput) {
    const config = c.get("config");
    try {
      return await runAgent({ config, llm: makeLlm(config), store: makeStore(config), now: options.now }, input);
    } catch (err) {
      if (err instanceof UpstreamError && err.service === "OpenAI") {
        console.error(err.message);
        return null;
      }
      throw err;
    }
  }

  const aiUnavailable = (c: Context<AppEnv>) => c.json({ error: "I couldn't reach the AI service. Try again in a moment." }, 502);

  app.post("/v1/ask", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "Send a JSON body with a message." }, 400);

    const { message, conversationId, timeZone } = body as Record<string, unknown>;
    if (typeof message !== "string" || !message.trim()) return c.json({ error: "message is required." }, 400);
    if (message.length > MAX_MESSAGE_CHARS) return c.json({ error: `message must be under ${MAX_MESSAGE_CHARS} characters.` }, 400);
    const conversation = parseConversationId(conversationId);
    if (conversation === false) return c.json({ error: "conversationId must be a UUID." }, 400);

    const result = await answer(c, { message: message.trim(), conversationId: conversation, timeZone: parseTimeZone(timeZone) });
    return result ? c.json(result) : aiUnavailable(c);
  });

  app.post("/v1/voice", async (c) => {
    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const extension = AUDIO_TYPES[contentType];
    if (!extension) return c.json({ error: "Send the recording as audio (m4a, mp3, wav, webm, ogg or flac)." }, 415);
    if (Number(c.req.header("content-length")) > MAX_AUDIO_BYTES) return c.json({ error: "That recording is too long." }, 413);

    const conversation = parseConversationId(c.req.query("conversationId"));
    if (conversation === false) return c.json({ error: "conversationId must be a UUID." }, 400);

    const audio = await c.req.arrayBuffer();
    if (audio.byteLength === 0) return c.json({ error: "The recording was empty." }, 400);
    if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "That recording is too long." }, 413);

    let transcript: string;
    try {
      transcript = await makeTranscriber(c.get("config")).transcribe(new Blob([audio], { type: contentType }), `question.${extension}`);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      console.error(err.message);
      return c.json({ error: "I couldn't make out the recording. Try again in a moment." }, 502);
    }

    if (!transcript) {
      return c.json({ conversationId: conversation ?? null, transcript: "", reply: "Sorry, I didn't catch that.", toolCalls: [] });
    }

    const message = transcript.slice(0, MAX_MESSAGE_CHARS);
    const result = await answer(c, { message, conversationId: conversation, timeZone: parseTimeZone(c.req.query("timeZone")) });
    return result ? c.json({ ...result, transcript: message }) : aiUnavailable(c);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    console.error("Unhandled error:", errorMessage(err));
    return c.json({ error: "Something went wrong on Kai's server." }, 500);
  });

  return app;
}

/** undefined = start a new conversation; false = invalid. */
function parseConversationId(value: unknown): string | undefined | false {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : false;
}

function parseTimeZone(value: unknown): string | undefined {
  return typeof value === "string" && isValidTimeZone(value) ? value : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

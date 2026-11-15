// Local / self-hosted entry point: `npm run dev` (auto-reload) or `npm start`.
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { connectedSources, loadConfig } from "./config";
import { loadDotEnv } from "./env";
import { errorMessage } from "./errors";

const env = loadDotEnv();
const port = Number(env.PORT ?? 8787);
// Loopback by default. Set HOST=0.0.0.0 to reach it from a real watch on your network.
const hostname = env.HOST ?? "127.0.0.1";

try {
  const config = loadConfig(env);
  for (const p of config.projects) {
    const sources = connectedSources(config, p);
    console.log(`  ${p.name}: ${sources.length ? sources.join(", ") : "no data sources connected"}`);
  }
  console.log(`  model: ${config.openai.model}, history: ${config.supabase ? "Supabase" : "in memory"}`);
} catch (err) {
  console.error(`Config error: ${errorMessage(err)}\nCopy .env.example to .env and fill it in. /v1 requests will fail until then.`);
}

const app = createApp();
serve({ fetch: (req) => app.fetch(req, env), port, hostname }, (info) => {
  console.log(`Kai backend listening on http://${hostname}:${info.port}`);
});

// Talk to Kai from the terminal, using the same agent as the watch (no server needed).
//   npm run ask -- "How's ShawGames doing today?"
//   npm run ask                     interactive; follow-ups keep context
//   npm run ask -- -v "…"           also print each tool call and its result
import { createInterface } from "node:readline/promises";
import { runAgent, type AgentDeps } from "./agent";
import { loadConfig } from "./config";
import { loadDotEnv } from "./env";
import { errorMessage, truncate } from "./errors";
import { OpenAIChat } from "./llm";
import { MemoryStore } from "./store";

const args = process.argv.slice(2);
const verbose = args.includes("-v") || args.includes("--verbose");
const question = args.filter((a) => a !== "-v" && a !== "--verbose").join(" ").trim();

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

let config;
try {
  config = loadConfig(loadDotEnv());
} catch (err) {
  console.error(`Config error: ${errorMessage(err)}\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

const deps: AgentDeps = {
  config,
  llm: new OpenAIChat(config.openai),
  store: new MemoryStore(),
  onToolCall: ({ name, args, ok, ms, content }) => {
    console.log(dim(`  ${ok ? "✓" : "✗"} ${name}(${args}) ${ms}ms`));
    if (verbose || !ok) console.log(dim(`    ${truncate(content, verbose ? 2000 : 300)}`));
  },
};

let conversationId: string | undefined;

async function ask(message: string) {
  const started = Date.now();
  const result = await runAgent(deps, { message, conversationId });
  conversationId = result.conversationId;
  console.log(`\nKai: ${result.reply}\n${dim(`(${((Date.now() - started) / 1000).toFixed(1)}s)`)}\n`);
}

if (question) {
  try {
    await ask(question);
  } catch (err) {
    console.error(errorMessage(err));
    process.exitCode = 1;
  }
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Ask Kai about ${config.projects.map((p) => p.name).join(", ")}. Empty line or Ctrl+C to quit.\n`);
  for (;;) {
    const line = (await rl.question("You: ").catch(() => "")).trim();
    if (!line) break;
    try {
      await ask(line);
    } catch (err) {
      console.error(errorMessage(err));
    }
  }
  rl.close();
}

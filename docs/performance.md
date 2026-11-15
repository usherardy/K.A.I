# Response speed

**Status:** not started. We test with real keys first and only work on this if answers feel slow.

## Where the time goes

Each answer currently makes two OpenAI calls, with the data fetches in between:

```
watch → backend → OpenAI (pick tools) → GA4 / PostHog / Sentry in parallel → OpenAI (write reply) → watch speaks
```

| Step | Estimate (not yet measured) |
| --- | --- |
| Watch → backend | 0.2–1 s (slower when the watch goes through the iPhone over Bluetooth) |
| OpenAI call 1: choose tools | 1–3 s |
| Data APIs, in parallel (the slowest one decides) | 1–3 s |
| OpenAI call 2: write the reply | 1–3 s |
| Text-to-speech starts | almost instant (on the watch) |
| **Total** | **about 3–8 s** |

## Step 1: measure

```sh
cd backend
npm run ask -- -v "How's ShawGames doing today?"
```

The CLI prints each tool call's time and the total. The total minus the slowest tool is roughly the time spent in OpenAI. Run each question a few times, because the first run is slower (it fetches the Google token and looks up the Sentry project ID).

Record the results here:

| Date | Question | Model / effort | Slowest tool (ms) | Total (s) | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-11-15 | "Which projects do you know about?" (no data sources connected, no tools) | gpt-5-mini / low | none | 4.2 | One OpenAI call alone took 4.2 s, a single sample. A real answer makes two calls, so expect about 8 s or more. Fix 1 is likely worth trying. |
| | How's ShawGames doing today? | gpt-5-mini / low | | | |
| | What are those errors? (follow-up) | gpt-5-mini / low | | | |
| | What should I focus on? | gpt-5-mini / low | | | |

**Rule of thumb:** if a typical answer takes more than about 5 seconds, work through the fixes below in order.

## Step 2: fixes, easiest first

### 1. Faster model settings (config only)

In `backend/.env` (or `wrangler.toml` once deployed):

- `OPENAI_REASONING_EFFORT=minimal` instead of `low`, or
- a non-reasoning model, `OPENAI_MODEL=gpt-4.1-mini`, with `OPENAI_REASONING_EFFORT` removed.

Expected saving: 1–3 s. Re-run the questions above and check that the answers are still good, especially "What should I focus on?", which needs the most judgement.

### 2. Fetch the numbers ahead of time (biggest win)

A scheduled job fetches every project's headline numbers every few minutes and stores them. Each request then puts that snapshot straight into the system prompt, so common questions need **one OpenAI call and no waiting on the data APIs**.

- Cloudflare Cron Trigger (`[triggers] crons = ["*/5 * * * *"]` in `wrangler.toml`) plus a `scheduled()` handler in `src/worker.ts` that runs the same code as `get_portfolio_overview`.
- Store the snapshot in Cloudflare KV or a Supabase table, with the time it was taken.
- In `src/agent.ts` / `src/prompt.ts`, add the snapshot and its age to the system prompt, and tell the model to answer from it when that's enough and to call tools for details or anything older than about 10 minutes.
- The live tools stay as they are for drill-downs ("what are those errors?", custom PostHog queries).

Trade-off: headline numbers can be a few minutes old. Expected result: common questions in about 1–3 s. This also makes the Siri briefing much less likely to time out.

### 3. Speak while the reply is still being written

Stream the second OpenAI call (`stream: true`) and send the reply to the watch sentence by sentence (server-sent events). The watch then speaks the first sentence while the rest arrives. Changes are needed in `src/llm.ts`, `src/app.ts`, `KaiClient.swift` and `Speaker.swift`. Expected saving: about 1 s. Most work of the four.

### 4. Make the wait feel shorter

The app already shows "Checking…". Possible improvements: a light tap on the wrist the moment the question is sent, and mentioning the project ("Checking ShawGames…"). This is small and only touches `ConversationModel.swift` and `ContentView.swift`.

### Smaller wins

- GA4's "today" summary makes two calls one after the other (today by hour, then yesterday up to the same hour). The second call could be skipped by assuming the property's time zone matches the user's.
- Cache each tool result for about 60 seconds, so follow-ups and repeat questions don't refetch.

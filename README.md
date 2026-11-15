# KAI: Knowledge & Analytics Intelligence

A voice assistant on your Apple Watch that knows how your projects are doing. Raise your wrist, ask "How's ShawGames doing today?", and Kai pulls live numbers from Google Analytics 4, PostHog and Sentry, then answers out loud in a sentence or two.

```
You:  How's ShawGames doing today?
Kai:  ShawGames has about 2,400 visitors today, up 18 percent from yesterday at this time,
      mostly from Bing. Sentry picked up two new errors.
You:  What are those errors?
Kai:  One is a database timeout in the leaderboard API affecting 12 users. The other is a minor frontend error.
You:  What should I focus on?
Kai:  Fix the database timeout first. Begin looks healthy, with no critical alerts.
```

## Status

Early MVP. Checked so far:

- **Backend:** type check is clean and all 33 tests pass (integrations against mocked APIs, the agent loop, the HTTP layer). It runs locally and bundles for Cloudflare Workers.
- **OpenAI:** connected and answering. The first measured reply took 4.2 s for a single model call; see [docs/performance.md](docs/performance.md).
- **Not yet done:** running against real PostHog, Sentry and GA4 data, and running the watch app in the simulator or on a watch. It compiles for watchOS 10 and 26.

## How it works

```
Apple Watch app ──(dictation)──┐
Siri: "Ask Kai" / "Kai briefing"┤        POST /v1/ask
                                └──────► backend (Hono on Cloudflare Workers or Node)
                                           │  OpenAI tool calling, up to 5 rounds,
                                           │  tools run in parallel
                                           ├──► GA4 Data API     traffic, sources, realtime
                                           ├──► PostHog HogQL    users, events, revenue, custom queries
                                           ├──► Sentry API       issues, users affected, stack traces
                                           └──► Supabase         conversation history for follow-ups
                                 ◄──────── short spoken-style reply ──► watch text-to-speech
```

| Folder | What it is |
| --- | --- |
| [backend/](backend/) | TypeScript API. The same code runs locally on Node and deploys to Cloudflare Workers. |
| [watch/](watch/) | SwiftUI watchOS app (watch-only, watchOS 10+), with Siri App Shortcuts. |
| [docs/](docs/) | Design notes and plans. |

## 1. Run the backend locally

Requires Node 22+.

```sh
git clone https://github.com/usherardy/K.A.I.git
cd K.A.I/backend
npm install
cp .env.example .env    # then fill it in (see below)
npm run ask -- "How's ShawGames doing today?"   # one question, from the terminal
npm run ask                                     # chat with follow-ups; add -v to see tool results
npm run dev                                     # HTTP server on http://127.0.0.1:8787
```

Three settings are required: `KAI_API_KEY` (generate one with `openssl rand -hex 32`), `OPENAI_API_KEY`, and `KAI_PROJECTS`, a one-line JSON list of your projects. Each data source is optional per project, and Kai only offers the model the tools whose data sources are connected:

```sh
KAI_PROJECTS='[{"id":"shawgames","name":"ShawGames","aliases":["shaw games"],"ga4":{"propertyId":"123456789"},"posthog":{"projectId":"12345","revenueEvent":"purchase","revenueProperty":"revenue"},"sentry":{"project":"shawgames","environment":"production"}},{"id":"begin","name":"Begin","sentry":{"project":"begin-web"}}]'
```

`curl -H "Authorization: Bearer $KAI_API_KEY" localhost:8787/v1/projects` shows which data sources each project is connected to.

### Connecting data sources

| Source | Credentials | Where to find the project id |
| --- | --- | --- |
| **PostHog** | `POSTHOG_PERSONAL_API_KEY`: a personal API key with the `query:read` scope. Set `POSTHOG_HOST` to `https://eu.posthog.com` for EU cloud. | Project settings → Project ID |
| **Sentry** | `SENTRY_AUTH_TOKEN` with `org:read`, `project:read` and `event:read`, plus `SENTRY_ORG` (your org slug). Use `SENTRY_BASE_URL=https://de.sentry.io` for EU orgs. | The project slug in your Sentry URLs |
| **GA4** | Create a Google Cloud service account, enable the *Google Analytics Data API*, download its JSON key and put it in `GA4_SERVICE_ACCOUNT_JSON` (on one line in single quotes, or base64-encoded). Then add the service account's email as a **Viewer** on the GA4 property. | GA4 Admin → Property settings → Property ID |
| **Supabase** (optional) | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Run [the migration](backend/supabase/migrations/0001_kai_conversations.sql) first. Without Supabase, history is kept in memory, which is fine locally but doesn't last on Workers. | |

### Tools the model can call

| Tool | Source | Answers |
| --- | --- | --- |
| `get_portfolio_overview` | all | Briefings, "how is everything", "what should I focus on" |
| `get_traffic_summary` | GA4 | Visitors, new users, sessions, page views, key events, revenue vs. the comparison period |
| `get_traffic_breakdown` | GA4 | Top sources, channels, countries, devices, pages |
| `get_realtime_visitors` | GA4 | People on the site right now |
| `get_product_metrics` | PostHog | Unique users, pageviews, events, conversions and revenue |
| `get_top_events` | PostHog | Most frequent events |
| `query_posthog` | PostHog | Anything else, through a read-only HogQL `SELECT` written by the model |
| `get_errors` | Sentry | Unresolved or new issues, sorted by users affected |
| `get_error_details` | Sentry | Exception, top in-app stack frames, request, release and browser |

"Today" is always compared with **yesterday at the same time**. GA4 compares through the same hour in the property's time zone, and PostHog compares up to the same moment in the project's time zone. Sentry only supports rolling windows, so "today" there means the last 24 hours.

## 2. Run the watch app

1. In Xcode go to **Settings → Components** and download the **watchOS** platform (needed for the simulator and for device builds).
2. `cp watch/Config/Secrets.example.xcconfig watch/Config/Secrets.xcconfig` (git-ignored) and fill in your team ID, a bundle id, `KAI_BASE_URL` and the same `KAI_API_KEY` as the backend. In xcconfig files `//` starts a comment, so write URLs as `https:/$()/host`.
3. Open `watch/KAI.xcodeproj` and run the **KAI** scheme on a watch simulator (it can reach `http://localhost:8787`) or on your watch. A real watch needs the deployed URL, or your Mac's LAN IP with the backend started as `HOST=0.0.0.0 npm run dev`.

In the app, tap **Ask Kai** (or double-tap your fingers on Series 9 / Ultra 2 and later), then speak. Replies are read aloud; the speaker button in the corner turns that off. Follow-up questions keep their context until you tap the reset button.

**Hands-free with Siri:** "Hey Siri, ask Kai" (Siri then asks for your question) or "Hey Siri, Kai briefing" (a status update across all projects). Third-party apps can't register an always-listening "Hey Kai" wake word, so Siri is the hands-free way in.

`watch/KAI.xcodeproj` is generated from `watch/project.yml`. If you add files or change settings there, run `brew install xcodegen && cd watch && xcodegen`.

## 3. Deploy

```sh
cd backend
npx wrangler login
npx wrangler secret put KAI_API_KEY        # repeat for OPENAI_API_KEY, KAI_PROJECTS, POSTHOG_PERSONAL_API_KEY,
                                           # SENTRY_AUTH_TOKEN, GA4_SERVICE_ACCOUNT_JSON, SUPABASE_SERVICE_ROLE_KEY
# Set SENTRY_ORG, SUPABASE_URL and KAI_TIMEZONE under [vars] in wrangler.toml
npm run deploy
```

Then set `KAI_BASE_URL` in `watch/Config/Secrets.xcconfig` to the `*.workers.dev` URL and rebuild the app.

## Development

```sh
cd backend
npm test            # integrations against mocked APIs, the agent loop, and the HTTP layer
npm run typecheck
```

## Keeping secrets out of git

This repo is public. Every key lives in files that git ignores, and only the templates are committed:

| Secret file (never committed) | Template (committed) |
| --- | --- |
| `backend/.env` (Node) and `backend/.dev.vars` (`wrangler dev`) | `backend/.env.example` |
| `watch/Config/Secrets.xcconfig` | `watch/Config/Secrets.example.xcconfig` |

Once deployed, the backend's keys are stored as Cloudflare secrets (`wrangler secret put`), never in `wrangler.toml`. Run `git status` before each commit; none of the files on the left should appear. If a key is ever pushed, revoke it with its provider straight away. Deleting the commit isn't enough, because public history gets copied.

## Docs

- [docs/performance.md](docs/performance.md): how long answers take, how to measure them, and the plan for making them faster.

## Things to know

- **Model.** The default is `gpt-5-mini` with `OPENAI_REASONING_EFFORT=low`, to keep voice answers quick. Change it with `OPENAI_MODEL`, and remove `OPENAI_REASONING_EFFORT` if you pick a model that doesn't accept it.
- **Privacy.** Metrics and Sentry error details are sent to OpenAI to write the answer. `query_posthog` can read anything the PostHog key can, so keep that key scoped to `query:read`. The backend drops query strings from request URLs and only passes a short list of safe tags from Sentry events.
- **Watch credentials.** The API key is built into the app bundle, which is fine for a personal app on your own watch. If the key leaks, rotate `KAI_API_KEY`.
- **Siri time limits.** Siri gives up on slow intents. Each answer takes one or two model calls plus the API calls, so a broad briefing across many projects may take longer than Siri allows. If that happens, open the app instead, which waits up to 60 seconds.

## Next steps

- Faster answers, if testing shows they're slow (plan in [docs/performance.md](docs/performance.md)).
- Cloudflare integration (Workers errors, analytics, deployments).
- A watch complication or Smart Stack widget showing visitors and open errors.
- Proactive alerts: a scheduled job that checks for error spikes or traffic drops and sends a push notification to the watch.
- A daily "what should I work on" briefing that remembers what you decided yesterday (stored in Supabase).

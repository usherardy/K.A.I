import { vi } from "vitest";
import { loadConfig, type Bindings, type Config } from "../src/config";

export interface FetchCall {
  url: URL;
  method: string;
  headers: Headers;
  body: any;
}

/**
 * Replaces global fetch. The handler gets each request and returns a JSON-able value
 * (200), a Response, or undefined (404). Returns the list of calls for assertions.
 */
export function mockFetch(handler: (call: FetchCall) => unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      let body: any = init.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          // form-encoded or plain text; keep as string
        }
      }
      const call: FetchCall = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body };
      calls.push(call);
      const out = await handler(call);
      if (out instanceof Response) return out;
      if (out === undefined) return new Response(JSON.stringify({ detail: `not mocked: ${url.pathname}` }), { status: 404 });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

export const API_KEY = "test-api-key-0123456789abcdef";

export function testEnv(overrides: Bindings = {}): Bindings {
  return {
    KAI_API_KEY: API_KEY,
    OPENAI_API_KEY: "sk-test",
    KAI_TIMEZONE: "America/New_York",
    KAI_PROJECTS: JSON.stringify([
      {
        id: "shawgames",
        name: "ShawGames",
        aliases: ["shaw games"],
        ga4: { propertyId: "111" },
        posthog: { projectId: "222", revenueEvent: "purchase", revenueProperty: "revenue" },
        sentry: { project: "shawgames" },
      },
      { id: "begin", name: "Begin", sentry: { project: "begin-web" } },
    ]),
    SENTRY_ORG: "acme",
    SENTRY_AUTH_TOKEN: "sentry-token",
    POSTHOG_PERSONAL_API_KEY: "phx_test",
    ...overrides,
  };
}

export function testConfig(overrides: Bindings = {}): Config {
  return loadConfig(testEnv(overrides));
}

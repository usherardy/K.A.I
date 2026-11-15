import { afterEach, describe, expect, it, vi } from "vitest";
import { SentryClient, getErrorDetails, getErrors, resetSentryCache } from "../src/integrations/sentry";
import { mockFetch } from "./helpers";

const client = () => new SentryClient("sentry-token", "https://sentry.io", "acme", "shawgames", "production");

afterEach(() => {
  vi.unstubAllGlobals();
  resetSentryCache();
});

const issue = {
  id: "4501",
  shortId: "SHAWGAMES-1A",
  title: "TimeoutError: Database query timed out",
  culprit: "api/leaderboard",
  level: "error",
  status: "unresolved",
  substatus: "new",
  count: "57",
  userCount: 12,
  project: { slug: "shawgames" },
};

describe("Sentry", () => {
  it("searches new unresolved issues for the project, looking up its id once", async () => {
    const calls = mockFetch(({ url }) => {
      if (url.pathname === "/api/0/projects/acme/shawgames/") return { id: 42 };
      if (url.pathname === "/api/0/organizations/acme/issues/") {
        return new Response(JSON.stringify([issue]), { headers: { "x-hits": "2" } });
      }
    });

    const result = await getErrors(client(), "today", true);
    await getErrors(client(), "today", false);

    expect(calls.filter((c) => c.url.pathname.startsWith("/api/0/projects/"))).toHaveLength(1);
    const search = calls[1]!.url.searchParams;
    expect(search.get("project")).toBe("42");
    expect(search.get("query")).toBe("is:unresolved firstSeen:-24h");
    expect(search.get("statsPeriod")).toBe("24h");
    expect(search.get("environment")).toBe("production");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer sentry-token");
    expect(calls[2]!.url.searchParams.get("query")).toBe("is:unresolved");

    expect(result.totalIssues).toBe(2);
    expect(result.issues[0]).toMatchObject({ id: "4501", status: "new", events: 57, usersAffected: 12 });
  });

  it("summarizes the latest event of an issue", async () => {
    mockFetch(({ url }) => {
      if (url.pathname === "/api/0/organizations/acme/issues/4501/") return issue;
      if (url.pathname === "/api/0/organizations/acme/issues/4501/events/latest/") {
        return {
          dateCreated: "2026-11-15T10:00:00Z",
          entries: [
            {
              type: "exception",
              data: {
                values: [
                  {
                    type: "TimeoutError",
                    value: "Query exceeded 30000ms",
                    mechanism: { handled: false },
                    stacktrace: {
                      frames: [
                        { function: "node:internal", filename: "node:net", inApp: false },
                        { function: "getLeaderboard", filename: "src/db.ts", lineNo: 88, inApp: true },
                        { function: "handler", filename: "src/api/leaderboard.ts", lineNo: 12, inApp: true },
                      ],
                    },
                  },
                ],
              },
            },
            { type: "request", data: { method: "GET", url: "https://shawgames.com/api/leaderboard?token=secret" } },
          ],
          tags: [
            { key: "environment", value: "production" },
            { key: "user.email", value: "someone@example.com" },
          ],
        };
      }
    });

    const details = await getErrorDetails(client(), "4501");
    const event = details.latestEvent!;
    expect(event.exceptions[0]!.topFrames).toEqual(["handler (src/api/leaderboard.ts:12)", "getLeaderboard (src/db.ts:88)"]);
    expect(event.request).toEqual({ method: "GET", url: "https://shawgames.com/api/leaderboard" }); // query string dropped
    expect(event.tags).toEqual({ environment: "production" }); // user PII tag not passed to the model
  });

  it("rejects bad ids and issues from other projects", async () => {
    await expect(getErrorDetails(client(), "../../projects")).rejects.toThrow(/numeric/);
    mockFetch(({ url }) => (url.pathname.endsWith("/events/latest/") ? {} : { ...issue, project: { slug: "other" } }));
    await expect(getErrorDetails(client(), "4501")).rejects.toThrow(/belongs to/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { PostHogClient, getProductMetrics, productSummaryQuery, runHogQL } from "../src/integrations/posthog";
import { mockFetch } from "./helpers";

const client = new PostHogClient("phx_test", "https://us.posthog.com", "222");

afterEach(() => vi.unstubAllGlobals());

describe("PostHog", () => {
  it("builds one query covering both windows, with escaped event names", () => {
    const q = productSummaryQuery("today", { revenueEvent: "it's paid", revenueProperty: "$revenue" });
    expect(q).toContain("uniqIf(person_id, timestamp >= toStartOfDay(now()) AND timestamp < now()) AS unique_users_current");
    expect(q).toContain("timestamp < now() - INTERVAL 1 DAY) AS unique_users_previous");
    expect(q).toContain("event = 'it\\'s paid'");
    expect(q).toContain("toFloat(properties.$revenue)");
    expect(q).toMatch(/WHERE timestamp >= toStartOfDay\(now\(\)\) - INTERVAL 1 DAY AND timestamp < now\(\)$/);
  });

  it("parses headline metrics with comparisons", async () => {
    const calls = mockFetch(() => ({
      columns: ["unique_users_current", "unique_users_previous", "revenue_current", "revenue_previous"],
      results: [[120, 100, 55.5, 50]],
    }));
    const result = await getProductMetrics(client, "today", { revenueEvent: "purchase", revenueProperty: "revenue" });

    expect(calls[0]!.url.href).toBe("https://us.posthog.com/api/projects/222/query/");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer phx_test");
    expect(calls[0]!.body.query.kind).toBe("HogQLQuery");
    expect(result.metrics.unique_users).toEqual({ current: 120, previous: 100, changePercent: 20 });
    expect(result.metrics.revenue).toEqual({ current: 55.5, previous: 50, changePercent: 11 });
    expect(result.conversionEvent).toBe("purchase");
  });

  it("only runs single read-only statements and caps rows", async () => {
    await expect(runHogQL(client, "DELETE FROM events")).rejects.toThrow(/Only SELECT/);
    await expect(runHogQL(client, "SELECT 1; SELECT 2")).rejects.toThrow(/single/);

    mockFetch(() => ({ columns: ["n"], results: Array.from({ length: 80 }, (_, i) => [i]) }));
    const result = await runHogQL(client, "select n from t;");
    expect(result.rows).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});

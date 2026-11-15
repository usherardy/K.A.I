import { afterEach, describe, expect, it, vi } from "vitest";
import { Ga4Client, getTrafficBreakdown, getTrafficSummary } from "../src/integrations/ga4";
import { mockFetch } from "./helpers";

const client = new Ga4Client("111", async () => "token");
const metricHeaders = ["activeUsers", "newUsers", "sessions", "screenPageViews", "keyEvents", "totalRevenue"].map((name) => ({ name }));
const totalsReport = (values: number[]) => ({ metricHeaders, rows: [{ metricValues: values.map((v) => ({ value: String(v) })) }] });

afterEach(() => vi.unstubAllGlobals());

describe("getTrafficSummary", () => {
  it("compares today with yesterday up to the same hour", async () => {
    const calls = mockFetch(({ url, body }) => {
      if (url.pathname.endsWith(":batchRunReports")) {
        return {
          reports: [
            totalsReport([2400, 900, 3000, 8000, 0, 0]),
            { rows: ["00", "01", "13", "14"].map((h) => ({ dimensionValues: [{ value: h }], metricValues: [{ value: "1" }] })) },
          ],
        };
      }
      if (url.pathname.endsWith(":runReport")) {
        expect(body.dimensionFilter.filter.inListFilter.values).toHaveLength(15); // "00".."14"
        expect(body.dimensionFilter.filter.inListFilter.values.at(-1)).toBe("14");
        expect(body.dateRanges).toEqual([{ startDate: "yesterday", endDate: "yesterday" }]);
        return totalsReport([2034, 800, 2600, 7000, 0, 0]);
      }
    });

    const summary = await getTrafficSummary(client, "today");
    expect(calls[0]!.url.pathname).toBe("/v1beta/properties/111:batchRunReports");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer token");
    expect(summary.comparedTo).toContain("through 14:59");
    expect(summary.metrics.activeUsers).toEqual({ current: 2400, previous: 2034, changePercent: 18 });
    expect(summary.metrics).not.toHaveProperty("totalRevenue"); // zero in both periods → dropped
  });

  it("handles a day with no data yet", async () => {
    mockFetch(({ url }) => (url.pathname.endsWith(":batchRunReports") ? { reports: [{ metricHeaders }, {}] } : undefined));
    const summary = await getTrafficSummary(client, "today");
    expect(summary.comparedTo).toContain("no data");
    expect(summary.metrics.activeUsers).toBe(0);
  });

  it("uses complete-day ranges for last_7_days", async () => {
    const calls = mockFetch(() => ({ reports: [totalsReport([700, 1, 1, 1, 3, 50]), totalsReport([500, 1, 1, 1, 0, 0])] }));
    const summary = await getTrafficSummary(client, "last_7_days");
    expect(calls[0]!.body.requests.map((r: any) => r.dateRanges[0])).toEqual([
      { startDate: "7daysAgo", endDate: "yesterday" },
      { startDate: "14daysAgo", endDate: "8daysAgo" },
    ]);
    expect(summary.metrics.activeUsers).toEqual({ current: 700, previous: 500, changePercent: 40 });
    expect(summary.metrics.totalRevenue).toEqual({ current: 50, previous: 0, changePercent: null });
  });
});

describe("getTrafficBreakdown", () => {
  it("returns top sources with share of total", async () => {
    mockFetch(() => ({
      rows: [
        { dimensionValues: [{ value: "bing" }], metricValues: [{ value: "600" }, { value: "500" }] },
        { dimensionValues: [{ value: "" }], metricValues: [{ value: "200" }, { value: "150" }] },
      ],
      totals: [{ metricValues: [{ value: "1000" }, { value: "900" }] }],
    }));
    const result = await getTrafficBreakdown(client, "today", "source");
    expect(result.total).toBe(1000);
    expect(result.top[0]).toEqual({ value: "bing", sessions: 600, activeUsers: 500, sharePercent: 60 });
    expect(result.top[1]!.value).toBe("(not set)");
  });
});

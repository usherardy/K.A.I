/**
 * Google Analytics 4 via the Analytics Data API (v1beta).
 * https://developers.google.com/analytics/devguides/reporting/data/v1/rest
 */
import type { ServiceAccount } from "../config";
import { fetchJson } from "../http";
import { compare, round2, type Comparison, type Period } from "../periods";
import { getGoogleAccessToken } from "./google-auth";

const API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

interface DateRange {
  startDate: string;
  endDate: string;
}

interface ReportRow {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

export interface Ga4Report {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: ReportRow[];
  totals?: ReportRow[];
}

export type TokenProvider = () => Promise<string>;

export class Ga4Client {
  constructor(
    private readonly propertyId: string,
    private readonly getToken: TokenProvider,
  ) {}

  static withServiceAccount(propertyId: string, sa: ServiceAccount): Ga4Client {
    return new Ga4Client(propertyId, () => getGoogleAccessToken(sa, SCOPE));
  }

  runReport(body: object): Promise<Ga4Report> {
    return this.call<Ga4Report>("runReport", body);
  }

  async batchRunReports(requests: object[]): Promise<Ga4Report[]> {
    const res = await this.call<{ reports?: Ga4Report[] }>("batchRunReports", { requests });
    return res.reports ?? [];
  }

  runRealtimeReport(body: object): Promise<Ga4Report> {
    return this.call<Ga4Report>("runRealtimeReport", body);
  }

  private async call<T>(method: string, body: object): Promise<T> {
    const token = await this.getToken();
    return fetchJson<T>("Google Analytics", `${API}/properties/${encodeURIComponent(this.propertyId)}:${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

/** Complete-day ranges for every period except "today", which is handled hour-by-hour. */
const RANGES: Record<Exclude<Period, "today">, { current: DateRange; previous: DateRange; comparedTo: string }> = {
  yesterday: {
    current: { startDate: "yesterday", endDate: "yesterday" },
    previous: { startDate: "2daysAgo", endDate: "2daysAgo" },
    comparedTo: "the day before yesterday",
  },
  last_7_days: {
    current: { startDate: "7daysAgo", endDate: "yesterday" },
    previous: { startDate: "14daysAgo", endDate: "8daysAgo" },
    comparedTo: "the previous 7 days",
  },
  last_28_days: {
    current: { startDate: "28daysAgo", endDate: "yesterday" },
    previous: { startDate: "56daysAgo", endDate: "29daysAgo" },
    comparedTo: "the previous 28 days",
  },
};

const TODAY: DateRange = { startDate: "today", endDate: "today" };

function currentRange(period: Period): DateRange {
  return period === "today" ? TODAY : RANGES[period].current;
}

const SUMMARY_METRICS = ["activeUsers", "newUsers", "sessions", "screenPageViews", "keyEvents", "totalRevenue"];
/** Shown even when zero; the rest are dropped when both periods are zero (e.g. no e-commerce). */
const ALWAYS_SHOWN = new Set(["activeUsers", "newUsers", "sessions", "screenPageViews"]);

export interface TrafficSummary {
  period: Period;
  comparedTo: string;
  metrics: Record<string, Comparison | number>;
}

/**
 * Headline traffic numbers with a like-for-like comparison. For "today" the
 * comparison is yesterday up to the same hour (in the GA4 property's time zone),
 * which is what "up 18% from yesterday at this time" needs.
 */
export async function getTrafficSummary(client: Ga4Client, period: Period): Promise<TrafficSummary> {
  const metrics = SUMMARY_METRICS.map((name) => ({ name }));
  let current: Record<string, number>;
  let previous: Record<string, number> | undefined;
  let comparedTo: string;

  if (period === "today") {
    const [todayTotals, todayByHour] = await client.batchRunReports([
      { dateRanges: [TODAY], metrics },
      { dateRanges: [TODAY], dimensions: [{ name: "hour" }], metrics: [{ name: "sessions" }] },
    ]);
    current = totals(todayTotals);
    const hours = rows(todayByHour)
      .map((r) => Number(r.dimensions[0]))
      .filter(Number.isFinite);

    if (hours.length === 0) {
      comparedTo = "nothing yet: no data recorded today";
    } else {
      const lastHour = Math.max(...hours);
      const hourValues = Array.from({ length: lastHour + 1 }, (_, h) => String(h).padStart(2, "0"));
      previous = totals(
        await client.runReport({
          dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
          metrics,
          dimensionFilter: { filter: { fieldName: "hour", inListFilter: { values: hourValues } } },
        }),
      );
      comparedTo = `yesterday up to the same hour (through ${String(lastHour).padStart(2, "0")}:59 property time)`;
    }
  } else {
    const range = RANGES[period];
    const [cur, prev] = await client.batchRunReports([
      { dateRanges: [range.current], metrics },
      { dateRanges: [range.previous], metrics },
    ]);
    current = totals(cur);
    previous = totals(prev);
    comparedTo = range.comparedTo;
  }

  const out: Record<string, Comparison | number> = {};
  for (const name of SUMMARY_METRICS) {
    const c = current[name] ?? 0;
    const p = previous?.[name];
    if (!ALWAYS_SHOWN.has(name) && c === 0 && !p) continue;
    out[name] = p === undefined ? round2(c) : compare(c, p);
  }
  return { period, comparedTo, metrics: out };
}

export const BREAKDOWNS = {
  source: "sessionSource",
  channel: "sessionDefaultChannelGroup",
  country: "country",
  device: "deviceCategory",
  page: "pagePath",
} as const;
export type Breakdown = keyof typeof BREAKDOWNS;

/** Top values of one dimension (traffic sources, channels, countries, devices or pages). */
export async function getTrafficBreakdown(client: Ga4Client, period: Period, by: Breakdown) {
  const metricNames = by === "page" ? ["screenPageViews", "activeUsers"] : ["sessions", "activeUsers"];
  const primary = metricNames[0]!;
  const report = await client.runReport({
    dateRanges: [currentRange(period)],
    dimensions: [{ name: BREAKDOWNS[by] }],
    metrics: metricNames.map((name) => ({ name })),
    orderBys: [{ metric: { metricName: primary }, desc: true }],
    metricAggregations: ["TOTAL"],
    limit: 8,
  });

  const top = rows(report);
  const total = Number(report.totals?.[0]?.metricValues?.[0]?.value) || top.reduce((sum, r) => sum + (r.metrics[0] ?? 0), 0);
  return {
    period,
    by,
    metric: primary,
    total,
    top: top.map((r) => ({
      value: r.dimensions[0] || "(not set)",
      [primary]: r.metrics[0] ?? 0,
      activeUsers: r.metrics[1] ?? 0,
      sharePercent: total ? Math.round(((r.metrics[0] ?? 0) / total) * 100) : null,
    })),
  };
}

/** People on the site right now (GA4 realtime = last 30 minutes). */
export async function getRealtimeVisitors(client: Ga4Client) {
  const [overall, byPage] = await Promise.all([
    client.runRealtimeReport({ metrics: [{ name: "activeUsers" }] }),
    client.runRealtimeReport({
      dimensions: [{ name: "unifiedScreenName" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 5,
    }),
  ]);
  return {
    window: "last 30 minutes",
    activeUsers: totals(overall).activeUsers ?? 0,
    topPages: rows(byPage).map((r) => ({ page: r.dimensions[0] || "(not set)", activeUsers: r.metrics[0] ?? 0 })),
  };
}

/** Metric values of a report with no dimensions (one row), keyed by metric name. */
export function totals(report: Ga4Report | undefined): Record<string, number> {
  const names = report?.metricHeaders?.map((h) => h.name) ?? [];
  const values = report?.rows?.[0]?.metricValues ?? [];
  return Object.fromEntries(names.map((name, i) => [name, Number(values[i]?.value ?? 0) || 0]));
}

export function rows(report: Ga4Report | undefined): { dimensions: string[]; metrics: number[] }[] {
  return (report?.rows ?? []).map((row) => ({
    dimensions: (row.dimensionValues ?? []).map((d) => d.value ?? ""),
    metrics: (row.metricValues ?? []).map((m) => Number(m.value ?? 0) || 0),
  }));
}

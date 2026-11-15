/**
 * PostHog via the HogQL query API.
 * https://posthog.com/docs/api/queries
 */
import { ToolInputError } from "../errors";
import { fetchJson } from "../http";
import { compare, type Comparison, type Period } from "../periods";

export interface HogQLResult {
  columns: string[];
  results: unknown[][];
}

export class PostHogClient {
  constructor(
    private readonly apiKey: string,
    private readonly host: string,
    private readonly projectId: string,
  ) {}

  async query(hogql: string): Promise<HogQLResult> {
    const res = await fetchJson<{ columns?: string[]; results?: unknown[][] }>(
      "PostHog",
      `${this.host}/api/projects/${encodeURIComponent(this.projectId)}/query/`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
      },
      30_000,
    );
    return { columns: res.columns ?? [], results: res.results ?? [] };
  }
}

const START_OF_TODAY = "toStartOfDay(now())";
const daysAgo = (n: number) => `${START_OF_TODAY} - INTERVAL ${n} DAY`;

/** [start, end) windows as HogQL expressions. Day boundaries follow the PostHog project's time zone. */
export const WINDOWS: Record<Period, { current: [string, string]; previous: [string, string]; comparedTo: string }> = {
  today: {
    current: [START_OF_TODAY, "now()"],
    previous: [daysAgo(1), "now() - INTERVAL 1 DAY"],
    comparedTo: "yesterday at the same time",
  },
  yesterday: { current: [daysAgo(1), START_OF_TODAY], previous: [daysAgo(2), daysAgo(1)], comparedTo: "the day before yesterday" },
  last_7_days: { current: [daysAgo(7), START_OF_TODAY], previous: [daysAgo(14), daysAgo(7)], comparedTo: "the previous 7 days" },
  last_28_days: { current: [daysAgo(28), START_OF_TODAY], previous: [daysAgo(56), daysAgo(28)], comparedTo: "the previous 28 days" },
};

export interface RevenueConfig {
  revenueEvent?: string;
  revenueProperty?: string;
}

/** One query that computes every headline metric for the current and comparison windows. */
export function productSummaryQuery(period: Period, revenue: RevenueConfig = {}): string {
  const w = WINDOWS[period];
  const inCurrent = `timestamp >= ${w.current[0]} AND timestamp < ${w.current[1]}`;
  const inPrevious = `timestamp >= ${w.previous[0]} AND timestamp < ${w.previous[1]}`;
  const both = (name: string, expr: (window: string) => string) => [
    `${expr(inCurrent)} AS ${name}_current`,
    `${expr(inPrevious)} AS ${name}_previous`,
  ];

  const columns = [
    ...both("unique_users", (win) => `uniqIf(person_id, ${win})`),
    ...both("pageviews", (win) => `countIf(event = '$pageview' AND ${win})`),
    ...both("events", (win) => `countIf(${win})`),
  ];
  if (revenue.revenueEvent) {
    const event = hogqlString(revenue.revenueEvent);
    columns.push(...both("conversions", (win) => `countIf(event = ${event} AND ${win})`));
    if (revenue.revenueProperty) {
      const prop = revenue.revenueProperty; // validated as an identifier in config.ts
      columns.push(...both("revenue", (win) => `sumIf(toFloat(properties.${prop}), event = ${event} AND ${win})`));
    }
  }
  return `SELECT ${columns.join(", ")} FROM events WHERE timestamp >= ${w.previous[0]} AND timestamp < ${w.current[1]}`;
}

export async function getProductMetrics(client: PostHogClient, period: Period, revenue: RevenueConfig = {}) {
  const { columns, results } = await client.query(productSummaryQuery(period, revenue));
  const row = results[0] ?? [];
  const values = new Map(columns.map((col, i) => [col, Number(row[i] ?? 0) || 0]));

  const metrics: Record<string, Comparison> = {};
  for (const col of columns) {
    if (!col.endsWith("_current")) continue;
    const base = col.slice(0, -"_current".length);
    metrics[base] = compare(values.get(col) ?? 0, values.get(`${base}_previous`) ?? 0);
  }
  return {
    period,
    comparedTo: WINDOWS[period].comparedTo,
    ...(revenue.revenueEvent ? { conversionEvent: revenue.revenueEvent } : {}),
    metrics,
  };
}

export async function getTopEvents(client: PostHogClient, period: Period, limit = 10) {
  const [start, end] = WINDOWS[period].current;
  const { results } = await client.query(
    `SELECT event, count() AS events, uniq(person_id) AS users FROM events ` +
      `WHERE timestamp >= ${start} AND timestamp < ${end} GROUP BY event ORDER BY events DESC LIMIT ${limit}`,
  );
  return {
    period,
    events: results.map((r) => ({ event: String(r[0]), count: Number(r[1]) || 0, uniqueUsers: Number(r[2]) || 0 })),
  };
}

const MAX_ROWS = 50;

/** Runs a model-written read-only HogQL query (the PostHog key only needs query:read). */
export async function runHogQL(client: PostHogClient, hogql: string) {
  const query = hogql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(query)) throw new ToolInputError("Only SELECT (or WITH … SELECT) HogQL queries are allowed.");
  if (query.includes(";")) throw new ToolInputError("Send a single HogQL statement.");
  if (query.length > 4000) throw new ToolInputError("Query is too long.");

  const { columns, results } = await client.query(query);
  return { columns, rows: results.slice(0, MAX_ROWS), truncated: results.length > MAX_ROWS };
}

function hogqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Sentry via the REST API (organization issue search + issue/event details).
 * https://docs.sentry.io/api/events/list-an-organizations-issues/
 */
import { ToolInputError, truncate } from "../errors";
import { requestJson } from "../http";
import type { Period } from "../periods";

export interface SentryIssue {
  id: string;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  status?: string;
  substatus?: string | null;
  priority?: string | null;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  isUnhandled?: boolean;
  project?: { slug?: string };
}

interface SentryFrame {
  function?: string | null;
  filename?: string | null;
  module?: string | null;
  absPath?: string | null;
  lineNo?: number | null;
  inApp?: boolean;
}

interface SentryEntry {
  type: string;
  data?: {
    values?: { type?: string; value?: string; mechanism?: { handled?: boolean }; stacktrace?: { frames?: SentryFrame[] } }[];
    url?: string;
    method?: string;
  };
}

export interface SentryEvent {
  eventID?: string;
  dateCreated?: string;
  message?: string;
  entries?: SentryEntry[];
  tags?: { key: string; value: string }[];
}

/** Project slug → numeric id, shared across requests (the issue search needs the id). */
const projectIdCache = new Map<string, Promise<string>>();

export class SentryClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
    readonly org: string,
    readonly project: string,
    readonly environment?: string,
  ) {}

  async searchIssues(opts: { query: string; statsPeriod: string; sort?: string; limit?: number }) {
    const projectId = await this.projectId();
    const { data, headers } = await this.get<SentryIssue[]>(`organizations/${enc(this.org)}/issues/`, {
      project: projectId,
      query: opts.query,
      statsPeriod: opts.statsPeriod,
      sort: opts.sort ?? "user",
      limit: opts.limit ?? 10,
      environment: this.environment,
    });
    const issues = data ?? [];
    return { issues, totalHits: Number(headers.get("x-hits")) || issues.length };
  }

  async issue(issueId: string): Promise<SentryIssue> {
    return (await this.get<SentryIssue>(`organizations/${enc(this.org)}/issues/${enc(issueId)}/`)).data;
  }

  async latestEvent(issueId: string): Promise<SentryEvent> {
    return (await this.get<SentryEvent>(`organizations/${enc(this.org)}/issues/${enc(issueId)}/events/latest/`)).data;
  }

  private projectId(): Promise<string> {
    const key = `${this.baseUrl}|${this.org}|${this.project}`;
    let pending = projectIdCache.get(key);
    if (!pending) {
      pending = this.get<{ id: string }>(`projects/${enc(this.org)}/${enc(this.project)}/`).then((r) => String(r.data.id));
      pending.catch(() => projectIdCache.delete(key)); // don't cache failures
      projectIdCache.set(key, pending);
    }
    return pending;
  }

  private get<T>(path: string, params: Record<string, string | number | undefined> = {}) {
    const url = new URL(`${this.baseUrl}/api/0/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    return requestJson<T>("Sentry", url.toString(), { headers: { authorization: `Bearer ${this.token}` } });
  }
}

export function resetSentryCache(): void {
  projectIdCache.clear();
}

/** Sentry only supports rolling windows, so map each period to the closest one. */
export const SENTRY_WINDOWS: Record<Period, { statsPeriod: string; label: string }> = {
  today: { statsPeriod: "24h", label: "last 24 hours" },
  yesterday: { statsPeriod: "48h", label: "last 48 hours" },
  last_7_days: { statsPeriod: "7d", label: "last 7 days" },
  last_28_days: { statsPeriod: "28d", label: "last 28 days" },
};

/** Unresolved issues seen in the window, most users affected first. */
export async function getErrors(client: SentryClient, period: Period, onlyNew: boolean) {
  const w = SENTRY_WINDOWS[period];
  const query = onlyNew ? `is:unresolved firstSeen:-${w.statsPeriod}` : "is:unresolved";
  const { issues, totalHits } = await client.searchIssues({ query, statsPeriod: w.statsPeriod, sort: "user", limit: 10 });
  return {
    window: w.label,
    filter: onlyNew ? "new issues first seen in this window" : "unresolved issues with events in this window",
    environment: client.environment ?? "all",
    totalIssues: totalHits,
    issues: issues.map(summarizeIssue),
  };
}

/** Compact numbers for the portfolio overview: how many issues, how many are new, and the worst ones. */
export async function getErrorOverview(client: SentryClient, period: Period) {
  const w = SENTRY_WINDOWS[period];
  const [active, fresh] = await Promise.all([
    client.searchIssues({ query: "is:unresolved", statsPeriod: w.statsPeriod, sort: "user", limit: 3 }),
    client.searchIssues({ query: `is:unresolved firstSeen:-${w.statsPeriod}`, statsPeriod: w.statsPeriod, sort: "user", limit: 3 }),
  ]);
  return {
    window: w.label,
    unresolvedIssuesWithActivity: active.totalHits,
    newIssues: fresh.totalHits,
    worstIssues: active.issues.map(summarizeIssue),
    newestIssues: fresh.issues.map(summarizeIssue),
  };
}

/** What the error is and where it happens: exception, top in-app stack frames, request and tags. */
export async function getErrorDetails(client: SentryClient, issueId: string) {
  if (!/^\d+$/.test(issueId)) throw new ToolInputError("issue_id must be the numeric Sentry issue id returned by get_errors.");
  const [issue, event] = await Promise.all([client.issue(issueId), client.latestEvent(issueId).catch(() => null)]);
  if (issue.project?.slug && issue.project.slug !== client.project) {
    throw new ToolInputError(`Issue ${issueId} belongs to Sentry project "${issue.project.slug}", not "${client.project}".`);
  }
  return { ...summarizeIssue(issue), latestEvent: event ? summarizeEvent(event) : null };
}

export function summarizeIssue(issue: SentryIssue) {
  return {
    id: String(issue.id),
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit || undefined,
    level: issue.level,
    status: issue.substatus ?? issue.status,
    priority: issue.priority ?? undefined,
    events: Number(issue.count ?? 0) || 0,
    usersAffected: issue.userCount ?? 0,
    unhandled: issue.isUnhandled,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
  };
}

const USEFUL_TAGS = new Set(["environment", "release", "browser", "os", "device", "runtime", "url", "transaction", "server_name", "handled"]);

function summarizeEvent(event: SentryEvent) {
  const exceptionValues = event.entries?.find((e) => e.type === "exception")?.data?.values ?? [];
  const request = event.entries?.find((e) => e.type === "request")?.data;
  return {
    timestamp: event.dateCreated,
    message: event.message || undefined,
    exceptions: exceptionValues.map((x) => ({
      type: x.type,
      message: truncate(x.value ?? "", 300),
      handled: x.mechanism?.handled,
      topFrames: topFrames(x.stacktrace?.frames ?? []),
    })),
    request: request?.url ? { method: request.method, url: request.url.split("?")[0] } : undefined,
    tags: Object.fromEntries((event.tags ?? []).filter((t) => USEFUL_TAGS.has(t.key)).map((t) => [t.key, t.value])),
  };
}

/** Frames are ordered oldest → newest; return up to five, crash site first, preferring in-app code. */
function topFrames(frames: SentryFrame[]): string[] {
  const inApp = frames.filter((f) => f.inApp);
  return (inApp.length ? inApp : frames)
    .slice(-5)
    .reverse()
    .map((f) => {
      const file = f.filename ?? f.module ?? f.absPath ?? "?";
      return `${f.function ?? "<anonymous>"} (${file}${f.lineNo ? `:${f.lineNo}` : ""})`;
    });
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

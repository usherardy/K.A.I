/**
 * The tools the model can call. Each tool validates its own arguments and returns
 * plain JSON; errors are returned to the model as text so it can explain them.
 */
import { connectedSources, type Config, type Integration, type ProjectConfig } from "./config";
import { NotConfiguredError, ToolInputError, UpstreamError, errorMessage, truncate } from "./errors";
import { BREAKDOWNS, Ga4Client, getRealtimeVisitors, getTrafficBreakdown, getTrafficSummary, type Breakdown } from "./integrations/ga4";
import { PostHogClient, getProductMetrics, getTopEvents, runHogQL } from "./integrations/posthog";
import { SentryClient, getErrorDetails, getErrorOverview, getErrors } from "./integrations/sentry";
import type { LlmTool } from "./llm";
import { PERIODS, parsePeriod, type Period } from "./periods";

export interface ToolContext {
  config: Config;
}

type Args = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  /** Tool is offered only when this source is connected for at least one project. */
  integration?: Integration;
  parameters: (projectIds: string[]) => object;
  run: (args: Args, ctx: ToolContext) => Promise<unknown>;
}

const MAX_TOOL_RESULT_CHARS = 8000;

const projectParam = (ids: string[]) => ({ type: "string", enum: ids, description: "Project id." });
const periodParam = {
  type: "string",
  enum: PERIODS,
  description: "Time window. 'today' compares with yesterday at the same time. Defaults to today.",
};
const schema = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS: ToolDef[] = [
  {
    name: "get_portfolio_overview",
    description:
      "Health check across ALL projects at once: traffic, product usage and Sentry errors for each. " +
      "Use for briefings, 'how is everything', and 'what should I focus on'.",
    parameters: () => schema({ period: periodParam }),
    run: async (args, { config }) => {
      const period = parsePeriod(args.period);
      return { period, projects: await Promise.all(config.projects.map((p) => projectOverview(config, p, period))) };
    },
  },
  {
    name: "get_traffic_summary",
    integration: "ga4",
    description:
      "Google Analytics 4 headline numbers for one project: visitors (activeUsers), new users, sessions, page views, " +
      "key events and revenue, each with the comparison period and percent change.",
    parameters: (ids) => schema({ project: projectParam(ids), period: periodParam }, ["project"]),
    run: async (args, { config }) => getTrafficSummary(ga4For(config, getProject(config, args.project)), parsePeriod(args.period)),
  },
  {
    name: "get_traffic_breakdown",
    integration: "ga4",
    description: "Google Analytics 4 top traffic sources, channels, countries, devices or pages for one project.",
    parameters: (ids) =>
      schema(
        {
          project: projectParam(ids),
          period: periodParam,
          by: { type: "string", enum: Object.keys(BREAKDOWNS), description: "Dimension to break down by." },
        },
        ["project", "by"],
      ),
    run: async (args, { config }) => {
      const by = args.by;
      if (typeof by !== "string" || !(by in BREAKDOWNS)) throw new ToolInputError(`by must be one of: ${Object.keys(BREAKDOWNS).join(", ")}`);
      return getTrafficBreakdown(ga4For(config, getProject(config, args.project)), parsePeriod(args.period), by as Breakdown);
    },
  },
  {
    name: "get_realtime_visitors",
    integration: "ga4",
    description: "How many people are on a project's site right now (last 30 minutes) and which pages they're on.",
    parameters: (ids) => schema({ project: projectParam(ids) }, ["project"]),
    run: async (args, { config }) => getRealtimeVisitors(ga4For(config, getProject(config, args.project))),
  },
  {
    name: "get_product_metrics",
    integration: "posthog",
    description:
      "PostHog product analytics for one project: unique users, pageviews, total events, and conversions/revenue " +
      "if a revenue event is configured, each with comparison and percent change.",
    parameters: (ids) => schema({ project: projectParam(ids), period: periodParam }, ["project"]),
    run: async (args, { config }) => {
      const project = getProject(config, args.project);
      return getProductMetrics(posthogFor(config, project), parsePeriod(args.period), project.posthog);
    },
  },
  {
    name: "get_top_events",
    integration: "posthog",
    description: "PostHog's most frequent events for one project in a period, with unique users per event.",
    parameters: (ids) => schema({ project: projectParam(ids), period: periodParam }, ["project"]),
    run: async (args, { config }) => getTopEvents(posthogFor(config, getProject(config, args.project)), parsePeriod(args.period)),
  },
  {
    name: "query_posthog",
    integration: "posthog",
    description:
      "Run a read-only HogQL (ClickHouse SQL dialect) SELECT against a project's PostHog data, for questions the other " +
      "tools can't answer (funnels, specific events, properties). Tables: events (event, timestamp, person_id, " +
      "distinct_id, properties.<name>), persons. Always aggregate and add LIMIT. Example: SELECT count() FROM events " +
      "WHERE event = 'level_complete' AND timestamp >= toStartOfDay(now())",
    parameters: (ids) =>
      schema({ project: projectParam(ids), hogql: { type: "string", description: "A single HogQL SELECT statement." } }, ["project", "hogql"]),
    run: async (args, { config }) => {
      if (typeof args.hogql !== "string" || !args.hogql.trim()) throw new ToolInputError("hogql is required.");
      return runHogQL(posthogFor(config, getProject(config, args.project)), args.hogql);
    },
  },
  {
    name: "get_errors",
    integration: "sentry",
    description:
      "Sentry unresolved issues for one project, most users affected first, with event counts, users affected, level " +
      "and status (new, regressed, escalating, ongoing). Set only_new to list issues first seen in the window.",
    parameters: (ids) =>
      schema(
        {
          project: projectParam(ids),
          period: periodParam,
          only_new: { type: "boolean", description: "Only issues first seen in this window. Defaults to false." },
        },
        ["project"],
      ),
    run: async (args, { config }) => getErrors(sentryFor(config, getProject(config, args.project)), parsePeriod(args.period), args.only_new === true),
  },
  {
    name: "get_error_details",
    integration: "sentry",
    description:
      "Details for one Sentry issue: exception type and message, top stack frames, request URL, environment, release " +
      "and browser. Use the numeric id from get_errors or the portfolio overview.",
    parameters: (ids) =>
      schema({ project: projectParam(ids), issue_id: { type: "string", description: "Numeric Sentry issue id." } }, ["project", "issue_id"]),
    run: async (args, { config }) => getErrorDetails(sentryFor(config, getProject(config, args.project)), String(args.issue_id ?? "").trim()),
  },
];

export function toolSchemas(config: Config): LlmTool[] {
  const ids = config.projects.map((p) => p.id);
  return TOOLS.filter((tool) => isAvailable(config, tool)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters(ids),
  }));
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || !isAvailable(ctx.config, tool)) return failure(`Unknown or unavailable tool "${name}".`);

  let args: Args;
  try {
    const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    args = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Args) : {};
  } catch {
    return failure("Tool arguments were not valid JSON.");
  }

  try {
    const result = await tool.run(args, ctx);
    return { ok: true, content: truncate(JSON.stringify(result), MAX_TOOL_RESULT_CHARS) };
  } catch (err) {
    if (!(err instanceof ToolInputError || err instanceof NotConfiguredError || err instanceof UpstreamError)) {
      console.error(`Tool ${name} crashed:`, err);
    }
    return failure(errorMessage(err));
  }
}

function failure(message: string): ToolResult {
  return { ok: false, content: JSON.stringify({ error: message }) };
}

function isAvailable(config: Config, tool: ToolDef): boolean {
  const integration = tool.integration;
  return !integration || config.projects.some((p) => connectedSources(config, p).includes(integration));
}

export function getProject(config: Config, value: unknown): ProjectConfig {
  if (typeof value !== "string" || !value.trim()) {
    if (config.projects.length === 1) return config.projects[0]!;
    throw new ToolInputError(`project is required. Known projects: ${config.projects.map((p) => p.id).join(", ")}`);
  }
  const wanted = value.trim().toLowerCase();
  const project = config.projects.find(
    (p) => p.id === wanted || p.name.toLowerCase() === wanted || p.aliases.some((a) => a.toLowerCase() === wanted),
  );
  if (!project) throw new ToolInputError(`Unknown project "${value}". Known projects: ${config.projects.map((p) => p.id).join(", ")}`);
  return project;
}

function ga4For(config: Config, project: ProjectConfig): Ga4Client {
  if (!config.ga4) throw new NotConfiguredError("Google Analytics credentials aren't configured on the server.");
  if (!project.ga4) throw new NotConfiguredError(`Google Analytics isn't connected for ${project.name}.`);
  return Ga4Client.withServiceAccount(project.ga4.propertyId, config.ga4.serviceAccount);
}

function posthogFor(config: Config, project: ProjectConfig): PostHogClient {
  if (!config.posthog) throw new NotConfiguredError("PostHog credentials aren't configured on the server.");
  if (!project.posthog) throw new NotConfiguredError(`PostHog isn't connected for ${project.name}.`);
  return new PostHogClient(config.posthog.apiKey, config.posthog.host, project.posthog.projectId);
}

function sentryFor(config: Config, project: ProjectConfig): SentryClient {
  if (!config.sentry) throw new NotConfiguredError("Sentry credentials aren't configured on the server.");
  if (!project.sentry) throw new NotConfiguredError(`Sentry isn't connected for ${project.name}.`);
  const { org, project: slug, environment } = project.sentry;
  return new SentryClient(config.sentry.token, config.sentry.baseUrl, org, slug, environment);
}

async function projectOverview(config: Config, project: ProjectConfig, period: Period) {
  const sources = connectedSources(config, project);
  const [traffic, product, errors] = await Promise.all([
    settle(sources.includes("ga4") ? () => getTrafficSummary(ga4For(config, project), period) : undefined),
    settle(sources.includes("posthog") ? () => getProductMetrics(posthogFor(config, project), period, project.posthog) : undefined),
    settle(sources.includes("sentry") ? () => getErrorOverview(sentryFor(config, project), period) : undefined),
  ]);
  return {
    project: project.id,
    name: project.name,
    ...(sources.length === 0 ? { note: "No data sources connected." } : {}),
    ...(traffic ? { traffic } : {}),
    ...(product ? { product } : {}),
    ...(errors ? { errors } : {}),
  };
}

async function settle<T>(fn: (() => Promise<T>) | undefined): Promise<T | { error: string } | undefined> {
  if (!fn) return undefined;
  try {
    return await fn();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * Turns environment variables (Node `process.env` or Cloudflare Worker bindings)
 * into a validated Config. Secrets come from env vars; the list of projects comes
 * from KAI_PROJECTS (JSON) so adding a project never needs a code change.
 */

export type Bindings = Record<string, string | undefined>;

export type Integration = "ga4" | "posthog" | "sentry";

export interface ProjectConfig {
  /** Stable slug the model uses to refer to the project, e.g. "shawgames". */
  id: string;
  /** Display / spoken name, e.g. "ShawGames". */
  name: string;
  /** Other names the user might say, e.g. ["shaw games"]. */
  aliases: string[];
  /** One line of context for the model, e.g. "Browser games site, revenue from ads". */
  description?: string;
  ga4?: { propertyId: string };
  posthog?: {
    projectId: string;
    /** Event that represents a purchase / conversion, e.g. "purchase". */
    revenueEvent?: string;
    /** Numeric property on revenueEvent holding the amount, e.g. "revenue" or "$revenue". */
    revenueProperty?: string;
  };
  sentry?: { org: string; project: string; environment?: string };
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface Config {
  /** Shared secret the watch app sends as `Authorization: Bearer …`. */
  apiKey: string;
  /** Default time zone for "today" in the system prompt when the client doesn't send one. */
  timeZone: string;
  openai: { apiKey: string; model: string; baseUrl: string; reasoningEffort?: string; transcribeModel: string };
  projects: ProjectConfig[];
  ga4?: { serviceAccount: ServiceAccount };
  posthog?: { apiKey: string; host: string };
  sentry?: { token: string; baseUrl: string };
  supabase?: { url: string; key: string };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const HOGQL_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function loadConfig(env: Bindings): Config {
  const apiKey = required(env, "KAI_API_KEY");
  if (apiKey.length < 24) {
    throw new ConfigError("KAI_API_KEY must be at least 24 characters (generate one with `openssl rand -hex 32`).");
  }

  const timeZone = optional(env, "KAI_TIMEZONE") ?? "UTC";
  if (!isValidTimeZone(timeZone)) throw new ConfigError(`KAI_TIMEZONE "${timeZone}" is not a valid IANA time zone.`);

  const config: Config = {
    apiKey,
    timeZone,
    openai: {
      apiKey: required(env, "OPENAI_API_KEY"),
      model: optional(env, "OPENAI_MODEL") ?? "gpt-5-mini",
      baseUrl: stripSlash(optional(env, "OPENAI_BASE_URL") ?? "https://api.openai.com/v1"),
      reasoningEffort: optional(env, "OPENAI_REASONING_EFFORT"),
      transcribeModel: optional(env, "OPENAI_TRANSCRIBE_MODEL") ?? "gpt-4o-mini-transcribe",
    },
    projects: parseProjects(required(env, "KAI_PROJECTS"), optional(env, "SENTRY_ORG"), Boolean(optional(env, "SENTRY_AUTH_TOKEN"))),
  };

  const ga4Json = optional(env, "GA4_SERVICE_ACCOUNT_JSON");
  if (ga4Json) config.ga4 = { serviceAccount: parseServiceAccount(ga4Json) };

  const posthogKey = optional(env, "POSTHOG_PERSONAL_API_KEY");
  if (posthogKey) {
    config.posthog = { apiKey: posthogKey, host: stripSlash(optional(env, "POSTHOG_HOST") ?? "https://us.posthog.com") };
  }

  const sentryToken = optional(env, "SENTRY_AUTH_TOKEN");
  if (sentryToken) {
    config.sentry = { token: sentryToken, baseUrl: stripSlash(optional(env, "SENTRY_BASE_URL") ?? "https://sentry.io") };
  }

  const supabaseUrl = optional(env, "SUPABASE_URL");
  const supabaseKey = optional(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseUrl && supabaseKey) config.supabase = { url: stripSlash(supabaseUrl), key: supabaseKey };
  else if (supabaseUrl || supabaseKey) throw new ConfigError("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither.");

  return config;
}

/** Which data sources are usable for a project (configured on the project AND credentials present). */
export function connectedSources(config: Config, project: ProjectConfig): Integration[] {
  const sources: Integration[] = [];
  if (project.ga4 && config.ga4) sources.push("ga4");
  if (project.posthog && config.posthog) sources.push("posthog");
  if (project.sentry && config.sentry) sources.push("sentry");
  return sources;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseProjects(raw: string, defaultSentryOrg: string | undefined, sentryEnabled: boolean): ProjectConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("KAI_PROJECTS is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ConfigError("KAI_PROJECTS must be a non-empty JSON array.");

  const projects = parsed.map((item, index) => parseProject(item, index, defaultSentryOrg, sentryEnabled));
  const ids = new Set<string>();
  for (const p of projects) {
    if (ids.has(p.id)) throw new ConfigError(`KAI_PROJECTS has two projects with id "${p.id}".`);
    ids.add(p.id);
  }
  return projects;
}

function parseProject(item: unknown, index: number, defaultSentryOrg: string | undefined, sentryEnabled: boolean): ProjectConfig {
  const where = `KAI_PROJECTS[${index}]`;
  if (!isObject(item)) throw new ConfigError(`${where} must be an object.`);

  const id = str(item.id, `${where}.id`);
  if (!SLUG.test(id)) throw new ConfigError(`${where}.id "${id}" must be lowercase letters, digits, "-" or "_".`);

  const project: ProjectConfig = {
    id,
    name: str(item.name ?? id, `${where}.name`),
    aliases: Array.isArray(item.aliases) ? item.aliases.map((a, i) => str(a, `${where}.aliases[${i}]`)) : [],
  };
  if (item.description !== undefined) project.description = str(item.description, `${where}.description`);

  if (item.ga4 !== undefined) {
    const ga4 = obj(item.ga4, `${where}.ga4`);
    const propertyId = str(ga4.propertyId, `${where}.ga4.propertyId`);
    if (!/^\d+$/.test(propertyId)) throw new ConfigError(`${where}.ga4.propertyId must be the numeric GA4 property id.`);
    project.ga4 = { propertyId };
  }

  if (item.posthog !== undefined) {
    const ph = obj(item.posthog, `${where}.posthog`);
    const projectId = str(ph.projectId, `${where}.posthog.projectId`);
    if (!/^\d+$/.test(projectId)) throw new ConfigError(`${where}.posthog.projectId must be the numeric PostHog project id.`);
    project.posthog = { projectId };
    if (ph.revenueEvent !== undefined) project.posthog.revenueEvent = str(ph.revenueEvent, `${where}.posthog.revenueEvent`);
    if (ph.revenueProperty !== undefined) {
      const prop = str(ph.revenueProperty, `${where}.posthog.revenueProperty`);
      if (!HOGQL_IDENTIFIER.test(prop)) throw new ConfigError(`${where}.posthog.revenueProperty may only contain letters, digits, "_" and "$".`);
      if (!project.posthog.revenueEvent) throw new ConfigError(`${where}.posthog.revenueProperty requires revenueEvent.`);
      project.posthog.revenueProperty = prop;
    }
  }

  if (item.sentry !== undefined) {
    const s = obj(item.sentry, `${where}.sentry`);
    const org = s.org !== undefined ? str(s.org, `${where}.sentry.org`) : defaultSentryOrg;
    const slug = str(s.project, `${where}.sentry.project`);
    // Without a Sentry token the block is unused, so don't block startup over a missing org.
    if (!org && sentryEnabled) throw new ConfigError(`${where}.sentry.org is missing and SENTRY_ORG is not set.`);
    if (org) {
      project.sentry = { org, project: slug };
      if (s.environment !== undefined) project.sentry.environment = str(s.environment, `${where}.sentry.environment`);
    }
  }

  return project;
}

/** Accepts the service-account key file as raw JSON or base64-encoded JSON. */
function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(atob(raw));
    } catch {
      throw new ConfigError("GA4_SERVICE_ACCOUNT_JSON must be the service-account key JSON (or base64 of it).");
    }
  }
  if (!isObject(parsed) || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new ConfigError("GA4_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  }
  // Keys pasted through some shells keep literal "\n" sequences.
  return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, "\n") };
}

function required(env: Bindings, key: string): string {
  const value = optional(env, key);
  if (!value) throw new ConfigError(`${key} is not set.`);
  return value;
}

function optional(env: Bindings, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (!isObject(value)) throw new ConfigError(`${where} must be an object.`);
  return value;
}

function str(value: unknown, where: string): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${where} must be a non-empty string.`);
  return value.trim();
}

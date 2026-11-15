import { describe, expect, it } from "vitest";
import { ConfigError, connectedSources, loadConfig } from "../src/config";
import { testEnv } from "./helpers";

describe("loadConfig", () => {
  it("parses projects and applies defaults", () => {
    const config = loadConfig(testEnv());
    expect(config.openai.model).toBe("gpt-5-mini");
    expect(config.posthog?.host).toBe("https://us.posthog.com");
    expect(config.sentry?.baseUrl).toBe("https://sentry.io");
    expect(config.projects.map((p) => p.id)).toEqual(["shawgames", "begin"]);
    expect(config.projects[1]!.sentry).toEqual({ org: "acme", project: "begin-web" });
  });

  it("only reports sources that have both project config and credentials", () => {
    const config = loadConfig(testEnv()); // no GA4 credentials in testEnv
    expect(connectedSources(config, config.projects[0]!)).toEqual(["posthog", "sentry"]);
    expect(connectedSources(config, config.projects[1]!)).toEqual(["sentry"]);
  });

  it("requires a long API key", () => {
    expect(() => loadConfig(testEnv({ KAI_API_KEY: "short" }))).toThrow(ConfigError);
  });

  it("rejects a revenue property that isn't a plain identifier (HogQL injection guard)", () => {
    const projects = JSON.stringify([{ id: "x", posthog: { projectId: "1", revenueEvent: "buy", revenueProperty: "a) OR (1" } }]);
    expect(() => loadConfig(testEnv({ KAI_PROJECTS: projects }))).toThrow(/revenueProperty/);
  });

  it("requires a Sentry org once a Sentry token is set", () => {
    const projects = JSON.stringify([{ id: "x", sentry: { project: "x" } }]);
    expect(() => loadConfig(testEnv({ KAI_PROJECTS: projects, SENTRY_ORG: undefined }))).toThrow(/SENTRY_ORG/);
    const withoutToken = loadConfig(testEnv({ KAI_PROJECTS: projects, SENTRY_ORG: undefined, SENTRY_AUTH_TOKEN: undefined }));
    expect(withoutToken.projects[0]!.sentry).toBeUndefined();
  });

  it("rejects duplicate project ids and bad JSON", () => {
    expect(() => loadConfig(testEnv({ KAI_PROJECTS: '[{"id":"a"},{"id":"a"}]' }))).toThrow(/two projects/);
    expect(() => loadConfig(testEnv({ KAI_PROJECTS: "[{" }))).toThrow(/not valid JSON/);
  });

  it("accepts the GA4 service account as raw or base64 JSON", () => {
    const sa = { client_email: "kai@x.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n" };
    const raw = loadConfig(testEnv({ GA4_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }));
    const b64 = loadConfig(testEnv({ GA4_SERVICE_ACCOUNT_JSON: btoa(JSON.stringify(sa)) }));
    expect(raw.ga4?.serviceAccount.private_key).toContain("\nabc\n");
    expect(b64.ga4?.serviceAccount).toEqual(raw.ga4?.serviceAccount);
  });

  it("requires both Supabase settings", () => {
    expect(() => loadConfig(testEnv({ SUPABASE_URL: "https://x.supabase.co" }))).toThrow(/SUPABASE/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { base64url, getGoogleAccessToken, resetGoogleTokenCache, signServiceAccountJwt } from "../src/integrations/google-auth";
import { mockFetch } from "./helpers";

async function makeServiceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, "$1\n");
  return {
    sa: { client_email: "kai@test.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n` },
    publicKey: pair.publicKey,
  };
}

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

afterEach(() => {
  vi.unstubAllGlobals();
  resetGoogleTokenCache();
});

describe("Google service-account auth", () => {
  it("signs a verifiable RS256 JWT with the right claims", async () => {
    const { sa, publicKey } = await makeServiceAccount();
    const jwt = await signServiceAccountJwt(sa, "scope-a", 1_700_000_000_000);
    const [header, claims, sig] = jwt.split(".");

    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims!)).toEqual({
      iss: sa.client_email,
      scope: "scope-a",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });

    const signature = Uint8Array.from(atob(sig!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);
  });

  it("exchanges the JWT for an access token and caches it", async () => {
    const { sa } = await makeServiceAccount();
    const calls = mockFetch(() => ({ access_token: "ya29.token", expires_in: 3600 }));

    expect(await getGoogleAccessToken(sa, "scope-a")).toBe("ya29.token");
    expect(await getGoogleAccessToken(sa, "scope-a")).toBe("ya29.token");
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);
  });

  it("base64url encodes without padding", () => {
    expect(base64url(new Uint8Array([251, 255]))).toBe("-_8");
  });
});

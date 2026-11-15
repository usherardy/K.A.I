/**
 * Google service-account OAuth (JWT bearer grant) using WebCrypto, so it works the
 * same on Node and Cloudflare Workers without the googleapis SDK.
 */
import type { ServiceAccount } from "../config";
import { fetchJson } from "../http";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const cache = new Map<string, { token: string; expiresAt: number }>();

export async function getGoogleAccessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const cacheKey = `${sa.client_email}|${scope}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const assertion = await signServiceAccountJwt(sa, scope);
  const res = await fetchJson<{ access_token: string; expires_in: number }>("Google OAuth", TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });

  cache.set(cacheKey, { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 });
  return res.access_token;
}

export async function signServiceAccountJwt(sa: ServiceAccount, scope: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: sa.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const unsigned = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(claims)))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

export function resetGoogleTokenCache(): void {
  cache.clear();
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

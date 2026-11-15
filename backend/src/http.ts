import { UpstreamError, errorMessage, truncate } from "./errors";

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
}

/**
 * fetch() wrapper for JSON APIs: applies a timeout and turns network failures and
 * non-2xx responses into UpstreamError with a short, human-readable reason.
 */
export async function requestJson<T>(
  service: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<JsonResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new UpstreamError(service, 0, timedOut ? `timed out after ${timeoutMs / 1000}s` : errorMessage(err));
  }

  const text = await res.text();
  if (!res.ok) throw new UpstreamError(service, res.status, describeErrorBody(text));

  try {
    return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  } catch {
    throw new UpstreamError(service, res.status, "response was not valid JSON");
  }
}

export async function fetchJson<T>(service: string, url: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  return (await requestJson<T>(service, url, init, timeoutMs)).data;
}

function describeErrorBody(text: string): string {
  try {
    const body = JSON.parse(text);
    const message =
      body?.error?.message ?? body?.detail ?? body?.message ?? body?.error_description ?? (typeof body?.error === "string" ? body.error : undefined);
    if (typeof message === "string" && message) return truncate(message, 300);
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return truncate(text.replace(/\s+/g, " ").trim() || "empty response", 300);
}

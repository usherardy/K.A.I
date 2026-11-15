/** An HTTP call to a third-party service failed (network error, timeout or non-2xx response). */
export class UpstreamError extends Error {
  override name = "UpstreamError";
  constructor(
    readonly service: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${service} request failed${status ? ` (HTTP ${status})` : ""}: ${detail}`);
  }
}

/** The model passed tool arguments we can't use. The message is shown to the model so it can retry. */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}

/** A data source isn't connected for the requested project. */
export class NotConfiguredError extends Error {
  override name = "NotConfiguredError";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

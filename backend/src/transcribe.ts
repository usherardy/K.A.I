/**
 * Speech-to-text for questions recorded on the watch. watchOS has no on-device
 * speech recognition API, so the watch uploads audio and we transcribe it here.
 */
import type { Config } from "./config";
import { requestJson } from "./http";

export interface Transcriber {
  transcribe(audio: Blob, filename: string): Promise<string>;
}

/** Audio content types the watch (or anything else) may send, mapped to the file extension OpenAI expects. */
export const AUDIO_TYPES: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

export class OpenAITranscriber implements Transcriber {
  constructor(private readonly opts: { apiKey: string; baseUrl: string; model: string; prompt?: string }) {}

  async transcribe(audio: Blob, filename: string): Promise<string> {
    const form = new FormData();
    form.append("file", audio, filename);
    form.append("model", this.opts.model);
    form.append("response_format", "json");
    if (this.opts.prompt) form.append("prompt", this.opts.prompt);

    const { data } = await requestJson<{ text?: string }>(
      "OpenAI",
      `${this.opts.baseUrl}/audio/transcriptions`,
      { method: "POST", headers: { authorization: `Bearer ${this.opts.apiKey}` }, body: form },
      30_000,
    );
    return data?.text?.trim() ?? "";
  }
}

/** Primes the transcriber with project names and tool names so "ShawGames" isn't heard as "Shaw games". */
export function transcriptionPrompt(config: Config): string {
  const names = [...new Set(config.projects.flatMap((p) => [p.name, ...p.aliases]))];
  return (
    `A founder asking their assistant Kai about their products (${names.join(", ")}): ` +
    "visitors, traffic, revenue, errors and what to focus on. Terms: PostHog, Sentry, Google Analytics, GA4, Cloudflare."
  );
}

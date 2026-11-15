import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAITranscriber, transcriptionPrompt } from "../src/transcribe";
import { mockFetch, testConfig } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAITranscriber", () => {
  it("uploads the audio as multipart with the model and a vocabulary prompt", async () => {
    const calls = mockFetch(() => ({ text: "  How's ShawGames doing today?  " }));
    const transcriber = new OpenAITranscriber({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", prompt: "ShawGames" });

    const text = await transcriber.transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }), "question.m4a");

    expect(text).toBe("How's ShawGames doing today?");
    const call = calls[0]!;
    expect(call.url.href).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(call.headers.get("authorization")).toBe("Bearer sk-test");
    const form = call.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("prompt")).toBe("ShawGames");
    const file = form.get("file") as File;
    expect(file.name).toBe("question.m4a");
    expect(file.size).toBe(3);
  });

  it("primes the prompt with every project name and alias", () => {
    const prompt = transcriptionPrompt(testConfig());
    expect(prompt).toContain("ShawGames, shaw games, Begin");
    expect(prompt).toContain("PostHog");
  });
});

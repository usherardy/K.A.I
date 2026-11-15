/**
 * Conversation history, so follow-ups like "what are those errors?" work.
 * Supabase in production; in-memory when Supabase isn't configured (local dev).
 */
import type { Config } from "./config";
import { fetchJson, requestJson } from "./http";
import type { ChatMessage } from "./llm";

export interface ConversationStore {
  load(id: string): Promise<ChatMessage[] | null>;
  save(id: string, messages: ChatMessage[]): Promise<void>;
}

export class MemoryStore implements ConversationStore {
  private readonly items = new Map<string, { messages: ChatMessage[]; updatedAt: number }>();

  constructor(
    private readonly maxItems = 200,
    private readonly ttlMs = 12 * 60 * 60 * 1000,
  ) {}

  async load(id: string): Promise<ChatMessage[] | null> {
    const item = this.items.get(id);
    if (!item) return null;
    if (Date.now() - item.updatedAt > this.ttlMs) {
      this.items.delete(id);
      return null;
    }
    return structuredClone(item.messages);
  }

  async save(id: string, messages: ChatMessage[]): Promise<void> {
    this.items.delete(id); // re-insert so Map order is least-recently-used first
    this.items.set(id, { messages: structuredClone(messages), updatedAt: Date.now() });
    while (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }
}

/** Talks to Supabase's PostgREST API directly; see supabase/migrations for the table. */
export class SupabaseStore implements ConversationStore {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly table = "kai_conversations",
  ) {}

  async load(id: string): Promise<ChatMessage[] | null> {
    const rows = await fetchJson<{ messages: ChatMessage[] }[]>(
      "Supabase",
      `${this.url}/rest/v1/${this.table}?id=eq.${encodeURIComponent(id)}&select=messages`,
      { headers: this.headers() },
    );
    return rows?.[0]?.messages ?? null;
  }

  async save(id: string, messages: ChatMessage[]): Promise<void> {
    await requestJson("Supabase", `${this.url}/rest/v1/${this.table}?on_conflict=id`, {
      method: "POST",
      headers: this.headers({ prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ id, messages, updated_at: new Date().toISOString() }),
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { apikey: this.key, "content-type": "application/json", ...extra };
    // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys only go in apikey.
    if (this.key.startsWith("eyJ")) headers.authorization = `Bearer ${this.key}`;
    return headers;
  }
}

const sharedMemoryStore = new MemoryStore();

export function createStore(config: Config): ConversationStore {
  return config.supabase ? new SupabaseStore(config.supabase.url, config.supabase.key) : sharedMemoryStore;
}

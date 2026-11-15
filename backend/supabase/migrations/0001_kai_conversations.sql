-- Conversation history for KAI (lets follow-up questions reuse earlier answers).
-- Run in the Supabase SQL editor, or with `supabase db push`.

create table if not exists public.kai_conversations (
  id uuid primary key,
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists kai_conversations_updated_at_idx on public.kai_conversations (updated_at);

-- Only the backend (service role key, which bypasses RLS) may read or write.
-- RLS on with no policies blocks the anon and authenticated roles entirely.
alter table public.kai_conversations enable row level security;

-- Optional cleanup: delete conversations idle for more than 30 days (needs pg_cron).
-- select cron.schedule('kai-conversations-cleanup', '0 4 * * *',
--   $$delete from public.kai_conversations where updated_at < now() - interval '30 days'$$);

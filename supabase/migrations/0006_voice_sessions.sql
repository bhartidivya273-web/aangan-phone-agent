-- What the voice provider tells us while a call is in progress (caller number, pick-up time), joined to the end-of-call report by call id.
create table if not exists voice_sessions (
  provider text not null,
  provider_call_id text not null,
  caller_phone text,
  started_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (provider, provider_call_id)
);
alter table voice_sessions enable row level security;
revoke all on table public.voice_sessions from anon, authenticated;

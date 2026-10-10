-- Aangan Studio phone-enquiry agent: call log. Server-side only (service role); RLS on, no public policies.
create extension if not exists pgcrypto;

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text unique,            -- caller ID, normalised; repeat callers merge on this
  name text,
  fields jsonb not null default '{}'::jsonb, -- merged extracted fields across all calls
  status text not null default 'open'
    check (status in ('open','qualified','declined','escalated','existing_client','other')),
  flags text[] not null default '{}',
  call_count int not null default 0,
  first_call_at timestamptz,
  last_call_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  source text not null default 'ai' check (source in ('ai','front_desk')), -- FR19: front-desk calls are logged too
  caller_phone text,
  caller_phone_normalized text,
  started_at timestamptz not null,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec int,
  after_hours boolean not null default false,
  transcript text,
  classification_status text not null default 'ok' check (classification_status in ('ok','failed','pending')),
  outcome text check (outcome in ('qualified','ask_one_question','not_a_fit','timeline_too_short','pricing_asked',
    'escalate','existing_client','other','dropped_or_missed','repeat_caller')),
  underlying_outcome text,
  reason text,
  extracted jsonb not null default '{}'::jsonb,
  flags text[] not null default '{}',
  pricing_asked boolean not null default false,
  guards text[] not null default '{}',
  classifier_model text,
  provider text,
  provider_call_id text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists calls_lead_idx on calls(lead_id, started_at);
create index if not exists calls_started_idx on calls(started_at desc);
create unique index if not exists calls_provider_uniq on calls(provider, provider_call_id) where provider_call_id is not null;

create table if not exists handoffs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  call_id uuid references calls(id),
  kind text not null check (kind in ('new','updated','escalation','unclaimed_alert','failure_alert')),
  status text not null default 'sent' check (status in ('sent','failed')),
  telegram_chat_id text,
  telegram_message_id bigint,
  note_text text not null,
  sent_at timestamptz,
  due_at timestamptz,                       -- first-contact target (kind new/updated) or callback target (escalation)
  claimed_by text,
  claimed_at timestamptz,
  unclaimed_alert_sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists handoffs_msg_idx on handoffs(telegram_chat_id, telegram_message_id);
create index if not exists handoffs_unclaimed_idx on handoffs(due_at) where claimed_at is null and unclaimed_alert_sent_at is null;

-- One row per cost component per call (llm tokens, voice minutes, telephony). Amounts are in `currency`.
create table if not exists costs (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id),
  kind text not null check (kind in ('llm_classifier','llm_agent','voice','telephony')),
  model text,
  input_tokens int,
  output_tokens int,
  minutes numeric,
  amount numeric not null default 0,
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);
create index if not exists costs_call_idx on costs(call_id);

-- Never delete declined or escalated calls (FR12); the log is append-only for those outcomes.
create or replace function prevent_protected_call_delete() returns trigger as $$
begin
  if old.outcome in ('not_a_fit','escalate','timeline_too_short') then
    raise exception 'calls with outcome % must never be deleted (FR12)', old.outcome;
  end if;
  return old;
end;
$$ language plpgsql;

drop trigger if exists calls_no_delete_protected on calls;
create trigger calls_no_delete_protected before delete on calls
  for each row execute function prevent_protected_call_delete();

alter table leads enable row level security;
alter table calls enable row level security;
alter table handoffs enable row level security;
alter table costs enable row level security;

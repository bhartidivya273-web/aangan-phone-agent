-- Dashboard inputs: designer response (first contact, fit verdict) and the funnel (consultation, project).
-- These are filled from designers' Telegram replies (see README: reply conventions) or edited directly.
alter table handoffs
  add column if not exists first_contact_at timestamptz,
  add column if not exists fit_verdict text check (fit_verdict in ('good','poor'));

alter table leads
  add column if not exists consultation_at timestamptz,
  add column if not exists project_signed_at timestamptz;

-- Demo rows (provider = 'demo', written by `npm run seed`) may be deleted so the demo can be reset.
-- Every other declined/escalated call stays undeletable (FR12).
create or replace function prevent_protected_call_delete() returns trigger as $$
begin
  if old.provider = 'demo' then
    return old;
  end if;
  if old.outcome in ('not_a_fit','escalate','timeline_too_short') then
    raise exception 'calls with outcome % must never be deleted (FR12)', old.outcome;
  end if;
  return old;
end;
$$ language plpgsql;

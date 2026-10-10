-- Consultation bookings made by the phone assistant (one shared calendar: Mon-Sat office hours by default).
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked','cancelled')),
  customer_name text,
  customer_phone text,
  customer_phone_normalized text,
  notes text,
  call_id uuid references calls(id),
  lead_id uuid references leads(id),
  created_at timestamptz not null default now()
);
create index if not exists bookings_start_idx on bookings(start_at) where status = 'booked';
create index if not exists bookings_unlinked_idx on bookings(created_at) where call_id is null;
alter table bookings enable row level security;
revoke all on table public.bookings from anon, authenticated;

-- The instant "consultation booked" message to the designers is stored as a handoff of kind booking_alert.
alter table handoffs drop constraint if exists handoffs_kind_check;
alter table handoffs add constraint handoffs_kind_check
  check (kind in ('new','updated','escalation','unclaimed_alert','failure_alert','booking_alert'));

-- Atomic booking: two callers can never take the same slot beyond its capacity. Returns the new booking id, or null if the slot is full.
create or replace function book_slot(
  p_start timestamptz, p_end timestamptz, p_capacity int,
  p_name text, p_phone text, p_phone_norm text, p_notes text
) returns uuid
language plpgsql
set search_path = public
as $$
declare taken int; new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('book_slot:' || p_start::text));
  select count(*) into taken from bookings where start_at = p_start and status = 'booked';
  if taken >= p_capacity then return null; end if;
  insert into bookings (start_at, end_at, customer_name, customer_phone, customer_phone_normalized, notes)
  values (p_start, p_end, p_name, p_phone, p_phone_norm, p_notes)
  returning id into new_id;
  return new_id;
end;
$$;
revoke all on function public.book_slot(timestamptz, timestamptz, int, text, text, text, text) from public, anon, authenticated;

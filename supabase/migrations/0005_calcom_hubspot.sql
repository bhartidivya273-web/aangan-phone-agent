-- Cal.com bookings are mirrored in our table (for linking to calls and the dashboard); HubSpot sync state per call and lead.
alter table bookings
  add column if not exists external_provider text,   -- e.g. 'calcom'
  add column if not exists external_id text;         -- Cal.com booking uid
create unique index if not exists bookings_external_uniq on bookings(external_provider, external_id) where external_id is not null;

alter table calls
  add column if not exists hubspot_contact_id text,
  add column if not exists hubspot_note_id text,
  add column if not exists hubspot_error text;

alter table leads
  add column if not exists hubspot_contact_id text;

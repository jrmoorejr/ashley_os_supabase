-- Check dealers in from text messages.
-- Texts arrive at the inbound-checkin Edge Function (Twilio number, iPhone Shortcut, Android forwarder).
-- Clear ones check the dealer in automatically; unclear ones wait in the app's review inbox.

alter table public.visits
  add column source             text not null default 'app' check (source in ('app', 'text')),
  add column requested_rep_id   uuid references public.team_members(id) on delete set null,  -- who the buyer asked for
  add column requested_rep_name text,                                                        -- as written in the text
  add column meet_location      text;                                                        -- e.g. Front Desk

-- The same market text often lands on several reps' phones and gets forwarded more than once.
-- A dealer can only have one open visit per market, so duplicates can't double-check them in.
create unique index visits_one_open on public.visits (market_id, dealer_id) where checked_out_at is null;

create table public.inbound_messages (
  id               uuid primary key default gen_random_uuid(),
  received_at      timestamptz not null default now(),
  channel          text not null default 'sms',   -- sms | shortcut | forward
  from_number      text,
  body             text not null,
  parsed_dealer    text,
  parsed_party     text,
  parsed_account   text,
  confidence       text,                           -- high | medium | low
  status           text not null default 'pending'
                     check (status in ('pending', 'checked_in', 'duplicate', 'ignored')),
  visit_id         uuid references public.visits(id) on delete set null,
  handled_by       uuid references public.team_members(id) on delete set null,
  handled_at       timestamptz
);
create index inbound_messages_received_idx on public.inbound_messages (received_at desc);

alter table public.inbound_messages enable row level security;
create policy team_read   on public.inbound_messages for select to authenticated using (public.is_team_member());
create policy team_update on public.inbound_messages for update to authenticated using (public.is_team_member()) with check (public.is_team_member());
-- Inserts come only from the Edge Function (service role).

alter publication supabase_realtime add table public.inbound_messages;

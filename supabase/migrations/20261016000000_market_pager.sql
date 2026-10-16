-- Market Pager schema
-- Tracks dealers on the market floor, which division/rep they are walking with,
-- who they have already seen, and pages sent to the next division(s).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table public.divisions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  color       text not null default '#64748b',
  sort_order  int  not null default 0,
  active      boolean not null default true
);

insert into public.divisions (name, color, sort_order) values
  ('Motion',     '#2563eb', 1),
  ('Case Goods', '#b45309', 2),
  ('Bedding',    '#7c3aed', 3),
  ('Stationary', '#059669', 4),
  ('Accents',    '#db2777', 5);

create table public.team_members (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  email         text not null,
  phone         text,                       -- E.164, e.g. +13365551234
  role          text not null default 'rep' check (role in ('rep', 'admin')),
  notify_sms    boolean not null default true,
  notify_email  boolean not null default true,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index team_members_email_key on public.team_members (lower(email));

create table public.member_divisions (
  member_id    uuid not null references public.team_members(id) on delete cascade,
  division_id  uuid not null references public.divisions(id) on delete cascade,
  primary key (member_id, division_id)
);

create table public.markets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  starts_on   date,
  ends_on     date,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index markets_one_active on public.markets (is_active) where is_active;

create table public.dealers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  account_number  text,
  city            text,
  state           text,
  created_at      timestamptz not null default now()
);
create unique index dealers_name_key on public.dealers (lower(name));

-- ---------------------------------------------------------------------------
-- Market activity
-- ---------------------------------------------------------------------------
create table public.visits (
  id              uuid primary key default gen_random_uuid(),
  market_id       uuid not null references public.markets(id) on delete cascade,
  dealer_id       uuid not null references public.dealers(id) on delete restrict,
  party           text,                     -- who came with the dealer
  notes           text,
  checked_in_at   timestamptz not null default now(),
  checked_out_at  timestamptz,
  checked_in_by   uuid references public.team_members(id) on delete set null
);
create index visits_market_idx on public.visits (market_id);

-- One row per division a dealer walks through.
create table public.walkthroughs (
  id           uuid primary key default gen_random_uuid(),
  visit_id     uuid not null references public.visits(id) on delete cascade,
  division_id  uuid not null references public.divisions(id),
  rep_id       uuid references public.team_members(id) on delete set null,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz
);
create index walkthroughs_visit_idx on public.walkthroughs (visit_id);
-- A dealer can only be in one division at a time.
create unique index walkthroughs_one_open on public.walkthroughs (visit_id) where ended_at is null;

-- A request for a division to come get a dealer.
create table public.pages (
  id            uuid primary key default gen_random_uuid(),
  visit_id      uuid not null references public.visits(id) on delete cascade,
  division_id   uuid not null references public.divisions(id),
  requested_by  uuid references public.team_members(id) on delete set null,
  requested_at  timestamptz not null default now(),
  claimed_by    uuid references public.team_members(id) on delete set null,
  claimed_at    timestamptz,
  cancelled_at  timestamptz
);
create index pages_visit_idx on public.pages (visit_id);
-- Only one open page per dealer per division.
create unique index pages_one_open on public.pages (visit_id, division_id)
  where claimed_at is null and cancelled_at is null;

create table public.notification_log (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid references public.pages(id) on delete cascade,
  member_id    uuid references public.team_members(id) on delete set null,
  channel      text not null check (channel in ('sms', 'email')),
  destination  text,
  status       text not null,              -- sent | failed | skipped
  detail       text,
  created_at   timestamptz not null default now()
);
create index notification_log_page_idx on public.notification_log (page_id);

-- ---------------------------------------------------------------------------
-- Access control: only people on the team list (by login email) get in.
-- ---------------------------------------------------------------------------
create or replace function public.is_team_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where active and role = 'admin' and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.divisions        enable row level security;
alter table public.team_members     enable row level security;
alter table public.member_divisions enable row level security;
alter table public.markets          enable row level security;
alter table public.dealers          enable row level security;
alter table public.visits           enable row level security;
alter table public.walkthroughs     enable row level security;
alter table public.pages            enable row level security;
alter table public.notification_log enable row level security;

-- Everyone on the team can read everything.
create policy team_read on public.divisions        for select to authenticated using (public.is_team_member());
create policy team_read on public.team_members     for select to authenticated using (public.is_team_member());
create policy team_read on public.member_divisions for select to authenticated using (public.is_team_member());
create policy team_read on public.markets          for select to authenticated using (public.is_team_member());
create policy team_read on public.dealers          for select to authenticated using (public.is_team_member());
create policy team_read on public.visits           for select to authenticated using (public.is_team_member());
create policy team_read on public.walkthroughs     for select to authenticated using (public.is_team_member());
create policy team_read on public.pages            for select to authenticated using (public.is_team_member());
create policy team_read on public.notification_log for select to authenticated using (public.is_team_member());

-- Admins manage setup data.
create policy admin_write on public.divisions        for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.team_members     for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.member_divisions for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_write on public.markets          for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Any team member runs the floor.
create policy team_write on public.dealers      for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy team_write on public.visits       for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy team_write on public.walkthroughs for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy team_write on public.pages        for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
-- notification_log is written only by the page-team Edge Function (service role).

-- ---------------------------------------------------------------------------
-- Realtime: every phone on the floor sees changes instantly.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.visits, public.walkthroughs, public.pages, public.notification_log,
  public.team_members, public.member_divisions, public.markets, public.dealers, public.divisions;

-- ---------------------------------------------------------------------------
-- Excel-friendly log of every division walk, with minutes spent.
-- ---------------------------------------------------------------------------
create or replace view public.walkthrough_log with (security_invoker = true) as
select
  m.name                                  as market,
  d.name                                  as dealer,
  d.account_number,
  v.checked_in_at,
  v.checked_out_at,
  dv.name                                 as division,
  tm.full_name                            as rep,
  w.started_at,
  w.ended_at,
  round(extract(epoch from (coalesce(w.ended_at, now()) - w.started_at)) / 60.0, 1) as minutes_in_division,
  round(extract(epoch from (coalesce(v.checked_out_at, now()) - v.checked_in_at)) / 60.0, 1) as minutes_in_showroom
from public.walkthroughs w
join public.visits v        on v.id = w.visit_id
join public.markets m       on m.id = v.market_id
join public.dealers d       on d.id = v.dealer_id
join public.divisions dv    on dv.id = w.division_id
left join public.team_members tm on tm.id = w.rep_id;

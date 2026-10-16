-- First-login setup: each rep confirms their name, cell and divisions, and opts in (or not)
-- to text alerts. The consent wording and time are stored as proof of opt-in for carriers.

alter table public.team_members
  add column onboarded_at      timestamptz,
  add column sms_consent_at    timestamptz,   -- texts are only sent when this is set
  add column sms_consent_text  text;          -- exact wording the rep agreed to

-- Small shared settings, e.g. the password iPhone Shortcuts use to send check-in texts.
create table public.app_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);
alter table public.app_settings enable row level security;
create policy team_read   on public.app_settings for select to authenticated using (public.is_team_member());
create policy admin_write on public.app_settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- Reps can't edit team_members directly (admins only), so setup goes through this function,
-- which only touches the caller's own row and division list.
create or replace function public.complete_setup(
  p_full_name     text,
  p_phone         text,
  p_division_ids  uuid[],
  p_sms_consent   boolean,
  p_consent_text  text,
  p_notify_email  boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid;
begin
  select id into me from public.team_members
   where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  if me is null then
    raise exception 'This email is not on the team list';
  end if;

  update public.team_members set
    full_name        = coalesce(nullif(trim(p_full_name), ''), full_name),
    phone            = nullif(trim(p_phone), ''),
    notify_sms       = coalesce(p_sms_consent, false),
    notify_email     = coalesce(p_notify_email, true),
    sms_consent_at   = case when p_sms_consent then now() end,
    sms_consent_text = case when p_sms_consent then p_consent_text end,
    onboarded_at     = now()
  where id = me;

  delete from public.member_divisions where member_id = me;
  insert into public.member_divisions (member_id, division_id)
  select me, d.id from public.divisions d where d.id = any(coalesce(p_division_ids, '{}'));
end;
$$;
revoke all on function public.complete_setup(text, text, uuid[], boolean, text, boolean) from public;
grant execute on function public.complete_setup(text, text, uuid[], boolean, text, boolean) to authenticated;

alter publication supabase_realtime add table public.app_settings;

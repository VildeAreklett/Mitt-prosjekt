-- Strømflyt tilgangsstyring: kun inviterte/autoriserte brukere.
-- Kjør i Supabase SQL Editor etter migration-002.

create table if not exists public.stromflyt_tilganger (
  email       text primary key check (position('@' in email) > 1),
  role        text not null default 'medarbeider' check (role in ('admin','medarbeider')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.stromflyt_tilganger (email, role, active)
values ('vilde@adaptic.no', 'admin', true)
on conflict (email) do update set active = true, role = excluded.role;

alter table public.stromflyt_tilganger enable row level security;

drop policy if exists "stromflyt users read own access" on public.stromflyt_tilganger;
create policy "stromflyt users read own access" on public.stromflyt_tilganger
  for select to authenticated
  using (active = true and lower(email) = lower(auth.jwt() ->> 'email'));

create or replace function public.stromflyt_has_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.stromflyt_tilganger t
    where t.active = true
      and lower(t.email) = lower(auth.jwt() ->> 'email')
  );
$$;

alter table public.strombestillinger enable row level security;
drop policy if exists "authenticated full access" on public.strombestillinger;
drop policy if exists "stromflyt invited read" on public.strombestillinger;
drop policy if exists "stromflyt invited insert" on public.strombestillinger;
drop policy if exists "stromflyt invited update" on public.strombestillinger;
drop policy if exists "stromflyt invited delete" on public.strombestillinger;

create policy "stromflyt invited read" on public.strombestillinger
  for select to authenticated using (public.stromflyt_has_access());
create policy "stromflyt invited insert" on public.strombestillinger
  for insert to authenticated with check (public.stromflyt_has_access());
create policy "stromflyt invited update" on public.strombestillinger
  for update to authenticated using (public.stromflyt_has_access()) with check (public.stromflyt_has_access());
create policy "stromflyt invited delete" on public.strombestillinger
  for delete to authenticated using (public.stromflyt_has_access());

alter table public.strombestilling_hendelser enable row level security;
drop policy if exists "authenticated read history" on public.strombestilling_hendelser;
drop policy if exists "stromflyt invited read history" on public.strombestilling_hendelser;
create policy "stromflyt invited read history" on public.strombestilling_hendelser
  for select to authenticated using (public.stromflyt_has_access());

-- Legg til flere brukere slik, etter at de er invitert i Supabase Authentication:
-- insert into public.stromflyt_tilganger (email, role, active)
-- values ('kollega@adaptic.no', 'medarbeider', true)
-- on conflict (email) do update set active = true;

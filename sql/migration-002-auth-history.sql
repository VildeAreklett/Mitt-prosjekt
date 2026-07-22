-- Kjør i Supabase SQL Editor før plattformen deles.
-- 1) Stenger anonym tilgang til strombestillinger.
-- 2) Gir innloggede brukere tilgang.
-- 3) Logger opprettelse, endringer, statusbytter og sletting automatisk.

alter table public.strombestillinger enable row level security;

drop policy if exists "anon full access" on public.strombestillinger;
drop policy if exists "authenticated full access" on public.strombestillinger;
create policy "authenticated full access" on public.strombestillinger
  for all to authenticated using (true) with check (true);

create table if not exists public.strombestilling_hendelser (
  id                    uuid primary key default gen_random_uuid(),
  strombestilling_id    uuid references public.strombestillinger(id) on delete set null,
  action                text not null check (action in ('opprettet','endret','slettet')),
  from_status           text,
  to_status             text,
  changed_fields        text[] not null default '{}',
  actor_id              uuid,
  actor_email           text,
  created_at            timestamptz not null default now()
);

create index if not exists strombestilling_hendelser_parent_idx
  on public.strombestilling_hendelser (strombestilling_id, created_at desc);

alter table public.strombestilling_hendelser enable row level security;
drop policy if exists "authenticated read history" on public.strombestilling_hendelser;
create policy "authenticated read history" on public.strombestilling_hendelser
  for select to authenticated using (true);

create or replace function public.log_strombestilling_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fields text[] := '{}';
  email text := null;
  uid uuid := auth.uid();
begin
  begin
    email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
  exception when others then
    email := null;
  end;

  if tg_op = 'INSERT' then
    insert into public.strombestilling_hendelser
      (strombestilling_id, action, to_status, changed_fields, actor_id, actor_email)
    values (new.id, 'opprettet', new.status, array['opprettet'], uid, email);
    return new;
  elsif tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}')
      into fields
      from jsonb_each(to_jsonb(new)) n
     where n.key not in ('updated_at')
       and (to_jsonb(old) -> n.key) is distinct from n.value;
    insert into public.strombestilling_hendelser
      (strombestilling_id, action, from_status, to_status, changed_fields, actor_id, actor_email)
    values (new.id, 'endret', old.status, new.status, fields, uid, email);
    return new;
  else
    insert into public.strombestilling_hendelser
      (strombestilling_id, action, from_status, changed_fields, actor_id, actor_email)
    values (old.id, 'slettet', old.status, array['slettet'], uid, email);
    return old;
  end if;
end;
$$;

drop trigger if exists trg_log_strombestilling_change on public.strombestillinger;
create trigger trg_log_strombestilling_change
  after insert or update or delete on public.strombestillinger
  for each row execute function public.log_strombestilling_change();

-- Legg inn en startsnapshot for eksisterende poster, slik at historikkfanen
-- ikke er tom etter migreringen.
insert into public.strombestilling_hendelser
  (strombestilling_id, action, to_status, changed_fields, actor_email, created_at)
select s.id, 'opprettet', s.status, array['importert historikk'], 'system', s.created_at
from public.strombestillinger s
where not exists (
  select 1 from public.strombestilling_hendelser h where h.strombestilling_id = s.id
);

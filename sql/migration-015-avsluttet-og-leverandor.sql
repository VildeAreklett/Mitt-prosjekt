-- Ny status «Avsluttet» (målepunkt som er terminert/opphørt hos leverandør) og
-- innkjøpsleverandør per målepunkt (Entelios er standard).
-- Kjør i Supabase SQL Editor FØR «Avslutt» og leverandørfeltet tas i bruk i appen.
-- Eksisterende rader får innkjopsleverandor = 'Entelios' og ingen sluttdato.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.strombestillinger'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
      and pg_get_constraintdef(oid) ilike '%Klar for bestilling%'
  loop
    execute format('alter table public.strombestillinger drop constraint %I', c);
  end loop;
end $$;

alter table public.strombestillinger
  add constraint strombestillinger_status_check
  check (status in ('Kladd','Innmeldt','Klar for bestilling','Sendt Entelios',
                    'Bekreftet','Satt opp i Cloud','Aktiv','På vent','Avsluttet'));

alter table public.strombestillinger
  add column if not exists avtalt_slutt date,
  add column if not exists innkjopsleverandor text not null default 'Entelios',
  add column if not exists hovedkontrakt text not null default '';

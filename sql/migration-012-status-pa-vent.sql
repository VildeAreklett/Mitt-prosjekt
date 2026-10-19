-- Ny status «På vent» (parkert: skulle likevel ikke over til oss, eller må vente).
-- Kjør i Supabase SQL Editor FØR «Sett på vent» tas i bruk i appen.
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
                    'Bekreftet','Satt opp i Cloud','Aktiv','På vent'));

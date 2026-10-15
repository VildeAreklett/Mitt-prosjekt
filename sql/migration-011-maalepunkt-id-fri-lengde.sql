-- Tillat måler-ID-er som ikke er 18 siffer (f.eks. fjernvarme, 400000000988).
-- Kjør i Supabase SQL Editor.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.strombestillinger'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%maalepunkt_id%'
  loop
    execute format('alter table public.strombestillinger drop constraint %I', c);
  end loop;
end $$;

alter table public.strombestillinger
  add constraint strombestillinger_maalepunkt_id_check
  check (maalepunkt_id ~ '^[0-9A-Za-z-]{5,30}$');

-- Lagre begge anslagene på årsforbruk (Cloud og Entelios) slik at beste kilde kan velges
-- og avvik flagges. Kjør i Supabase SQL Editor (etter migration-013).
alter table public.strombestillinger
  add column if not exists forbruk_cloud_kwh integer,
  add column if not exists forbruk_entelios_kwh integer;

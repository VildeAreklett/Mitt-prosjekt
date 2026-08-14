-- Gjør felt som ikke finnes på en strømfaktura (kun adresse/målenummer/
-- MålepunktID/netteier/forbruk) valgfrie, slik at status "Kladd" faktisk kan
-- være et ufullstendig utkast - slik navnet tilsier - i stedet for at
-- databasen krever oppstartsdato/rute/forbruk for enhver rad.
-- Kjør i Supabase SQL Editor etter migration-003.

alter table public.strombestillinger
  alter column avtalt_oppstart drop not null,
  alter column rute drop not null,
  alter column aarsforbruk_kwh drop not null;

-- Rute/kommersielt-regelen skal bare håndheves når rute faktisk er satt -
-- en Kladd uten rute ennå skal ikke tvinges til å oppgi påslag/årspris.
alter table public.strombestillinger drop constraint if exists rute_kommersielt;
alter table public.strombestillinger add constraint rute_kommersielt check (
  rute is null or
  (rute = 'B' and paslag_ore_kwh is not null) or
  (rute = 'A' and fast_aarspris is not null)
);

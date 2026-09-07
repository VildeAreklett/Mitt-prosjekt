-- Lagrer tsdb_id (datastrøm-tilkoblingen i Adaptic Cloud sin tidsseriedatabase)
-- permanent på hvert målepunkt, i stedet for kun å vise det midlertidig når
-- man trykker "Sjekk i Cloud". Trengs for å kunne ta ut historikk på
-- allerede Cloud-tilkoblede målere og sende videre til Entelios, og for å
-- kunne eksportere det til Excel sammen med resten av registeret.
-- Kjør i Supabase SQL Editor etter migration-008.

alter table public.strombestillinger
  add column if not exists tsdb_id text;

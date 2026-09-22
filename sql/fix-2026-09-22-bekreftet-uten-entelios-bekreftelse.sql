-- Retter opp de 10 radene som sto som "Bekreftet" (Registrert hos Entelios)
-- i Strømflyt, men som IKKE finnes i den ekte Entelios-eksporten
-- (målepunktsliste-22092026.xlsx) - samme mønster som Elgsetergate 16 og
-- Sandsliåsen 40: importert direkte fra masterark/avtale-PDF med en
-- status som ikke faktisk var bekreftet av Entelios.
--
-- 9 av dem (Bergens Travbane AS, Travparkvegen 70) kom fra masterark-
-- importen 2026-08-19 uten reell bekreftelse. Den siste (Bergensgruppen AS,
-- Ulvedalen 1) kom fra en signert avtale-PDF, men er heller ikke bekreftet
-- av Entelios ennå. Alle settes tilbake til "Innmeldt" (Ikke meldt inn),
-- klare til å sendes på nytt.

select id, kunde, bygg, maalepunkt_id, status
from public.strombestillinger
where maalepunkt_id in (
  '707057500028734308', '707057500028734353', '707057500028734391', '707057500028734292',
  '707057500028734278', '707057500028734315', '707057500029238430', '707057500028734285',
  '707057500028734384', '707057500029584896'
);

update public.strombestillinger
set status = 'Innmeldt'
where maalepunkt_id in (
  '707057500028734308', '707057500028734353', '707057500028734391', '707057500028734292',
  '707057500028734278', '707057500028734315', '707057500029238430', '707057500028734285',
  '707057500028734384', '707057500029584896'
)
and status = 'Bekreftet';

-- Sanity-sjekk: "Registrert hos Entelios" (kun status Bekreftet) bør nå
-- være 34 (44 - 10) - matcher da nøyaktig de 34 som faktisk ble funnet
-- igjen i Entelios-eksporten.
select count(*) as antall_bekreftet
from public.strombestillinger
where status = 'Bekreftet';

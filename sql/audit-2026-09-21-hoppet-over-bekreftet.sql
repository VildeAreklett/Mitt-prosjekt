-- Audit: rader som "Sjekk i Cloud" (knapp eller daglig cron) kan ha hoppet
-- forbi selve Entelios-innmeldingssteget for, pga. en bug rettet 2026-09-21.
--
-- Bugen: "Sjekk i Cloud" satte status til "Satt opp i Cloud"/"Aktiv" så
-- snart måleren fantes i Cloud MED data - uansett hvor langt raden faktisk
-- hadde kommet i egen innmelding. En rad som aldri var meldt inn til
-- Entelios (status Kladd/Innmeldt/Klar for bestilling/Sendt Entelios) kunne
-- dermed hoppe rett til "Satt opp i Cloud" eller "Aktiv" bare fordi måleren
-- tilfeldigvis allerede hadde Cloud-data fra en helt annen sammenheng -
-- selve poenget med plattformen (spore reell innmeldingsstatus) ble dermed
-- feil for akkurat de radene.
--
-- Denne spør kun - endrer ingenting. Kjør i Supabase SQL Editor og se over
-- radene selv: for hver av dem må du avgjøre om den FAKTISK er meldt inn
-- til Entelios (i så fall er dagens status riktig, ingenting å gjøre), eller
-- om den bare "later som" pga. bugen (i så fall bør status rettes tilbake -
-- se forslag til UPDATE nederst, kommentert ut).

select
  h.strombestilling_id,
  s.kunde,
  s.bygg,
  s.maalepunkt_id,
  h.from_status,
  h.to_status,
  s.status as status_naa,
  h.created_at as tidspunkt_for_hoppet
from public.strombestilling_hendelser h
join public.strombestillinger s on s.id = h.strombestilling_id
where h.action = 'endret'
  and h.from_status in ('Kladd', 'Innmeldt', 'Klar for bestilling', 'Sendt Entelios')
  and h.to_status in ('Satt opp i Cloud', 'Aktiv')
order by h.created_at desc;

-- Har spørringen over gitt treff, og du har bekreftet at raden IKKE faktisk
-- er meldt inn til Entelios ennå: bruk denne til å rette den konkrete raden
-- tilbake (bytt inn riktig id og ønsket status - normalt "Innmeldt", siden
-- den fremdeles må godkjennes/sendes på nytt):
--
-- update public.strombestillinger
-- set status = 'Innmeldt'
-- where id = '<id fra spørringen over>';

-- Retter opp Sandsliåsen 40 (Nesttun Invest) - hoppet feilaktig rett til
-- "Aktiv" via bug'en beskrevet i sql/audit-2026-09-21-hoppet-over-bekreftet.sql,
-- selv om den aldri har vært meldt inn til Entelios. tsdb_id/cloud_metric_id
-- beholdes (den ekte Cloud-tilkoblingen er reell informasjon - appen viser nå
-- en egen "I Cloud"-merkelapp for dette i stedet for å la den påvirke status),
-- bare selve statusen rettes tilbake.

update public.strombestillinger
set status = 'Innmeldt'
where maalepunkt_id = '707057500028356906'
  and status = 'Aktiv';

-- Kjør sql/audit-2026-09-21-hoppet-over-bekreftet.sql på nytt etterpå for å
-- se om det er FLERE rader (fra Nesttun Invest eller andre kunder) som
-- trenger samme retting - denne bugen kan ha rukket å kjøre i den daglige
-- cron-jobben en stund før den ble oppdaget.

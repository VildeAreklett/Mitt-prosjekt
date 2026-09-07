-- Retter cloud_org for Bergensgruppen-radene.
--
-- Bakgrunn: skjemaets cloud_org-felt var en LÅST nedtrekksliste (fikset i
-- samme commit som denne filen) som kun tillot noen få hardkodede verdier,
-- med "Strømkunder" som første/standard-valg. Rader som ble lagret på nytt
-- via skjemaet uten at riktig org ble eksplisitt valgt, endte da opp med
-- cloud_org = "Strømkunder" i stedet for riktig organisasjon - som gjorde at
-- "Sjekk i Cloud" lette i feil kundes målere og alltid rapporterte
-- "ikke funnet", selv for målere som faktisk er registrert.
--
-- Bergensgruppen har (sept. 2026) ingen egen "SK <navn>"-strømkunde-org i
-- Cloud ennå, så riktig verdi er kundens vanlige orgnavn "Bergensgruppen AS"
-- (bekreftet mot Cloud sin egen organisasjonsliste). Dersom Bergensgruppen
-- på et senere tidspunkt får en egen strømkunde-org ("SK Bergensgruppen" e.l.)
-- må denne verdien oppdateres tilsvarende.
update public.strombestillinger
set cloud_org = 'Bergensgruppen AS'
where kunde = 'Bergensgruppen AS' and cloud_org != 'Bergensgruppen AS';

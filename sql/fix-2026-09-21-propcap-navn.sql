-- Retter kunde/strøm-org for Propcap-rader som ikke er meldt inn ennå:
-- "Propcap" -> "Propcap AS" (selskapsnavn), og strøm-org til "Propcap AS"
-- uten "SK "-prefiks (ingen egen strømkunde-org opprettet for Propcap i
-- Cloud ennå - se merknad i registreringsskjemaet: "Er den ikke det ennå:
-- bruk kundens vanlige orgnavn").
--
-- Kjør SELECT-en først for å se nøyaktig hvilke rader som blir truffet.

select id, kunde, cloud_org, bygg, maalepunkt_id, status
from public.strombestillinger
where kunde ilike 'propcap'
  and status in ('Kladd', 'Innmeldt', 'Klar for bestilling');

update public.strombestillinger
set kunde = 'Propcap AS', cloud_org = 'Propcap AS'
where kunde ilike 'propcap'
  and status in ('Kladd', 'Innmeldt', 'Klar for bestilling');

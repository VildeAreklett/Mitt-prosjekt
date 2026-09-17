-- Lagrer selve målerens ID i Adaptic Cloud (ikke tsdb_id, som er
-- tilkoblingen til tidsseriedatabasen) - trengs for å hente faktisk,
-- ekte forbruk (ikke bare estimatet fra avtalen) via Cloud sitt eget
-- /v0/metrics/data-endepunkt, uten å måtte gjøre et helt nytt org- og
-- eno-oppslag hver gang. Fylles ut automatisk neste gang "Sjekk i Cloud"
-- kjøres på hver rad (manuelt, i bulk, eller via den nattlige jobben).
-- Kjør i Supabase SQL Editor etter migration-009.

alter table public.strombestillinger
  add column if not exists cloud_metric_id text;

-- Lagringsbøtte for strømfakturaer som lastes opp midlertidig før utlesing.
-- Filen sendes IKKE lenger direkte i API-forespørselen (Vercel avviser
-- forespørsler over ca. 4,5 MB, og skannede fakturaer med mye historikk
-- overskrider ofte det) - i stedet lastes den opp hit fra nettleseren, og
-- API-ruten laster den ned derfra og rydder opp igjen etter utlesing.
-- Kjør i Supabase SQL Editor etter migration-004.

insert into storage.buckets (id, name, public)
values ('fakturaer', 'fakturaer', false)
on conflict (id) do nothing;

drop policy if exists "stromflyt brukere kan laste opp fakturaer" on storage.objects;
create policy "stromflyt brukere kan laste opp fakturaer" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fakturaer');

drop policy if exists "stromflyt brukere kan lese egne fakturaer" on storage.objects;
create policy "stromflyt brukere kan lese egne fakturaer" on storage.objects
  for select to authenticated
  using (bucket_id = 'fakturaer');

drop policy if exists "stromflyt brukere kan slette fakturaer" on storage.objects;
create policy "stromflyt brukere kan slette fakturaer" on storage.objects
  for delete to authenticated
  using (bucket_id = 'fakturaer');

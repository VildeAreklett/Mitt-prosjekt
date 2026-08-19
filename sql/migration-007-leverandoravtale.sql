-- Legger til mulighet for å merke hvert målepunkt med om det overtas på
-- eiers/leverandørens eksisterende vilkår (eierskifte) eller flyttes over på
-- Adaptics egen spotavtale - jf. møtenotat "10 skal på spotavtale, 10 skal
-- på Reitans avtale". Ved eierskifte kan man i tillegg laste opp selve
-- leverandøravtalen (PDF) som dokumentasjon på vilkårene som videreføres.
-- Kjør i Supabase SQL Editor etter migration-006.

alter table public.strombestillinger
  add column if not exists avtaletype text check (avtaletype in ('Eierskifte', 'Spotavtale')),
  add column if not exists leverandoravtale_fil_sti text;

-- Lagringsbøtte for leverandøravtale-PDF-er. Til forskjell fra "fakturaer"-
-- bøtten er dette IKKE transient - filen skal ligge her så lenge målepunktet
-- eksisterer, som dokumentasjon på hvilke vilkår som er overtatt.
insert into storage.buckets (id, name, public)
values ('leverandoravtaler', 'leverandoravtaler', false)
on conflict (id) do nothing;

drop policy if exists "stromflyt brukere kan laste opp leverandøravtaler" on storage.objects;
create policy "stromflyt brukere kan laste opp leverandøravtaler" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'leverandoravtaler');

drop policy if exists "stromflyt brukere kan lese leverandøravtaler" on storage.objects;
create policy "stromflyt brukere kan lese leverandøravtaler" on storage.objects
  for select to authenticated
  using (bucket_id = 'leverandoravtaler');

drop policy if exists "stromflyt brukere kan slette leverandøravtaler" on storage.objects;
create policy "stromflyt brukere kan slette leverandøravtaler" on storage.objects
  for delete to authenticated
  using (bucket_id = 'leverandoravtaler');

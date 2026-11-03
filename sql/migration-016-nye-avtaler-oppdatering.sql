-- Gir innloggede Strømflyt-brukere lov til å oppdatere kortene i «Signerte avtaler»
-- (Avvis, Under arbeid, Merk klargjort, redigering av felt). Tabellen hadde bare lesetilgang,
-- så oppdateringene ble stille avvist av RLS: ingen feilmelding, men heller ingen endring.
-- Kjør i Supabase SQL-editor (Strømflyt sitt prosjekt).
alter table public.stromavtaler_inn enable row level security;

drop policy if exists "stromflyt oppdater stromavtaler_inn" on public.stromavtaler_inn;
create policy "stromflyt oppdater stromavtaler_inn" on public.stromavtaler_inn
  for update to authenticated
  using (public.stromflyt_has_access())
  with check (public.stromflyt_has_access());

-- Kontroll: skal vise policyen
select policyname, cmd from pg_policies where tablename = 'stromavtaler_inn';

-- Kontaktperson hos kunden (navn + e-post), gjelder hele kunden - samme
-- prinsipp som "selger". Skal med i selve innmeldingen til Entelios, slik at
-- driftsmeldinger (elkontroll, feil på måler osv.) kan gå direkte til noen
-- som faktisk er på anlegget, i stedet for kun til Adaptics sentrale e-post
-- (Adaptic er juridisk eier/fakturamottaker, ikke den fysisk til stede).
-- Jf. Slack/Teams-dialog med Eirik Torsvik om Frydenbø, 2026-09.
-- Kjør i Supabase SQL Editor etter migration-007.

alter table public.strombestillinger
  add column if not exists kontaktperson_navn text not null default '',
  add column if not exists kontaktperson_epost text not null default '';

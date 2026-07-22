-- Strømflyt: register over strømbestillinger (målepunkt).
-- Kjør i Supabase SQL Editor. Speiler konfigurasjon/datamodell.md og statuslinje.md.

create table if not exists public.strombestillinger (
  id                uuid primary key default gen_random_uuid(),

  -- kunde
  kunde             text not null,
  org_nr            text not null check (org_nr ~ '^[0-9]{9}$'),
  selger            text not null default '',
  cloud_org         text not null,

  -- anlegg
  bygg              text not null,
  adresse           text not null,
  maalenummer       text not null,
  maalepunkt_id     text not null check (maalepunkt_id ~ '^[0-9]{18}$'),
  netteier          text not null,
  prisomrade        text not null check (prisomrade in ('NO1','NO2','NO3','NO4','NO5')),
  aarsforbruk_kwh   integer not null check (aarsforbruk_kwh >= 0),
  avtalt_oppstart   date not null,
  at_kode           text not null,

  -- rute og kommersielt
  rute              text not null check (rute in ('A','B')),
  paslag_ore_kwh    numeric,
  fast_pr_maaler    numeric,
  fast_aarspris     numeric,

  -- avtale og status
  signert           boolean not null default false,
  kommentar         text not null default '',
  status            text not null default 'Innmeldt'
                      check (status in ('Kladd','Innmeldt','Klar for bestilling',
                                        'Sendt Entelios','Bekreftet','Satt opp i Cloud','Aktiv')),
  entelios_ref      text not null default '',

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- rute B krever påslag, rute A krever fast årspris
  constraint rute_kommersielt check (
    (rute = 'B' and paslag_ore_kwh is not null) or
    (rute = 'A' and fast_aarspris is not null)
  )
);

-- ett målepunkt kan bare ligge inne én gang (fanger dubletter, jf. kvalitetssikring)
create unique index if not exists strombestillinger_maalepunkt_uniq
  on public.strombestillinger (maalepunkt_id);

create index if not exists strombestillinger_status_idx on public.strombestillinger (status);
create index if not exists strombestillinger_rute_idx   on public.strombestillinger (rute);

-- hold updated_at fersk
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_strombestillinger_updated on public.strombestillinger;
create trigger trg_strombestillinger_updated
  before update on public.strombestillinger
  for each row execute function public.set_updated_at();

-- Row Level Security: kun innloggede brukere.
alter table public.strombestillinger enable row level security;

drop policy if exists "authenticated full access" on public.strombestillinger;
create policy "authenticated full access" on public.strombestillinger
  for all to authenticated using (true) with check (true);

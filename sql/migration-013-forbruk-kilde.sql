-- Hvor kommer årsforbruket fra, og hvor mange måneders måling bygger det på?
-- Kjør i Supabase SQL Editor. Appen virker også uten denne (den hopper da over
-- merkingen), men da vises ikke «N mnd»-merket og forbruket oppdateres ikke automatisk.
alter table public.strombestillinger
  add column if not exists forbruk_kilde text,
  add column if not exists forbruk_maaneder smallint,
  add column if not exists forbruk_fra text,
  add column if not exists forbruk_til text,
  add column if not exists forbruk_oppdatert timestamptz;

comment on column public.strombestillinger.forbruk_kilde is 'cloud = hentet/beregnet fra Adaptic Cloud (oppdateres automatisk); tom = innlagt for hånd/fra avtale';
comment on column public.strombestillinger.forbruk_maaneder is 'Antall hele måneder med målinger forbruket bygger på (12 = målt helår, under 12 = sesongjustert prognose)';

-- Fikser "Kunne ikke slette: insert or update on table
-- strombestilling_hendelser violates foreign key constraint".
--
-- Rotårsak: trg_log_strombestilling_change (fra migration-002) kjørte
-- AFTER DELETE og forsøkte da å logge slettingen med
-- strombestilling_id = old.id - men raden er allerede borte fra
-- strombestillinger på det tidspunktet en AFTER-trigger fyres, så
-- fremmednøkkelen mot den (nå slettede) raden feiler alltid.
-- INSERT/UPDATE fungerer fint AFTER (raden finnes jo), det er kun DELETE
-- som må logges FØR selve slettingen skjer.
-- Kjør i Supabase SQL Editor etter migration-005.

drop trigger if exists trg_log_strombestilling_change on public.strombestillinger;

create trigger trg_log_strombestilling_change
  after insert or update on public.strombestillinger
  for each row execute function public.log_strombestilling_change();

create trigger trg_log_strombestilling_delete
  before delete on public.strombestillinger
  for each row execute function public.log_strombestilling_change();

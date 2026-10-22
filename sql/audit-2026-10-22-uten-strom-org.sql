-- Rader som aldri kan slås opp i Cloud (og dermed aldri får årsforbruk/tsdb_id) fordi strøm-org mangler.
select status, kunde, bygg, maalepunkt_id, cloud_org, aarsforbruk_kwh, tsdb_id
from public.strombestillinger
where (cloud_org is null or btrim(cloud_org) = '')
  and status <> 'På vent'
order by status, kunde, bygg;

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { slaOppMalepunktICloud } from "../../../../lib/cloud-lookup";
import { STAGES, type Status } from "../../../../lib/stromflyt-config";

// Daglig automatisk Cloud-sjekk (Vercel Cron, se vercel.json) - gjør akkurat
// det samme som "Sjekk i Cloud"-knappen i grensesnittet, bare for alle
// aktuelle rader samtidig og uten at noen trenger å trykke noe. Kjører som
// en bakgrunnsjobb uten innlogget bruker, og bruker derfor service-rolle-
// nøkkelen (bypasser RLS) i stedet for requireStromflytAccess - se
// api-ruter-utenfor-rls-mønsteret i fakturakontroll-appen for samme prinsipp.
//
// Sikret med CRON_SECRET: Vercel Cron sender automatisk
// "Authorization: Bearer <CRON_SECRET>" når miljøvariabelen er satt, så
// dette stopper uautoriserte kall utenfra uten at vi trenger noen
// brukerinnlogging her.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TABLE = "strombestillinger";

// Sjekker ikke uendelig mange rader i én kjøring - hver rad kan kreve 2-3
// kall mot Adaptic Cloud, og en for stor batch risikerer å treffe Vercel sin
// tidsgrense. Resten tas neste dag. Loggfører tydelig hvor mange som ble
// hoppet over, i stedet for å late som alt ble sjekket.
const MAKS_RADER_PER_KJORING = 60;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") || "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Uautorisert" }, { status: 401 });
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_STROMFLYT_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.STROMFLYT_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ ok: false, error: "Mangler Supabase service-rolle-oppsett" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Kun rader som faktisk kan sjekkes (MålepunktID og cloud_org satt) og som
  // ikke allerede er "Aktiv" - ingenting mer å oppdage der.
  const { data: rows, error: fetchError } = await supabase
    .from(TABLE)
    .select("id, bygg, maalepunkt_id, cloud_org, status, tsdb_id")
    .neq("status", "Aktiv")
    .not("maalepunkt_id", "is", null)
    .not("cloud_org", "is", null)
    .neq("cloud_org", "")
    .order("updated_at", { ascending: true }); // eldst sjekket først

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const alle = rows ?? [];
  const utvalg = alle.slice(0, MAKS_RADER_PER_KJORING);
  const droppet = alle.length - utvalg.length;

  let funnet = 0, oppdatertStatus = 0, oppdatertTsdbId = 0, ikkeFunnet = 0, feilet = 0;
  const feilmeldinger: string[] = [];

  for (const rad of utvalg) {
    const result = await slaOppMalepunktICloud(rad.maalepunkt_id as string, (rad.cloud_org as string) || "");
    if (!result.ok) {
      feilet += 1;
      feilmeldinger.push(`${rad.bygg}: ${result.error}`);
      continue;
    }
    if (!result.funnet) {
      ikkeFunnet += 1;
      continue;
    }
    funnet += 1;

    const patch: Record<string, unknown> = {};
    const naavarendeStatus = rad.status as Status;
    if (STAGES.indexOf(result.foreslatt_status) > STAGES.indexOf(naavarendeStatus)) {
      patch.status = result.foreslatt_status;
      oppdatertStatus += 1;
    }
    if (result.tsdb_id && result.tsdb_id !== rad.tsdb_id) {
      patch.tsdb_id = result.tsdb_id;
      oppdatertTsdbId += 1;
    }
    if (Object.keys(patch).length > 0) {
      const { error: updateError } = await supabase.from(TABLE).update(patch).eq("id", rad.id);
      if (updateError) {
        feilet += 1;
        feilmeldinger.push(`${rad.bygg}: lagring feilet - ${updateError.message}`);
      }
    }
  }

  const sammendrag = {
    ok: true,
    sjekket: utvalg.length,
    droppet_denne_runden: droppet,
    funnet,
    ikke_funnet: ikkeFunnet,
    feilet,
    oppdatert_status: oppdatertStatus,
    oppdatert_tsdb_id: oppdatertTsdbId,
    feilmeldinger: feilmeldinger.slice(0, 10),
  };
  // Logges i Vercel sine funksjonslogger, siden ingen ser dette i grensesnittet direkte.
  console.log("[cron/sjekk-cloud]", JSON.stringify(sammendrag));
  return NextResponse.json(sammendrag);
}

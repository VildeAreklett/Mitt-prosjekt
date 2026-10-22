import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { slaOppMalepunktICloud, hentTokenForOrg, hentEstimertAarsforbruk } from "../../../../lib/cloud-lookup";
import { velgForbruk } from "../../../../lib/forbruk-prognose";
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

  // Alle rader med MålepunktID (mangler strøm-org, søkes riktig org opp
  // automatisk - se finnOrgMedMalepunkt i lib/cloud-lookup.ts). Rader
  // som allerede er "Aktiv" tas bare med når årsforbruk mangler - da skal det
  // hentes fra Cloud (ingenting annet å oppdage for dem).
  // Forbruk fra Cloud oppdateres på nytt hver 7. dag (flere måneder med data
  // gir bedre prognose). Kolonnene forbruk_* finnes først etter migration-013 -
  // faller tilbake til enklere spørring hvis de mangler.
  const syvDagerSiden = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let rows: Record<string, unknown>[] | null = null;
  let harForbrukKolonner = true;
  {
    const r1 = await supabase
      .from(TABLE)
      .select("id, kunde, bygg, maalepunkt_id, cloud_org, status, tsdb_id, aarsforbruk_kwh, forbruk_kilde, forbruk_oppdatert, forbruk_entelios_kwh")
      .or(`status.neq.Aktiv,aarsforbruk_kwh.is.null,and(forbruk_kilde.in.(cloud,entelios),forbruk_oppdatert.lt.${syvDagerSiden}),and(forbruk_kilde.in.(cloud,entelios),forbruk_oppdatert.is.null)`)
      .neq("status", "På vent")
      .not("maalepunkt_id", "is", null)
      .order("updated_at", { ascending: true }); // eldst sjekket først
    if (r1.error && /forbruk_/.test(r1.error.message)) {
      harForbrukKolonner = false;
      const r2 = await supabase
        .from(TABLE)
        .select("id, kunde, bygg, maalepunkt_id, cloud_org, status, tsdb_id, aarsforbruk_kwh")
        .or("status.neq.Aktiv,aarsforbruk_kwh.is.null")
        .neq("status", "På vent")
        .not("maalepunkt_id", "is", null)
        .order("updated_at", { ascending: true });
      if (r2.error) return NextResponse.json({ ok: false, error: r2.error.message }, { status: 500 });
      rows = r2.data as Record<string, unknown>[];
    } else if (r1.error) {
      return NextResponse.json({ ok: false, error: r1.error.message }, { status: 500 });
    } else {
      rows = r1.data as Record<string, unknown>[];
    }
  }

  const alle = rows ?? [];
  const utvalg = alle.slice(0, MAKS_RADER_PER_KJORING);
  const droppet = alle.length - utvalg.length;

  let funnet = 0, oppdatertStatus = 0, oppdatertTsdbId = 0, oppdatertForbruk = 0, ikkeFunnet = 0, feilet = 0;
  const tokenPerOrg = new Map<string, string | null>();
  const feilmeldinger: string[] = [];

  for (const rad of utvalg) {
    const result = await slaOppMalepunktICloud(rad.maalepunkt_id as string, (rad.cloud_org as string) || "", (rad.bygg as string) || "", (rad.kunde as string) || "");
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
    // Skal ALDRI hoppe forbi selve innmeldingssteget: en rad som ikke
    // engang er meldt inn til Entelios ennå (status < Bekreftet) skal
    // forbli der uansett hva Cloud sier - at måleren tilfeldigvis allerede
    // har data der (fra en helt annen sammenheng) er ingen bekreftelse på
    // at DENNE avtalen faktisk er registrert. Se sikkerIdentitet-merknaden i
    // lib/cloud-lookup.ts og sql/audit-2026-09-21-hoppet-over-bekreftet.sql
    // for rader som ble feilaktig hoppet forbi før denne rettelsen.
    const alleredeMeldtInn = STAGES.indexOf(naavarendeStatus) >= STAGES.indexOf("Bekreftet");
    if (alleredeMeldtInn && result.foreslatt_status && STAGES.indexOf(result.foreslatt_status) > STAGES.indexOf(naavarendeStatus)) {
      patch.status = result.foreslatt_status;
      oppdatertStatus += 1;
    }
    // Treffet kom via bygningsnavn, ikke en eksakt MålepunktID-match - vi vet
    // det ER riktig bygg, men ikke sikkert at det er akkurat DENNE måleren.
    // Ikke bind tsdb_id fra et usikkert treff (se sikkerIdentitet i
    // lib/cloud-lookup.ts).
    if (result.sikkerIdentitet && result.tsdb_id && result.tsdb_id !== rad.tsdb_id) {
      patch.tsdb_id = result.tsdb_id;
      oppdatertTsdbId += 1;
    }
    // Hent estimert årsforbruk fra faktiske måledata når raden mangler det
    // (gjelder også "Satt opp i Cloud"/"Aktiv", som ellers aldri fikk
    // forbruk fylt inn). Kun ved sikker identitet - et bygningsnavn-treff
    // kan gi forbruket til en annen måler i samme bygg.
    // Fant måleren i en annen (eller ingen) organisasjon enn raden peker på:
    // lagre riktig strøm-org (kun ved eksakt MålepunktID-treff).
    if (result.sikkerIdentitet && result.cloud_org_funnet && result.cloud_org_funnet !== ((rad.cloud_org as string) || "").trim()) {
      patch.cloud_org = result.cloud_org_funnet;
    }
    // Fylles inn når tomt, og oppdateres når tallet tidligere kom fra Cloud.
    // Tall lagt inn for hånd (forbruk_kilde tom) overskrives aldri.
    // Cloud-tallet lagres alltid som alternativ (kontroll); det som vises som
    // årsforbruk byttes bare når raden ikke er satt for hånd.
    const kanOppdatereForbruk = rad.aarsforbruk_kwh == null || (harForbrukKolonner && (rad.forbruk_kilde === "cloud" || rad.forbruk_kilde === "entelios"));
    const trengerForbruk = kanOppdatereForbruk || (harForbrukKolonner && rad.forbruk_kilde == null);
    if (trengerForbruk && result.sikkerIdentitet) {
      // Samme tilgang som fant måleren først, deretter org-token som reserve.
      const tokens: string[] = [];
      if (result.token_brukt) tokens.push(result.token_brukt);
      const org = (result.cloud_org_funnet || (rad.cloud_org as string) || "").trim();
      if (org) {
        if (!tokenPerOrg.has(org)) {
          const t = await hentTokenForOrg(org);
          tokenPerOrg.set(org, t.ok ? t.token : null);
        }
        const t2 = tokenPerOrg.get(org);
        if (t2 && !tokens.includes(t2)) tokens.push(t2);
      }
      for (const token of tokens) {
        try {
          const f = await hentEstimertAarsforbruk(token, result.cloud_metric_id);
          if (f.ok) {
            if (harForbrukKolonner) {
              patch.forbruk_cloud_kwh = Math.round(f.kwh);
              patch.forbruk_maaneder = f.prognose.maaneder;
              patch.forbruk_fra = f.prognose.fra;
              patch.forbruk_til = f.prognose.til;
              patch.forbruk_oppdatert = new Date().toISOString();
            }
            if (kanOppdatereForbruk) {
              const valg = velgForbruk({
                cloud_kwh: f.kwh,
                cloud_maaneder: f.prognose.maaneder,
                entelios_kwh: harForbrukKolonner ? (rad.forbruk_entelios_kwh as number | null | undefined) : null,
              });
              patch.aarsforbruk_kwh = Math.round(valg.kwh ?? f.kwh);
              if (harForbrukKolonner) patch.forbruk_kilde = valg.kilde ?? "cloud";
            }
            oppdatertForbruk += 1;
            break;
          }
        } catch {
          // Forbruk er en bonus - ikke la det velte resten av kjøringen.
        }
      }
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
    oppdatert_aarsforbruk: oppdatertForbruk,
    feilmeldinger: feilmeldinger.slice(0, 10),
  };
  // Logges i Vercel sine funksjonslogger, siden ingen ser dette i grensesnittet direkte.
  console.log("[cron/sjekk-cloud]", JSON.stringify(sammendrag));
  return NextResponse.json(sammendrag);
}

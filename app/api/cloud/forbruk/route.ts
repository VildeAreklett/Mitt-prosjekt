import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { hentTokenForOrg, hentMaanedsforbruk } from "../../../../lib/cloud-lookup";
import { STAGES } from "../../../../lib/stromflyt-config";

// Faktisk, ekte forbruk (ikke estimatet fra avtalen) for "Registrert volum"
// i Oversikt - se "Faktisk forbruk"-valget i vekselknappen der. Henter kun
// for rader som er sendt til Entelios eller lenger OG allerede har en
// cloud_metric_id (satt av "Sjekk i Cloud") - samme utvalg som det
// estimerte tallet bruker, slik at de to visningene faktisk kan
// sammenlignes mot hverandre.
//
// Grupperer på cloud_org fordi hvert organisasjonsbundet token bare gir
// tilgang til den ene organisasjonens målere - ett Cloud-kall per kunde,
// ikke ett per målepunkt.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await requireStromflytAccess(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const year = Number(url.searchParams.get("year"));
  if (!year || year < 2000 || year > 2100) {
    return NextResponse.json({ ok: false, error: "Ugyldig år" }, { status: 400 });
  }

  const { data: rows, error } = await auth.supabase
    .from("strombestillinger")
    .select("id, cloud_org, cloud_metric_id, status")
    .not("cloud_metric_id", "is", null);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const aktuelle = (rows ?? []).filter(
    (r) => STAGES.indexOf(r.status as (typeof STAGES)[number]) >= STAGES.indexOf("Sendt Entelios"),
  );
  if (!aktuelle.length) {
    return NextResponse.json({ ok: true, perMonthGwh: Array(12).fill(0), antallMalere: 0, feilmeldinger: [] });
  }

  const perOrg = new Map<string, string[]>();
  for (const r of aktuelle) {
    const org = (r.cloud_org as string) || "";
    if (!org || !r.cloud_metric_id) continue;
    perOrg.set(org, [...(perOrg.get(org) ?? []), r.cloud_metric_id as string]);
  }

  const perMonthKwh = Array(12).fill(0);
  const feilmeldinger: string[] = [];
  let antallMalere = 0;

  for (const [org, metricIds] of perOrg) {
    const tokenRes = await hentTokenForOrg(org);
    if (!tokenRes.ok) {
      feilmeldinger.push(`${org}: ${tokenRes.error}`);
      continue;
    }
    const forbrukRes = await hentMaanedsforbruk(tokenRes.token, metricIds, year);
    if (!forbrukRes.ok) {
      feilmeldinger.push(`${org}: ${forbrukRes.error}`);
      continue;
    }
    forbrukRes.perMonthKwh.forEach((v, i) => { perMonthKwh[i] += v; });
    antallMalere += metricIds.length;
  }

  return NextResponse.json({
    ok: true,
    perMonthGwh: perMonthKwh.map((kwh) => kwh / 1_000_000),
    antallMalere,
    feilmeldinger,
  });
}

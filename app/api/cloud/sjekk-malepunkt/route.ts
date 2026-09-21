import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { slaOppMalepunktICloud, hentTokenForOrg, hentEstimertAarsforbruk } from "../../../../lib/cloud-lookup";

// Interaktiv "Sjekk i Cloud"-knapp for én rad. Selve oppslagslogikken ligger
// i lib/cloud-lookup.ts, delt med den daglige automatiske jobben
// (app/api/cron/sjekk-cloud) - se den filen for detaljer om hvorfor
// oppslaget prøver flere metoder i rekkefølge.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await requireStromflytAccess(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const malepunktId = url.searchParams.get("malepunkt_id") || "";
  const cloudOrgName = url.searchParams.get("cloud_org") || "";
  const bygg = url.searchParams.get("bygg") || "";
  if (malepunktId.replace(/\D/g, "").length !== 18) {
    return NextResponse.json({ ok: false, error: "malepunkt_id må være 18 siffer" }, { status: 400 });
  }

  const result = await slaOppMalepunktICloud(malepunktId, cloudOrgName, bygg);
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }

  // Best-effort: prøv å hente et estimert årsforbruk fra faktiske måledata
  // når måleren først er funnet - feiler dette (f.eks. ingen data ennå),
  // skal ikke selve Cloud-oppslaget rammes. Se hentEstimertAarsforbruk.
  let estimert_aarsforbruk_kwh: number | null = null;
  if (result.funnet) {
    try {
      const tokenRes = await hentTokenForOrg(cloudOrgName);
      if (tokenRes.ok) {
        const forbrukRes = await hentEstimertAarsforbruk(tokenRes.token, result.cloud_metric_id);
        if (forbrukRes.ok && forbrukRes.kwh > 0) estimert_aarsforbruk_kwh = forbrukRes.kwh;
      }
    } catch {
      // Ignorer - årsforbruk er en bonus her, ikke en forutsetning.
    }
  }

  // Treffet kom via bygningsnavn, ikke en eksakt MålepunktID-match - vi vet
  // det ER riktig BYGG, men IKKE sikkert at det er akkurat DENNE måleren.
  // Da skal kun forbruksestimatet brukes (det stemmer uansett for hele
  // bygget via hovedmåleren) - IKKE binde tsdb_id/målenummer/status til
  // raden, det kunne koblet feil måleridentitet til feil MålepunktID.
  if (result.funnet && !result.sikkerIdentitet) {
    return NextResponse.json({
      ok: true,
      funnet: true,
      bygg: result.bygg,
      adresse: result.adresse,
      malenummer: null,
      tsdb_id: null,
      cloud_metric_id: null,
      hovedmaaler: result.hovedmaaler,
      foreslatt_status: null,
      metode: result.metode,
      estimert_aarsforbruk_kwh,
    });
  }

  return NextResponse.json({ ...result, estimert_aarsforbruk_kwh });
}

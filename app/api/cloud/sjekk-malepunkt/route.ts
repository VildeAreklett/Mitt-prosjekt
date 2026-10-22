import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { slaOppMalepunktICloud, hentTokenForOrg, hentEstimertAarsforbruk } from "../../../../lib/cloud-lookup";
import type { Prognose } from "../../../../lib/forbruk-prognose";

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
  const kunde = url.searchParams.get("kunde") || "";
  if (malepunktId.replace(/\D/g, "").length !== 18) {
    return NextResponse.json({ ok: false, error: "malepunkt_id må være 18 siffer" }, { status: 400 });
  }

  const result = await slaOppMalepunktICloud(malepunktId, cloudOrgName, bygg, kunde);
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }

  // Best-effort: prøv å hente et estimert årsforbruk fra faktiske måledata
  // når måleren først er funnet - feiler dette (f.eks. ingen data ennå),
  // skal ikke selve Cloud-oppslaget rammes. Se hentEstimertAarsforbruk.
  let estimert_aarsforbruk_kwh: number | null = null;
  let forbruk_feil: string | null = null;
  let forbruk_prognose: Prognose | null = null;
  if (result.funnet) {
    try {
      // Bruk SAMME tilgang som fant måleren (den kan ligge i en annen org enn
      // raden peker på), og prøv ellers org-navnet.
      const tokens: string[] = [];
      if (result.token_brukt) tokens.push(result.token_brukt);
      const orgForToken = result.cloud_org_funnet || cloudOrgName;
      if (orgForToken) {
        const tokenRes = await hentTokenForOrg(orgForToken);
        if (tokenRes.ok && !tokens.includes(tokenRes.token)) tokens.push(tokenRes.token);
      }
      if (!tokens.length) forbruk_feil = "fant ikke noe token som gir tilgang til måledata";
      for (const token of tokens) {
        const forbrukRes = await hentEstimertAarsforbruk(token, result.cloud_metric_id);
        if (forbrukRes.ok) { estimert_aarsforbruk_kwh = forbrukRes.kwh; forbruk_prognose = forbrukRes.prognose; forbruk_feil = null; break; }
        forbruk_feil = forbrukRes.error;
      }
    } catch (e) {
      forbruk_feil = e instanceof Error ? e.message : "ukjent feil";
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
      forbruk_prognose,
      forbruk_feil,
      cloud_org_funnet: null,
    });
  }

  // token_brukt skal ALDRI til nettleseren.
  const offentlig: Record<string, unknown> = { ...result };
  delete offentlig.token_brukt;
  return NextResponse.json({ ...offentlig, estimert_aarsforbruk_kwh, forbruk_prognose, forbruk_feil });
}

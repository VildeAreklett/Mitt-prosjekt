import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { slaOppMalepunktICloud } from "../../../../lib/cloud-lookup";

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
  if (malepunktId.replace(/\D/g, "").length !== 18) {
    return NextResponse.json({ ok: false, error: "malepunkt_id må være 18 siffer" }, { status: 400 });
  }

  const result = await slaOppMalepunktICloud(malepunktId, cloudOrgName);
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}

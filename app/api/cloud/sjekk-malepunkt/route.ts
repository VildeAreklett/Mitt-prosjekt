import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";

// Slår opp om et gitt MålepunktID (EAN) allerede finnes som en måler i
// Adaptic Cloud, via det ekte Adaptic Cloud API-et (ikke MCP - dette kjører
// i selve appen). Kun lesing, ingen skriving.
//
// Adaptic Cloud sitt /v0/metrics-endepunkt returnerer alle målere for
// organisasjonen API-nøkkelen er knyttet til (pluss eventuelle underorg.),
// uten mulighet til å søke direkte på MålepunktID server-side - så vi henter
// hele listen og filtrerer selv her. Se apiserver (Adaptic Cloud) sin
// MetricController.findMetrics og AuthenticationSchemeConverter for hvordan
// X-Api-Key-autentisering og modellen for svaret er bygget opp.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CLOUD_API_BASE = process.env.ADAPTIC_CLOUD_API_BASE_URL || "https://api.adaptic.no";

interface CloudMeter {
  serial?: string;
  tsdbId?: string;
}

interface CloudMetric {
  id: string;
  eno?: string;
  label?: string;
  mainImported?: boolean;
  currentMeter?: CloudMeter;
  building?: { id: string; name: string; address?: string };
}

export async function GET(req: Request) {
  const auth = await requireStromflytAccess(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const apiKey = process.env.ADAPTIC_CLOUD_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Mangler ADAPTIC_CLOUD_API_KEY. Sett den i Vercel (og .env.local lokalt)." },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const malepunktId = (url.searchParams.get("malepunkt_id") || "").replace(/\D/g, "");
  if (malepunktId.length !== 18) {
    return NextResponse.json({ ok: false, error: "malepunkt_id må være 18 siffer" }, { status: 400 });
  }

  try {
    const res = await fetch(`${CLOUD_API_BASE}/v0/metrics`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      // Ingen cache - status i Cloud kan endre seg når som helst.
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Adaptic Cloud API svarte ${res.status}: ${body.slice(0, 300)}`);
    }
    const metrics = (await res.json()) as CloudMetric[];
    const treff = metrics.find((m) => (m.eno || "").replace(/\D/g, "") === malepunktId);

    if (!treff) {
      return NextResponse.json({ ok: true, funnet: false });
    }
    return NextResponse.json({
      ok: true,
      funnet: true,
      bygg: treff.building?.name ?? null,
      adresse: treff.building?.address ?? null,
      malenummer: treff.currentMeter?.serial ?? null,
      tsdb_id: treff.currentMeter?.tsdbId ?? null,
      hovedmaaler: !!treff.mainImported,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Kunne ikke slå opp i Adaptic Cloud: " + msg }, { status: 502 });
  }
}

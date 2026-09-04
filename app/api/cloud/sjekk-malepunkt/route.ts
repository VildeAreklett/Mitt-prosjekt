import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";

// Slår opp om et gitt MålepunktID (EAN) allerede finnes som en måler i
// Adaptic Cloud, via det ekte Adaptic Cloud API-et (ikke MCP - dette kjører
// i selve appen). Kun lesing, ingen skriving.
//
// To autentiseringsmåter støttes (Håkon Wardeberg, sept. 2026):
// 1) ADAPTIC_CLOUD_ADMIN_TOKEN (foretrukket) - et internt admin-token som
//    kan "minte" et kortlevd, organisasjonsbundet token via
//    POST /v0/internal/organizations/{orgId}/internal_token. Vi henter
//    organisasjonslisten (GET /v0/internal/organizations), matcher på
//    cloud_org-navnet fra Strømflyt-raden, minter et ferskt token for akkurat
//    den organisasjonen, og bruker det til å slå opp målere. Litt mer arbeid
//    per kall, men fungerer på tvers av alle kunde-organisasjoner uten at én
//    enkelt nøkkel må ha bred tilgang.
// 2) ADAPTIC_CLOUD_API_KEY (fallback) - en enkel, statisk X-Api-Key. Enklere,
//    men forutsetter at nøkkelen selv har lesetilgang til riktig organisasjon.
//
// Se apiserver (Adaptic Cloud) sin InternalOrganizationsController og
// MetricController for hvordan dette er bygget opp der.

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

interface CloudOrg {
  id: string;
  name: string;
}

async function mintOrgToken(adminToken: string, organizationId: string): Promise<string> {
  const res = await fetch(`${CLOUD_API_BASE}/v0/internal/organizations/${organizationId}/internal_token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writeAccess: false }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kunne ikke lage midlertidig token for organisasjonen (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

// Normaliserer et organisasjonsnavn for sammenligning: små bokstaver, fjerner
// vanlige selskapsformer (AS/ASA/DA/ANS) og skilletegn, samler mellomrom.
// cloud_org-feltet i Strømflyt fylles inn for hånd og stemmer ikke alltid
// tegn-for-tegn med det offisielle navnet i Cloud (f.eks. "FAV Eiendomsutvikling"
// vs. "FAV Eiendomsutvikling AS") - uten dette ville en helt reell organisasjon
// stadig blitt rapportert som "ikke funnet".
function normalizeOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(as|asa|da|ans)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface OrgMatchResult {
  organizationId: string | null;
  merknad?: string;
}

async function findOrganizationId(adminToken: string, cloudOrgName: string): Promise<OrgMatchResult> {
  const res = await fetch(`${CLOUD_API_BASE}/v0/internal/organizations`, {
    headers: { Authorization: `Bearer ${adminToken}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kunne ikke hente organisasjonsliste (${res.status}): ${body.slice(0, 300)}`);
  }
  const orgs = (await res.json()) as CloudOrg[];
  const needle = normalizeOrgName(cloudOrgName);

  const exact = orgs.find((o) => normalizeOrgName(o.name) === needle);
  if (exact) return { organizationId: exact.id };

  const fuzzy = orgs.filter((o) => {
    const n = normalizeOrgName(o.name);
    return n.includes(needle) || needle.includes(n);
  });
  if (fuzzy.length === 1) return { organizationId: fuzzy[0].id };
  if (fuzzy.length > 1) {
    return {
      organizationId: null,
      merknad: `Fant ${fuzzy.length} organisasjoner i Cloud som kan matche «${cloudOrgName}» (${fuzzy.map((o) => o.name).join(", ")}) - for usikkert til å velge automatisk. Presiser cloud_org-feltet.`,
    };
  }
  return { organizationId: null };
}

export async function GET(req: Request) {
  const auth = await requireStromflytAccess(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const malepunktId = (url.searchParams.get("malepunkt_id") || "").replace(/\D/g, "");
  const cloudOrgName = url.searchParams.get("cloud_org") || "";
  if (malepunktId.length !== 18) {
    return NextResponse.json({ ok: false, error: "malepunkt_id må være 18 siffer" }, { status: 400 });
  }

  const adminToken = process.env.ADAPTIC_CLOUD_ADMIN_TOKEN;
  const apiKey = process.env.ADAPTIC_CLOUD_API_KEY;

  try {
    let metricsHeaders: HeadersInit;

    if (adminToken) {
      if (!cloudOrgName) {
        return NextResponse.json(
          { ok: false, error: "Mangler cloud_org - kan ikke slå opp riktig organisasjon i Cloud." },
          { status: 400 },
        );
      }
      const match = await findOrganizationId(adminToken, cloudOrgName);
      if (!match.organizationId) {
        return NextResponse.json({
          ok: true,
          funnet: false,
          merknad: match.merknad ??
            `Fant ingen organisasjon i Cloud som ligner på «${cloudOrgName}» - sjekk at cloud_org-feltet er riktig.`,
        });
      }
      const orgToken = await mintOrgToken(adminToken, match.organizationId);
      metricsHeaders = { Authorization: `Bearer ${orgToken}`, Accept: "application/json" };
    } else if (apiKey) {
      metricsHeaders = { "X-Api-Key": apiKey, Accept: "application/json" };
    } else {
      return NextResponse.json(
        {
          ok: false,
          error: "Mangler ADAPTIC_CLOUD_ADMIN_TOKEN eller ADAPTIC_CLOUD_API_KEY. Sett én av dem i Vercel.",
        },
        { status: 500 },
      );
    }

    const res = await fetch(`${CLOUD_API_BASE}/v0/metrics`, { headers: metricsHeaders, cache: "no-store" });
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

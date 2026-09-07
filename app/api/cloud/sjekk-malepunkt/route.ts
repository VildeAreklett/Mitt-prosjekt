import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";

// Slår opp om et gitt MålepunktID (EAN) allerede finnes som en måler i
// Adaptic Cloud, via det ekte Adaptic Cloud API-et (ikke MCP - dette kjører
// i selve appen). Kun lesing, ingen skriving.
//
// Uklart fra dialogen med Håkon Wardeberg (sept. 2026) om tokenet han delte
// er selve admin-tokenet (som koden vår skal bruke til å "minte" et nytt,
// kortlevd organisasjonsbundet token via internal_token-endepunktet), eller
// om det allerede ER det ferdig minted tokenet (som skal brukes direkte mot
// /v0/metrics uten noe mellomsteg). Prøver derfor BEGGE tolkninger i
// rekkefølge og rapporterer tydelig hvilken (om noen) som faktisk fungerte,
// i stedet for å gjette oss fast på én.
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

// Normaliserer et organisasjonsnavn for sammenligning: små bokstaver, fjerner
// vanlige selskapsformer (AS/ASA/DA/ANS) og skilletegn, samler mellomrom.
function normalizeOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(as|asa|da|ans)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url: string, token: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

// Tolkning 2: tokenet er allerede det ferdig utledede, brukbare tokenet -
// bruk det rett og slett direkte mot /v0/metrics.
async function tryDirectToken(token: string): Promise<CloudMetric[] | null> {
  const r = await fetchJson(`${CLOUD_API_BASE}/v0/metrics`, token);
  if (r.ok && Array.isArray(r.body)) return r.body as CloudMetric[];
  return null;
}

// Tolkning 1: tokenet er et admin-token som må brukes til å "minte" et nytt,
// kortlevd, organisasjonsbundet token (POST .../internal_token) før det kan
// brukes mot /v0/metrics.
async function tryMintedToken(adminToken: string, cloudOrgName: string): Promise<CloudMetric[] | null> {
  const orgsRes = await fetchJson(`${CLOUD_API_BASE}/v0/internal/organizations`, adminToken);
  if (!orgsRes.ok || !Array.isArray(orgsRes.body)) return null;
  const orgs = orgsRes.body as CloudOrg[];

  const needle = normalizeOrgName(cloudOrgName);
  const exact = orgs.find((o) => normalizeOrgName(o.name) === needle);
  const fuzzy = exact ? [exact] : orgs.filter((o) => {
    const n = normalizeOrgName(o.name);
    return n.includes(needle) || needle.includes(n);
  });
  if (fuzzy.length !== 1) return null;

  const mintRes = await fetch(`${CLOUD_API_BASE}/v0/internal/organizations/${fuzzy[0].id}/internal_token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writeAccess: false }),
    cache: "no-store",
  });
  if (!mintRes.ok) return null;
  const mintData = (await mintRes.json().catch(() => null)) as { token: string } | null;
  if (!mintData?.token) return null;

  const metricsRes = await fetchJson(`${CLOUD_API_BASE}/v0/metrics`, mintData.token);
  if (metricsRes.ok && Array.isArray(metricsRes.body)) return metricsRes.body as CloudMetric[];
  return null;
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
    let metrics: CloudMetric[] | null = null;
    let brukteMetode = "";

    if (adminToken) {
      metrics = await tryDirectToken(adminToken);
      if (metrics) {
        brukteMetode = "tokenet brukt direkte";
      } else if (cloudOrgName) {
        metrics = await tryMintedToken(adminToken, cloudOrgName);
        if (metrics) brukteMetode = "minted et nytt token via organisasjonen";
      }
    }
    if (!metrics && apiKey) {
      const res = await fetch(`${CLOUD_API_BASE}/v0/metrics`, {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
        cache: "no-store",
      });
      if (res.ok) {
        metrics = (await res.json()) as CloudMetric[];
        brukteMetode = "X-Api-Key";
      }
    }

    if (!metrics) {
      return NextResponse.json(
        {
          ok: false,
          error: adminToken
            ? "Fikk ikke tilgang verken ved å bruke admin-tokenet direkte eller ved å minte et nytt token for organisasjonen. Tokenet blir ikke godkjent av Adaptic Cloud i det hele tatt - trolig utløpt eller feil verdi."
            : "Mangler ADAPTIC_CLOUD_ADMIN_TOKEN eller ADAPTIC_CLOUD_API_KEY, eller ingen av dem ble godkjent.",
        },
        { status: 502 },
      );
    }

    const treff = metrics.find((m) => (m.eno || "").replace(/\D/g, "") === malepunktId);
    if (!treff) {
      return NextResponse.json({ ok: true, funnet: false, metode: brukteMetode });
    }
    // Grov tilnærming til "i drift": en hovedmåler (mainImported) med en
    // tilknyttet tsdb_id har en reell datatilkobling satt opp. Dette
    // bekrefter IKKE at det faktisk kommer ferske måleverdier akkurat nå.
    const iDrift = !!treff.mainImported && !!treff.currentMeter?.tsdbId;
    return NextResponse.json({
      ok: true,
      funnet: true,
      bygg: treff.building?.name ?? null,
      adresse: treff.building?.address ?? null,
      malenummer: treff.currentMeter?.serial ?? null,
      tsdb_id: treff.currentMeter?.tsdbId ?? null,
      hovedmaaler: !!treff.mainImported,
      foreslatt_status: iDrift ? "Aktiv" : "Satt opp i Cloud",
      metode: brukteMetode,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Kunne ikke slå opp i Adaptic Cloud: " + msg }, { status: 502 });
  }
}

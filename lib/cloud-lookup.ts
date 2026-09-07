// Slår opp om et gitt MålepunktID (EAN) allerede finnes som en måler i
// Adaptic Cloud, via det ekte Adaptic Cloud API-et (ikke MCP - dette kjører
// server-side i selve appen). Kun lesing, ingen skriving.
//
// Delt mellom den interaktive "Sjekk i Cloud"-ruten (app/api/cloud/sjekk-malepunkt)
// og den daglige automatiske jobben (app/api/cron/sjekk-cloud) - samme,
// testede logikk skal brukes begge steder i stedet for to kopier som kan
// gli fra hverandre.
//
// Uklart fra dialogen med Håkon Wardeberg (sept. 2026) om tokenet han delte
// er selve admin-tokenet (som koden vår skal bruke til å "minte" et nytt,
// kortlevd organisasjonsbundet token via internal_token-endepunktet), eller
// om det allerede ER det ferdig minted tokenet (som skal brukes direkte mot
// /v0/metrics uten noe mellomsteg). Prøver derfor BEGGE tolkninger i
// rekkefølge og legger ved DIAGNOSTIKK på hvert steg (ikke bare "ikke
// funnet") - vi har blitt overrasket av at kjente Cloud-registrerte målere
// kom tilbake som "ikke funnet" tidligere, og trenger å faktisk SE hvor i
// kjeden det stopper opp i stedet for å gjette videre blindt.
//
// Se apiserver (Adaptic Cloud) sin InternalOrganizationsController og
// MetricController for hvordan dette er bygget opp der.

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

interface MethodResult {
  metode: string;
  metrics: CloudMetric[] | null;
  info: string;
}

export type CloudLookupResult =
  | { ok: true; funnet: false; merknad: string }
  | {
      ok: true;
      funnet: true;
      bygg: string | null;
      adresse: string | null;
      malenummer: string | null;
      tsdb_id: string | null;
      hovedmaaler: boolean;
      foreslatt_status: "Aktiv" | "Satt opp i Cloud";
      metode: string;
    }
  | { ok: false; error: string };

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

async function fetchJson(url: string, headers: HeadersInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { headers: { ...headers, Accept: "application/json" }, cache: "no-store" });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

// Tolkning 2: tokenet er allerede det ferdig utledede, brukbare tokenet -
// bruk det rett og slett direkte mot /v0/metrics.
async function tryDirectToken(token: string): Promise<MethodResult> {
  const r = await fetchJson(`${CLOUD_API_BASE}/v0/metrics`, { Authorization: `Bearer ${token}` });
  if (r.ok && Array.isArray(r.body)) {
    return { metode: "tokenet brukt direkte", metrics: r.body as CloudMetric[], info: `${r.body.length} målere hentet` };
  }
  return { metode: "tokenet brukt direkte", metrics: null, info: `avvist (HTTP ${r.status})` };
}

// Tolkning 1: tokenet er et admin-token som må brukes til å "minte" et nytt,
// kortlevd, organisasjonsbundet token (POST .../internal_token) før det kan
// brukes mot /v0/metrics.
async function tryMintedToken(adminToken: string, cloudOrgName: string): Promise<MethodResult> {
  const metode = "minted et nytt token via organisasjonen";
  const orgsRes = await fetchJson(`${CLOUD_API_BASE}/v0/internal/organizations`, { Authorization: `Bearer ${adminToken}` });
  if (!orgsRes.ok || !Array.isArray(orgsRes.body)) {
    return { metode, metrics: null, info: `organisasjonsliste avvist (HTTP ${orgsRes.status})` };
  }
  const orgs = orgsRes.body as CloudOrg[];

  const needle = normalizeOrgName(cloudOrgName);
  const exact = orgs.find((o) => normalizeOrgName(o.name) === needle);
  const fuzzy = exact ? [exact] : orgs.filter((o) => {
    const n = normalizeOrgName(o.name);
    return n.includes(needle) || needle.includes(n);
  });
  if (fuzzy.length === 0) {
    return { metode, metrics: null, info: `fant ${orgs.length} organisasjoner totalt, ingen matcher «${cloudOrgName}»` };
  }
  if (fuzzy.length > 1) {
    return { metode, metrics: null, info: `${fuzzy.length} organisasjoner matcher «${cloudOrgName}» (${fuzzy.map((o) => o.name).join(", ")}) - for usikkert` };
  }

  const mintRes = await fetch(`${CLOUD_API_BASE}/v0/internal/organizations/${fuzzy[0].id}/internal_token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writeAccess: false }),
    cache: "no-store",
  });
  if (!mintRes.ok) {
    return { metode, metrics: null, info: `fant org «${fuzzy[0].name}», men minting feilet (HTTP ${mintRes.status})` };
  }
  const mintData = (await mintRes.json().catch(() => null)) as { token: string } | null;
  if (!mintData?.token) {
    return { metode, metrics: null, info: `fant org «${fuzzy[0].name}», minting ga ikke noe token tilbake` };
  }

  const metricsRes = await fetchJson(`${CLOUD_API_BASE}/v0/metrics`, { Authorization: `Bearer ${mintData.token}` });
  if (metricsRes.ok && Array.isArray(metricsRes.body)) {
    return {
      metode,
      metrics: metricsRes.body as CloudMetric[],
      info: `org «${fuzzy[0].name}» (id ${fuzzy[0].id}) - ${metricsRes.body.length} målere hentet`,
    };
  }
  return { metode, metrics: null, info: `fant org «${fuzzy[0].name}», minted token, men /v0/metrics avvist (HTTP ${metricsRes.status})` };
}

export async function slaOppMalepunktICloud(malepunktIdRaw: string, cloudOrgName: string): Promise<CloudLookupResult> {
  const malepunktId = malepunktIdRaw.replace(/\D/g, "");
  if (malepunktId.length !== 18) {
    return { ok: false, error: "malepunkt_id må være 18 siffer" };
  }

  const adminToken = process.env.ADAPTIC_CLOUD_ADMIN_TOKEN;
  const apiKey = process.env.ADAPTIC_CLOUD_API_KEY;

  try {
    const diagnostikk: string[] = [];
    let treff: CloudMetric | undefined;
    let brukteMetode = "";
    let harHattEtVellykketKall = false;

    const kjor = async (result: MethodResult) => {
      diagnostikk.push(`${result.metode}: ${result.info}`);
      if (!result.metrics) return;
      harHattEtVellykketKall = true;
      if (treff) return; // allerede funnet via en tidligere metode
      const funnet = result.metrics.find((m) => (m.eno || "").replace(/\D/g, "") === malepunktId);
      if (funnet) {
        treff = funnet;
        brukteMetode = result.metode;
      }
    };

    if (adminToken) {
      await kjor(await tryDirectToken(adminToken));
      if (!treff && cloudOrgName) {
        await kjor(await tryMintedToken(adminToken, cloudOrgName));
      }
    }
    if (!treff && apiKey) {
      const res = await fetch(`${CLOUD_API_BASE}/v0/metrics`, {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
        cache: "no-store",
      });
      if (res.ok) {
        const metrics = (await res.json()) as CloudMetric[];
        diagnostikk.push(`X-Api-Key: ${metrics.length} målere hentet`);
        harHattEtVellykketKall = true;
        const funnet = metrics.find((m) => (m.eno || "").replace(/\D/g, "") === malepunktId);
        if (funnet) { treff = funnet; brukteMetode = "X-Api-Key"; }
      } else {
        diagnostikk.push(`X-Api-Key: avvist (HTTP ${res.status})`);
      }
    }

    if (!harHattEtVellykketKall) {
      return { ok: false, error: "Ingen av metodene ble godkjent av Adaptic Cloud. Detaljer: " + diagnostikk.join(" | ") };
    }

    if (!treff) {
      return { ok: true, funnet: false, merknad: "Ikke funnet i noen av de sjekkede kildene. Detaljer: " + diagnostikk.join(" | ") };
    }

    // Grov tilnærming til "i drift": en hovedmåler (mainImported) med en
    // tilknyttet tsdb_id har en reell datatilkobling satt opp. Dette
    // bekrefter IKKE at det faktisk kommer ferske måleverdier akkurat nå.
    const iDrift = !!treff.mainImported && !!treff.currentMeter?.tsdbId;
    return {
      ok: true,
      funnet: true,
      bygg: treff.building?.name ?? null,
      adresse: treff.building?.address ?? null,
      malenummer: treff.currentMeter?.serial ?? null,
      tsdb_id: treff.currentMeter?.tsdbId ?? null,
      hovedmaaler: !!treff.mainImported,
      foreslatt_status: iDrift ? "Aktiv" : "Satt opp i Cloud",
      metode: brukteMetode,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return { ok: false, error: "Kunne ikke slå opp i Adaptic Cloud: " + msg };
  }
}

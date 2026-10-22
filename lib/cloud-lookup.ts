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
  orgNavn?: string;
  // Bearer-token som faktisk ga tilgang til disse målerne - trengs for å hente
  // forbruk med SAMME tilgang (måleren kan ligge i en annen org enn raden peker på).
  token?: string;
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
      // Selve målerens ID i Cloud (ikke tsdb_id, som er tilkoblingen til
      // tidsseriedatabasen) - trengs for å slå opp faktisk forbruk senere
      // via /v0/metrics/data uten å måtte gjøre et helt nytt org-oppslag.
      cloud_metric_id: string;
      hovedmaaler: boolean;
      foreslatt_status: "Aktiv" | "Satt opp i Cloud";
      metode: string;
      // false når treffet kom via bygningsnavn-fallback, ikke en eksakt
      // MålepunktID-match - da vet vi det ER et bygg med samme navn, men
      // IKKE sikkert at det er akkurat DENNE måleren. Brukes til å avgjøre
      // om tsdb_id/målenummer/status trygt kan bindes til raden, eller om
      // treffet bare skal brukes til et forbruksestimat (se
      // sjekk-malepunkt/route.ts og sjekkEnMaalerICloud).
      sikkerIdentitet: boolean;
      // Organisasjonen i Cloud der måleren faktisk ble funnet (via org-navnet
      // på raden, eller via automatisk søk i alle organisasjoner). null når
      // den ikke er kjent (direktetoken/API-nøkkel). Brukes til å fylle inn
      // eller rette strøm-org på raden.
      cloud_org_funnet: string | null;
      token_brukt: string | null;
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
    return { metode: "tokenet brukt direkte", metrics: r.body as CloudMetric[], info: `${r.body.length} målere hentet`, token };
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
      orgNavn: fuzzy[0].name,
      token: mintData.token,
    };
  }
  return { metode, metrics: null, info: `fant org «${fuzzy[0].name}», minted token, men /v0/metrics avvist (HTTP ${metricsRes.status})` };
}

// ---------- Automatisk søk etter riktig organisasjon ----------
//
// Rader havner ofte uten (eller med feil) strøm-org - typisk fordi kunden
// ligger under et eget «SK <navn>»-org i Cloud, eller org-navnet i registeret
// ikke er stavet likt. Siden vi uansett har admin-tokenet, kan vi lete etter
// MålepunktID-en (eno) i ALLE organisasjoner i stedet for å kreve at noen
// vet riktig org på forhånd. Eksakt eno-treff er pålitelig identitet.
//
// Cache pr. serverinstans (10 min): én bulk-sjekk eller cron-kjøring slår opp
// mange målere, og skal ikke minte token og hente målerlisten på nytt for
// hver eneste rad.
const ORG_CACHE_MS = 10 * 60 * 1000;
const MAKS_ORG_I_AUTOSOK = Number(process.env.ADAPTIC_CLOUD_AUTOSOK_MAKS_ORG || 80);
let orgListeCache: { t: number; orgs: CloudOrg[] } | null = null;
const orgMetricsCache = new Map<string, { t: number; token: string; metrics: CloudMetric[] }>();

async function hentOrgListe(adminToken: string): Promise<CloudOrg[] | null> {
  if (orgListeCache && Date.now() - orgListeCache.t < ORG_CACHE_MS) return orgListeCache.orgs;
  const r = await fetchJson(`${CLOUD_API_BASE}/v0/internal/organizations`, { Authorization: `Bearer ${adminToken}` });
  if (!r.ok || !Array.isArray(r.body)) return null;
  orgListeCache = { t: Date.now(), orgs: r.body as CloudOrg[] };
  return orgListeCache.orgs;
}

// Tak på nye org-oppslag pr. 10-minutters vindu - en cron-kjøring med mange
// målere som ikke finnes i Cloud skal ikke skanne alle organisasjoner om og
// om igjen mot Adaptic Cloud sitt API.
const MAKS_NYE_ORG_OPPSLAG_PER_VINDU = Number(process.env.ADAPTIC_CLOUD_AUTOSOK_BUDSJETT || 250);
let budsjettVindu = { start: Date.now(), brukt: 0 };

async function hentMetricsForOrg(adminToken: string, org: CloudOrg): Promise<{ token: string; metrics: CloudMetric[] } | null> {
  const cached = orgMetricsCache.get(org.id);
  if (cached && Date.now() - cached.t < ORG_CACHE_MS) return cached;
  if (Date.now() - budsjettVindu.start > ORG_CACHE_MS) budsjettVindu = { start: Date.now(), brukt: 0 };
  if (budsjettVindu.brukt >= MAKS_NYE_ORG_OPPSLAG_PER_VINDU) return null;
  budsjettVindu.brukt += 1;
  const mintRes = await fetch(`${CLOUD_API_BASE}/v0/internal/organizations/${org.id}/internal_token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writeAccess: false }),
    cache: "no-store",
  });
  if (!mintRes.ok) return null;
  const mint = (await mintRes.json().catch(() => null)) as { token: string } | null;
  if (!mint?.token) return null;
  const m = await fetchJson(`${CLOUD_API_BASE}/v0/metrics`, { Authorization: `Bearer ${mint.token}` });
  if (!m.ok || !Array.isArray(m.body)) return null;
  const entry = { t: Date.now(), token: mint.token, metrics: m.body as CloudMetric[] };
  orgMetricsCache.set(org.id, entry);
  return entry;
}

async function finnOrgMedMalepunkt(
  adminToken: string,
  malepunktId: string,
  kundeNavn: string,
  diagnostikk: string[],
): Promise<{ treff: { org: CloudOrg; metric: CloudMetric; token: string } | null; skannet: number }> {
  const orgs = await hentOrgListe(adminToken);
  if (!orgs) { diagnostikk.push("automatisk org-søk: fikk ikke hentet organisasjonslisten"); return { treff: null, skannet: 0 }; }

  const erMatch = (m: CloudMetric) => (m.eno || "").replace(/\D/g, "") === malepunktId;
  // 1) Alt som allerede ligger i cache (billig).
  for (const org of orgs) {
    const c = orgMetricsCache.get(org.id);
    const metric = c && Date.now() - c.t < ORG_CACHE_MS ? c.metrics.find(erMatch) : undefined;
    if (metric) return { treff: { org, metric, token: c!.token }, skannet: 1 };
  }
  const skannetFraCache = orgs.filter((o) => {
    const c = orgMetricsCache.get(o.id);
    return c && Date.now() - c.t < ORG_CACHE_MS;
  }).length;

  // 2) Prioriter organisasjoner som ligner kundenavnet, deretter «SK»-org.
  const needle = normalizeOrgName(kundeNavn).replace(/^sk\s+/, "");
  const score = (o: CloudOrg) => {
    const n = normalizeOrgName(o.name);
    const base = n.replace(/^sk\s+/, "");
    if (needle && (base === needle)) return 0;
    if (needle && (base.includes(needle) || needle.includes(base))) return 1;
    return /^sk\s/.test(n) ? 2 : 3;
  };
  const kandidater = orgs
    .filter((o) => !orgMetricsCache.has(o.id))
    .sort((a, b) => score(a) - score(b))
    .slice(0, MAKS_ORG_I_AUTOSOK);

  let sjekket = skannetFraCache;
  const BATCH = 4;
  for (let i = 0; i < kandidater.length; i += BATCH) {
    const batch = kandidater.slice(i, i + BATCH);
    const svar = await Promise.all(batch.map((o) => hentMetricsForOrg(adminToken, o)));
    for (let j = 0; j < batch.length; j++) {
      if (!svar[j]) continue;
      sjekket += 1;
      const metric = svar[j]!.metrics.find(erMatch);
      if (metric) return { treff: { org: batch[j], metric, token: svar[j]!.token }, skannet: sjekket };
    }
  }
  diagnostikk.push(`automatisk org-søk: lette i ${sjekket} av ${orgs.length} organisasjoner uten treff på MålepunktID`);
  return { treff: null, skannet: sjekket };
}

// Fjerner adressen i parentes ("TV12 (Tveitaråsvegen 12)" -> "tv12") og
// normaliserer ellers likt organisasjonsnavn-sammenligningen - Entelios sin
// egen innmeldingsmal og Cloud sin egen byggliste skriver ofte samme bygg
// litt forskjellig ellers (store/små bokstaver, mellomrom).
function normalizeByggnavn(navn: string): string {
  return navn
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9æøå]/g, "");
}

export async function slaOppMalepunktICloud(
  malepunktIdRaw: string,
  cloudOrgName: string,
  byggNavn?: string,
  kundeNavn?: string,
): Promise<CloudLookupResult> {
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
    let funnetOrgNavn: string | null = null;
    let tokenBrukt: string | null = null;
    const tokenForMetric = new Map<string, string>();
    let harHattEtVellykketKall = false;
    // Samler ALLE hentede målere på tvers av metodene - MålepunktID
    // (eno-feltet i Cloud) stemmer ikke alltid nøyaktig med kildefilens
    // 18-sifrede kode (ulik formatering, eller feltet er rett og slett ikke
    // fylt ut for den måleren i Cloud), men bygningsnavnet er ofte identisk.
    // Brukes som fallback under, ALDRI som førstevalg.
    const alleMetrics: CloudMetric[] = [];

    const kjor = async (result: MethodResult) => {
      diagnostikk.push(`${result.metode}: ${result.info}`);
      if (!result.metrics) return;
      harHattEtVellykketKall = true;
      alleMetrics.push(...result.metrics);
      if (result.token) for (const m of result.metrics) tokenForMetric.set(m.id, result.token);
      if (treff) return; // allerede funnet via en tidligere metode
      const funnet = result.metrics.find((m) => (m.eno || "").replace(/\D/g, "") === malepunktId);
      if (funnet) {
        treff = funnet;
        brukteMetode = result.metode;
        funnetOrgNavn = result.orgNavn ?? null;
        tokenBrukt = result.token ?? null;
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
        alleMetrics.push(...metrics);
        const funnet = metrics.find((m) => (m.eno || "").replace(/\D/g, "") === malepunktId);
        if (funnet) { treff = funnet; brukteMetode = "X-Api-Key"; }
      } else {
        diagnostikk.push(`X-Api-Key: avvist (HTTP ${res.status})`);
      }
    }

    // Ikke funnet via org-navnet på raden (eller raden mangler org): let i
    // ALLE organisasjoner etter akkurat denne MålepunktID-en.
    if (!treff && adminToken) {
      const auto = await finnOrgMedMalepunkt(adminToken, malepunktId, (kundeNavn || cloudOrgName || "").trim(), diagnostikk);
      if (auto.skannet > 0) harHattEtVellykketKall = true;
      if (auto.treff) {
        treff = auto.treff.metric;
        brukteMetode = `automatisk org-søk («${auto.treff.org.name}»)`;
        funnetOrgNavn = auto.treff.org.name;
        tokenBrukt = auto.treff.token;
        diagnostikk.push(`automatisk org-søk: fant MålepunktID i organisasjonen «${auto.treff.org.name}»`);
      }
    }

    if (!harHattEtVellykketKall) {
      return { ok: false, error: "Ingen av metodene ble godkjent av Adaptic Cloud. Detaljer: " + diagnostikk.join(" | ") };
    }

    // Fallback på bygningsnavn - kun når MålepunktID ikke ga treff. Et bygg
    // med flere målere (typisk flere leietakere/anlegg) skal ALDRI gjettes
    // blindt mellom submålere - men HOVEDMÅLEREN er alltid entydig (det
    // finnes bare én pr. bygg), og gir uansett et riktig forbruksestimat for
    // hele bygget. sikkerIdentitet=false på dette treffet, uansett - vi vet
    // det ER bygget, IKKE sikkert at det er akkurat DENNE MålepunktID-en.
    let viaByggnavn = false;
    if (!treff && byggNavn?.trim()) {
      const target = normalizeByggnavn(byggNavn);
      if (target) {
        const kandidater = alleMetrics.filter((m) => m.building?.name && normalizeByggnavn(m.building.name) === target);
        if (kandidater.length === 1) {
          treff = kandidater[0];
          brukteMetode = "bygningsnavn (MålepunktID stemte ikke)";
          viaByggnavn = true;
          diagnostikk.push(`bygningsnavn-fallback: 1 entydig treff på «${byggNavn}»`);
        } else if (kandidater.length > 1) {
          const hovedmaalere = kandidater.filter((m) => m.mainImported);
          if (hovedmaalere.length === 1) {
            treff = hovedmaalere[0];
            brukteMetode = "bygningsnavn + hovedmåler (flere målere i bygget, MålepunktID stemte ikke)";
            viaByggnavn = true;
            diagnostikk.push(`bygningsnavn-fallback: ${kandidater.length} målere deler byggnavn «${byggNavn}», brukte den entydige hovedmåleren for forbruksestimat`);
          } else {
            diagnostikk.push(`bygningsnavn-fallback: ${kandidater.length} målere deler byggnavn «${byggNavn}» (${hovedmaalere.length} hovedmålere) - for usikkert å velge automatisk`);
          }
        } else {
          diagnostikk.push(`bygningsnavn-fallback: ingen målere med byggnavn «${byggNavn}»`);
        }
      }
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
      cloud_metric_id: treff.id,
      hovedmaaler: !!treff.mainImported,
      foreslatt_status: iDrift ? "Aktiv" : "Satt opp i Cloud",
      metode: brukteMetode,
      sikkerIdentitet: !viaByggnavn,
      cloud_org_funnet: viaByggnavn ? null : funnetOrgNavn,
      // KUN til intern bruk server-side (forbruksoppslag) - skal aldri sendes til nettleseren.
      token_brukt: tokenBrukt ?? tokenForMetric.get(treff.id) ?? null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return { ok: false, error: "Kunne ikke slå opp i Adaptic Cloud: " + msg };
  }
}

// ---------- Faktisk forbruk (ekte målerdata, ikke estimat) ----------
//
// Skiller seg fra oppslaget over: der leter vi etter ETT målepunkt via
// eno-matching mot /v0/metrics. Her har vi ALLEREDE cloud_metric_id lagret
// fra et tidligere "Sjekk i Cloud"-oppslag, og trenger bare et gyldig
// bearer-token for riktig organisasjon for å hente selve tallene via
// /v0/metrics/data (samme endepunkt som Adaptic Cloud sitt eget dashbord
// bruker, se MetricController.getMultipleMetricsData i apiserver).

interface TimeseriesPoint { timestamp?: string; ts?: string; value: number | null }

// Henter et gyldig bearer-token for én organisasjon - egen funksjon (ikke
// bare en bieffekt av tryMintedToken) fordi forbruksoppslaget grupperer
// mange målepunkt PER organisasjon og bare trenger token én gang per
// gruppe, ikke én gang per målepunkt.
export async function hentTokenForOrg(cloudOrgName: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const adminToken = process.env.ADAPTIC_CLOUD_ADMIN_TOKEN;
  if (!adminToken) return { ok: false, error: "Mangler ADAPTIC_CLOUD_ADMIN_TOKEN" };

  // Direktetokenet dekker som regel bare én organisasjon (det som ble brukt
  // til å opprette det) - dupliserer derfor ikke logikken for å avgjøre
  // HVILKEN, og prøver heller alltid minting via org-navnet først, siden det
  // er den tolkningen som faktisk har vist seg å fungere i praksis.
  const orgsRes = await fetchJson(`${CLOUD_API_BASE}/v0/internal/organizations`, { Authorization: `Bearer ${adminToken}` });
  if (orgsRes.ok && Array.isArray(orgsRes.body)) {
    const orgs = orgsRes.body as CloudOrg[];
    const needle = normalizeOrgName(cloudOrgName);
    const exact = orgs.find((o) => normalizeOrgName(o.name) === needle);
    const fuzzy = exact ? [exact] : orgs.filter((o) => {
      const n = normalizeOrgName(o.name);
      return n.includes(needle) || needle.includes(n);
    });
    if (fuzzy.length === 1) {
      const mintRes = await fetch(`${CLOUD_API_BASE}/v0/internal/organizations/${fuzzy[0].id}/internal_token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ writeAccess: false }),
        cache: "no-store",
      });
      if (mintRes.ok) {
        const mintData = (await mintRes.json().catch(() => null)) as { token: string } | null;
        if (mintData?.token) return { ok: true, token: mintData.token };
      }
    }
  }
  // Fallback: direktetokenet virker for noen oppsett (se sjekk-malepunkt).
  const direct = await fetchJson(`${CLOUD_API_BASE}/v0/metrics`, { Authorization: `Bearer ${adminToken}` });
  if (direct.ok) return { ok: true, token: adminToken };
  return { ok: false, error: `fant ikke gyldig token for org «${cloudOrgName}»` };
}

// Summerer faktisk kWh per måned for et sett målere, for ett kalenderår.
// Returnerer null for målere uten data i en gitt måned (padding), som
// telles som 0 i summen - en måler som ikke er koblet til ennå skal ikke
// forsvinne fra tallet, bare bidra med 0.
export async function hentMaanedsforbruk(
  token: string,
  metricIds: string[],
  year: number,
): Promise<{ ok: true; perMonthKwh: number[] } | { ok: false; error: string }> {
  if (!metricIds.length) return { ok: true, perMonthKwh: Array(12).fill(0) };
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year + 1}-01-01T00:00:00Z`;
  const qs = new URLSearchParams({ from, to, resolution: "MONTH", rollup: "SUM", padding: "true" });
  const res = await fetch(`${CLOUD_API_BASE}/v1/metrics/data?${qs.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(metricIds),
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, error: `/v1/metrics/data avvist (HTTP ${res.status})` };
  const body = (await res.json().catch(() => null)) as Record<string, TimeseriesPoint[]> | null;
  if (!body) return { ok: false, error: "Uventet svar fra /v1/metrics/data" };

  const perMonthKwh = Array(12).fill(0);
  for (const points of Object.values(body)) {
    if (!Array.isArray(points)) continue;
    points.forEach((p, i) => {
      if (i > 11) return; // ett år, aldri mer enn 12 punkter forventet
      if (typeof p?.value === "number") perMonthKwh[i] += p.value;
    });
  }
  return { ok: true, perMonthKwh };
}

// Estimert årsforbruk for ETT enkelt målepunkt som allerede er koblet opp i
// Cloud (mainImported + tsdb_id), brukt til å fylle inn "Årsforbruk"
// automatisk ved "Sjekk i Cloud" når feltet mangler fra kilden - f.eks. en
// Entelios-innmeldingsmal uten årsforbruk-kolonne i det hele tatt (se
// excel-parser.ts). Siste 365 dager (rullerende), ikke kalenderår - måleren
// kan ha vært i drift lenge før den ble meldt inn her, og et rent
// kalenderår ville gitt et kunstig lavt tall tidlig på året.
export async function hentEstimertAarsforbruk(
  token: string,
  metricId: string,
): Promise<{ ok: true; kwh: number } | { ok: false; error: string }> {
  const now = new Date();
  const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const to = now.toISOString();
  const qs = new URLSearchParams({ from, to, resolution: "MONTH", rollup: "SUM", padding: "true" });
  const res = await fetch(`${CLOUD_API_BASE}/v1/metrics/data?${qs.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify([metricId]),
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, error: `/v1/metrics/data avvist (HTTP ${res.status})` };
  const body = (await res.json().catch(() => null)) as Record<string, TimeseriesPoint[]> | null;
  if (!body) return { ok: false, error: "Uventet svar fra /v1/metrics/data" };

  let kwh = 0;
  for (const points of Object.values(body)) {
    if (!Array.isArray(points)) continue;
    for (const p of points) if (typeof p?.value === "number") kwh += p.value;
  }
  return { ok: true, kwh: Math.round(kwh) };
}

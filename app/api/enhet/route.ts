import { NextResponse } from "next/server";

// Slår opp firmanavn fra organisasjonsnummer (og motsatt vei, org.nr fra
// firmanavn) via Brønnøysundregistrene sitt åpne Enhetsregister-API -
// offisiell kilde, gratis, ingen nøkkel nødvendig (samme prinsipp som
// /api/netteier bruker Kartverket/NVE). Prøver først Enhetsregisteret
// (vanlige foretak), så Underenhetsregisteret (bedrifter/avdelinger som er
// registrert under et hovedforetak).

export const dynamic = "force-dynamic";

const UA = { "User-Agent": "Adaptic-Stromflyt/1.0", Accept: "application/json" };

async function slaOpp(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  return r.json();
}

interface BrregTreff { organisasjonsnummer: string; navn: string }

// Navn -> org.nr, brukt ved Excel-import der kildefilen ikke oppgir org.nr i
// det hele tatt (bare kundenavn) - se "Avtaleinformasjon per referanse" i
// stromflyt/page.tsx. Fritekstsøket i Brønnøysundregisteret er ikke presist
// nok til å stole blindt på (flere selskaper kan hete nesten det samme), så
// dette returnerer alltid kandidater å velge mellom, aldri ett automatisk
// "riktig" svar - selgeren bekrefter selv.
async function sokPaaNavn(navn: string) {
  const qs = new URLSearchParams({ navn, size: "5" });
  const [enheter, underenheter] = await Promise.all([
    slaOpp(`https://data.brreg.no/enhetsregisteret/api/enheter?${qs.toString()}`),
    slaOpp(`https://data.brreg.no/enhetsregisteret/api/underenheter?${qs.toString()}`),
  ]);
  const treff: BrregTreff[] = [
    ...(enheter?._embedded?.enheter ?? []),
    ...(underenheter?._embedded?.underenheter ?? []),
  ].map((e: any) => ({ organisasjonsnummer: e.organisasjonsnummer, navn: e.navn }));
  return treff.slice(0, 5);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const navn = url.searchParams.get("navn")?.trim();
  if (navn) {
    try {
      const treff = await sokPaaNavn(navn);
      return NextResponse.json({ ok: true, treff });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "ukjent feil";
      return NextResponse.json({ ok: false, error: "Søk feilet: " + msg });
    }
  }

  const orgnr = url.searchParams.get("orgnr")?.trim();
  if (!orgnr || !/^\d{9}$/.test(orgnr)) {
    return NextResponse.json({ ok: false, error: "Org.nr må være 9 siffer" }, { status: 400 });
  }
  try {
    let d = await slaOpp(`https://data.brreg.no/enhetsregisteret/api/enheter/${orgnr}`);
    let underenhet = false;
    if (!d) {
      d = await slaOpp(`https://data.brreg.no/enhetsregisteret/api/underenheter/${orgnr}`);
      underenhet = true;
    }
    if (!d?.navn) {
      return NextResponse.json({ ok: false, error: "Fant ingen enhet med dette org.nr-et" });
    }
    return NextResponse.json({
      ok: true,
      navn: d.navn as string,
      underenhet,
      poststed: d.forretningsadresse?.poststed ?? d.beliggenhetsadresse?.poststed ?? null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Oppslag feilet: " + msg });
  }
}

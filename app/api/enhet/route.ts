import { NextResponse } from "next/server";

// Slår opp firmanavn fra organisasjonsnummer via Brønnøysundregistrene sitt
// åpne Enhetsregister-API - offisiell kilde, gratis, ingen nøkkel nødvendig
// (samme prinsipp som /api/netteier bruker Kartverket/NVE). Prøver først
// Enhetsregisteret (vanlige foretak), så Underenhetsregisteret (bedrifter/
// avdelinger som er registrert under et hovedforetak).

export const dynamic = "force-dynamic";

const UA = { "User-Agent": "Adaptic-Stromflyt/1.0", Accept: "application/json" };

async function slaOpp(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  return r.json();
}

export async function GET(req: Request) {
  const orgnr = new URL(req.url).searchParams.get("orgnr")?.trim();
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

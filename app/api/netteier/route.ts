import { NextResponse } from "next/server";
import { prisomradeFromPostnr } from "../../../lib/geo";

// Slår opp netteier og prisområde for en adresse, uten API-nøkkel:
//  1) Kartverket geokoder adressen til koordinater + postnummer
//  2) NVE (Nettanlegg3, lag Omradekonsesjonaerer) gir netteier for punktet
//  3) prisområde utledes fra postnummeret

export const dynamic = "force-dynamic";

const UA = { "User-Agent": "Adaptic-Stromflyt/1.0" };

async function geocodeOnce(sok: string) {
  const url =
    "https://ws.geonorge.no/adresser/v1/sok?" +
    new URLSearchParams({ sok, fuzzy: "true", treffPerSide: "1", utkoordsys: "4326" });
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const d = await r.json();
  const a = d?.adresser?.[0];
  if (!a?.representasjonspunkt) return null;
  const linje2 = [a.postnummer, a.poststed].filter(Boolean).join(" ");
  return {
    adresse: [a.adressetekst, linje2].filter(Boolean).join(", "),
    postnummer: a.postnummer as string | undefined,
    poststed: a.poststed as string | undefined,
    lat: a.representasjonspunkt.lat as number,
    lon: a.representasjonspunkt.lon as number,
  };
}

// Kartverket-søket feiler ofte når postnummeret ligger i strengen. Vi prøver
// først hele adressen, så en variant uten det 4-sifrede postnummeret.
async function geocode(address: string) {
  const attempts = [address];
  const utenPostnr = address
    .replace(/\b\d{4}\b/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,\s*,/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
  if (utenPostnr && utenPostnr !== address) attempts.push(utenPostnr);
  for (const sok of attempts) {
    const hit = await geocodeOnce(sok);
    if (hit) return hit;
  }
  return null;
}

async function slaaOppNetteier(lon: number, lat: number) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "NAVN,EIER_ID",
    returnGeometry: "false",
    f: "json",
  });
  const url = "https://gis3.nve.no/map/rest/services/Nettanlegg3/MapServer/9/query?" + params;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const d = await r.json();
  const attr = d?.features?.[0]?.attributes;
  if (!attr?.NAVN) return null;
  return { navn: attr.NAVN as string, orgnr: attr.EIER_ID ? String(attr.EIER_ID) : undefined };
}

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address")?.trim();
  if (!address) return NextResponse.json({ ok: false, error: "Mangler adresse" }, { status: 400 });
  try {
    const g = await geocode(address);
    if (!g) return NextResponse.json({ ok: false, error: "Fant ikke adressen. Prøv gate + postnr + sted." });
    const n = await slaaOppNetteier(g.lon, g.lat);
    return NextResponse.json({
      ok: true,
      adresse: g.adresse,
      postnummer: g.postnummer ?? null,
      poststed: g.poststed ?? null,
      lat: g.lat,
      lon: g.lon,
      netteier: n?.navn ?? null,
      netteierOrgnr: n?.orgnr ?? null,
      prisomrade: prisomradeFromPostnr(g.postnummer),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Oppslag feilet: " + msg });
  }
}

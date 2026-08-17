import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { parseFakturaPdf } from "../../../../lib/faktura-parser";

// Tar imot en referanse (storagePath) til en strømfaktura som allerede er
// lastet opp til Supabase Storage-bøtten "fakturaer", laster den ned på
// serveren og sender den til Claude for utlesing - se lib/faktura-parser.ts
// for hvorfor dette ikke er et fast tekstuttrekk slik avtale-parser.ts er.
//
// Filen sendes IKKE direkte i denne forespørselen (som avtale/excel-rutene
// gjør) - Vercel sin serverless-funksjoner har en hard grense på ca. 4,5 MB
// per forespørsel, og skannede strømfakturaer med mye historikk overskrider
// ofte det. Opplasting til Storage har en mye høyere grense, og går ikke
// gjennom denne funksjonen i det hele tatt.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = "fakturaer";

export async function POST(req: Request) {
  const auth = await requireStromflytAccess(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let storagePath: string | undefined;
  try {
    const body = await req.json();
    storagePath = body?.storagePath;
    if (!storagePath || typeof storagePath !== "string") {
      return NextResponse.json({ ok: false, error: "Mangler storagePath" }, { status: 400 });
    }

    const { data, error } = await auth.supabase.storage.from(BUCKET).download(storagePath);
    if (error || !data) {
      throw new Error(error?.message || "Fant ikke filen i lagring");
    }
    const buf = new Uint8Array(await data.arrayBuffer());
    const fakturaer = await parseFakturaPdf(buf);
    return NextResponse.json({ ok: true, fakturaer });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Kunne ikke lese fakturaen: " + msg }, { status: 500 });
  } finally {
    // Filen trengs kun forbigående for denne ene utlesingen - rydd opp
    // uavhengig av om det gikk bra, slik at Storage ikke fylles opp.
    if (storagePath) void auth.supabase.storage.from(BUCKET).remove([storagePath]);
  }
}

import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { parseAvtalePdf } from "../../../../lib/avtale-parser";

// Tar imot en avtale-PDF (multipart, felt "file") og sender den direkte til
// Claude for utlesing - se lib/avtale-parser.ts for hvorfor dette ikke
// lenger er et fast tekstuttrekk (unpdf + regex), men samme AI-lesing som
// strømfaktura-leseren i lib/faktura-parser.ts bruker.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await requireStromflytAccess(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "Ingen fil mottatt" }, { status: 400 });
    }
    const buf = new Uint8Array(await (file as File).arrayBuffer());
    const parsed = await parseAvtalePdf(buf);
    return NextResponse.json({ ok: true, ...parsed });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Kunne ikke lese PDF: " + msg }, { status: 500 });
  }
}

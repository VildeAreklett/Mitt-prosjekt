import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { parseFakturaPdf } from "../../../../lib/faktura-parser";

// Tar imot en inngående strømfaktura (multipart, felt "file") og sender den
// til Claude for utlesing - se lib/faktura-parser.ts for hvorfor dette ikke
// er et fast tekstuttrekk slik avtale-parser.ts er.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const parsed = await parseFakturaPdf(buf);
    return NextResponse.json({ ok: true, ...parsed });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Kunne ikke lese fakturaen: " + msg }, { status: 500 });
  }
}

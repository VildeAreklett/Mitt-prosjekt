import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { extractText, getDocumentProxy } from "unpdf";
import { parseAvtale } from "../../../../lib/avtale-parser";

// Tar imot en avtale-PDF (multipart, felt "file"), henter ut teksten og
// parser den til kunde + kommersielle vilkår + målepunkt-rader.

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
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    const parsed = parseAvtale(text);
    return NextResponse.json({ ok: true, ...parsed });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Kunne ikke lese PDF: " + msg }, { status: 500 });
  }
}

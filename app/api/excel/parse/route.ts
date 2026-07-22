import { NextResponse } from "next/server";
import { requireStromflytAccess } from "../../../../lib/server-auth";
import { parseExcelWorkbook } from "../../../../lib/excel-parser";

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
      return NextResponse.json({ ok: false, error: "Ingen Excel-fil mottatt" }, { status: 400 });
    }
    const name = (file as File).name.toLowerCase();
    if (!name.endsWith(".xlsx")) {
      return NextResponse.json({ ok: false, error: "Foreløpig støttes .xlsx-filer" }, { status: 400 });
    }
    const bytes = new Uint8Array(await (file as File).arrayBuffer());
    const parsed = await parseExcelWorkbook(bytes);
    if (!parsed.sheets.length) {
      return NextResponse.json({ ok: false, error: "Fant ingen faner med MålepunktID og adresse" }, { status: 422 });
    }
    return NextResponse.json({ ok: true, ...parsed });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "ukjent feil";
    return NextResponse.json({ ok: false, error: "Kunne ikke lese Excel-filen: " + message }, { status: 500 });
  }
}

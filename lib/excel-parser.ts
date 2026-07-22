import ExcelJS from "exceljs";

export interface ParsedExcelRow {
  source_row: number;
  referansekode: string;
  kunde_hint: string;
  cloud_org: string;
  org_nr: string;
  selskapsnavn: string;
  bygg: string;
  adresse: string;
  navn: string;
  maalenummer: string;
  maalepunkt_id: string;
  prisomrade: string;
  netteier: string;
  aarsforbruk_kwh: number | null;
  oppstartdato: string;
  kommentar: string;
  signert: boolean | null;
  paslag_ore_kwh: number | null;
  status_suggestion: "Innmeldt" | "Sendt Entelios";
  gyldig: boolean;
  problemer: string[];
}

export interface ParsedExcelSheet {
  name: string;
  header_row: number;
  rows: ParsedExcelRow[];
}

export interface ParsedExcelWorkbook {
  sheets: ParsedExcelSheet[];
}

type Field =
  | "bestilt"
  | "referansekode"
  | "cloud_org"
  | "org_nr"
  | "selskapsnavn"
  | "bygg"
  | "adresse"
  | "navn"
  | "maalenummer"
  | "maalepunkt_id"
  | "prisomrade"
  | "netteier"
  | "aarsforbruk_kwh"
  | "oppstartdato"
  | "kommentar"
  | "signert"
  | "paslag_ore_kwh";

function plain(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return plain(value.result as ExcelJS.CellValue);
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((x) => x.text).join("").trim();
  }
  return String(value).trim();
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/å/g, "a").replace(/ø/g, "o").replace(/æ/g, "ae")
    .replace(/[^a-z0-9]/g, "");
}

function fieldFor(header: string): Field | null {
  const h = normalized(header);
  if (!h) return null;
  if (h.includes("bestiltentelios") || h === "bestilt") return "bestilt";
  if (h.includes("referansekode") || h.includes("atkode")) return "referansekode";
  if (h.includes("organisasjonadapticcloud") || h === "cloudorg") return "cloud_org";
  if (h === "orgnr" || h.includes("organisasjonsnummer")) return "org_nr";
  if (h.includes("selskapsnavn")) return "selskapsnavn";
  if (h === "bygg") return "bygg";
  if (h === "adresse") return "adresse";
  if (h === "navn" || h === "kundeinfo") return "navn";
  if (h.includes("malenummer")) return "maalenummer";
  if (h.includes("malepunktid")) return "maalepunkt_id";
  if (h.includes("prisomrade")) return "prisomrade";
  if (h.includes("netteier")) return "netteier";
  if (h.includes("arsforbruk")) return "aarsforbruk_kwh";
  if (h.includes("oppstartdato") || h.includes("avtaltoppstart")) return "oppstartdato";
  if (h.includes("kommentar")) return "kommentar";
  if (h === "signert") return "signert";
  if (h.includes("antaltpaslag") || h.includes("antallpaslag") || h === "paslag") return "paslag_ore_kwh";
  return null;
}

function cleanId(value: string): string {
  return value.replace(/^[´'`]/, "").replace(/\.0$/, "").replace(/\s/g, "");
}

function numberOrNull(value: string): number | null {
  const n = Number(value.replace(/\s/g, "").replace(",", "."));
  return value.trim() !== "" && Number.isFinite(n) ? n : null;
}

function isoDate(value: string): string {
  const s = value.trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const no = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (no) return `${no[3]}-${no[2].padStart(2, "0")}-${no[1].padStart(2, "0")}`;
  return "";
}

export async function parseExcelWorkbook(bytes: Uint8Array): Promise<ParsedExcelWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheets: ParsedExcelSheet[] = [];

  for (const sheet of workbook.worksheets) {
    let headerRow = 0;
    let columns = new Map<number, Field>();

    for (let r = 1; r <= Math.min(sheet.rowCount, 12); r += 1) {
      const candidate = new Map<number, Field>();
      sheet.getRow(r).eachCell({ includeEmpty: true }, (cell, col) => {
        const field = fieldFor(plain(cell.value));
        if (field) candidate.set(col, field);
      });
      const values = [...candidate.values()];
      if (values.includes("maalepunkt_id") && values.includes("adresse") && candidate.size >= 4) {
        headerRow = r;
        columns = candidate;
        break;
      }
    }
    if (!headerRow) continue;

    // Enkelte historiske faner har en navnekolonne uten overskrift mellom
    // referansekode og adresse (som «Verftet» i Bestilt 25 Juni).
    const refCol = [...columns].find(([, f]) => f === "referansekode")?.[0];
    const addressCol = [...columns].find(([, f]) => f === "adresse")?.[0];
    const unnamedCustomerCol = refCol && addressCol && addressCol - refCol === 2 ? refCol + 1 : null;

    const rows: ParsedExcelRow[] = [];
    for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
      const raw: Partial<Record<Field, string>> = {};
      for (const [col, field] of columns) raw[field] = plain(sheet.getRow(r).getCell(col).value);
      const kundeHint = unnamedCustomerCol ? plain(sheet.getRow(r).getCell(unnamedCustomerCol).value) : "";
      const maalepunktId = cleanId(raw.maalepunkt_id || "");
      const adresse = raw.adresse || "";
      if (!maalepunktId && !adresse) continue;

      const maalenummer = cleanId(raw.maalenummer || "");
      const prisomrade = (raw.prisomrade || "").toUpperCase();
      const aarsforbruk = numberOrNull(raw.aarsforbruk_kwh || "");
      const oppstart = isoDate(raw.oppstartdato || "");
      const problemer: string[] = [];
      if (!adresse) problemer.push("Mangler adresse");
      if (!/^\d{18}$/.test(maalepunktId)) problemer.push("MålepunktID må være 18 siffer");
      if (!maalenummer) problemer.push("Mangler målenummer");
      if (!/^NO[1-5]$/.test(prisomrade)) problemer.push("Mangler/ugyldig prisområde");
      if (!(raw.netteier || "").trim()) problemer.push("Mangler netteier");
      if (aarsforbruk == null) problemer.push("Mangler årsforbruk");
      if (!oppstart) problemer.push("Mangler oppstartsdato");

      const bestilt = /^(ja|yes|sendt)$/i.test(raw.bestilt || "") || /^bestilt\b/i.test(sheet.name);
      const signertRaw = raw.signert || "";
      rows.push({
        source_row: r,
        referansekode: raw.referansekode || "",
        kunde_hint: kundeHint,
        cloud_org: raw.cloud_org || "",
        org_nr: cleanId(raw.org_nr || "").slice(0, 9),
        selskapsnavn: raw.selskapsnavn || "",
        bygg: raw.bygg || kundeHint || "",
        adresse,
        navn: raw.navn || "",
        maalenummer,
        maalepunkt_id: maalepunktId,
        prisomrade,
        netteier: raw.netteier || "",
        aarsforbruk_kwh: aarsforbruk,
        oppstartdato: oppstart,
        kommentar: raw.kommentar || "",
        signert: signertRaw ? /^(ja|yes|true)$/i.test(signertRaw) : null,
        paslag_ore_kwh: numberOrNull(raw.paslag_ore_kwh || ""),
        status_suggestion: bestilt ? "Sendt Entelios" : "Innmeldt",
        gyldig: problemer.length === 0,
        problemer,
      });
    }
    if (rows.length) sheets.push({ name: sheet.name, header_row: headerRow, rows });
  }

  return { sheets };
}

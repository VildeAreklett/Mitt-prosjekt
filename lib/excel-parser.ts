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
  // Fra en "Strømkunde/Leietakerfakturering"-kolonne (som i Entelios-
  // innmeldingsmalen) - forslag til rute, ikke bindende. "" hvis fila ikke
  // sier noe om det.
  rute_hint: "A" | "B" | "";
  // "Kundens avtale" i en Avtaletype/Fakturamottaker-kolonne betyr kunden
  // har egen Entelios-avtale og Adaptic kun er fakturamottaker - IKKE en
  // vanlig Adaptic-avtale. Skal aldri importeres stille - se
  // Reitan/Vestenfjeldske-saken og Borg Forvaltning/Elgsetergate 16.
  krever_manuell_avklaring: boolean;
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
  | "paslag_ore_kwh"
  | "kunde"
  | "rute_kilde"
  | "avtaletype_kilde";

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
  // "Prosjektnr" (Entelios-innmeldingsmalen sitt AT-nummer-felt, f.eks.
  // "AT30012.040") er samme slags referanse som "Referansekode"/"AT-kode" -
  // begge peker på Adaptic sin interne prosjekt-/avtalereferanse.
  if (h.includes("referansekode") || h.includes("atkode") || h.includes("prosjektnr")) return "referansekode";
  if (h.includes("organisasjonadapticcloud") || h === "cloudorg") return "cloud_org";
  if (h === "orgnr" || h.includes("organisasjonsnummer")) return "org_nr";
  if (h.includes("selskapsnavn")) return "selskapsnavn";
  // "Kunde" alene (uten "selskapsnavn" i teksten) - egen kolonne i en del
  // maler, samme betydning.
  if (h === "kunde") return "kunde";
  if (h === "bygg") return "bygg";
  if (h === "adresse") return "adresse";
  if (h === "navn" || h === "kundeinfo") return "navn";
  // "Målernr"/"Målernummer" er samme felt som "Målenummer", bare en annen
  // sammensetning av de samme ordene.
  if (h.includes("malenummer") || h.includes("malernummer") || h === "malernr") return "maalenummer";
  if (h.includes("malepunktid")) return "maalepunkt_id";
  if (h.includes("prisomrade")) return "prisomrade";
  if (h.includes("netteier")) return "netteier";
  if (h.includes("arsforbruk")) return "aarsforbruk_kwh";
  // "Oppstart" alene (uten "dato") er like gyldig som "Oppstartdato" -
  // samme felt, kortere kolonnenavn i noen maler.
  if (h.includes("oppstart")) return "oppstartdato";
  // "Merknad" er samme fritekstfelt som "Kommentar" i andre maler.
  if (h.includes("kommentar") || h.includes("merknad")) return "kommentar";
  if (h === "signert") return "signert";
  if (h.includes("antaltpaslag") || h.includes("antallpaslag") || h === "paslag") return "paslag_ore_kwh";
  // "Strømkunde/Leietakerfakturering" (eller bare "Strømkunde" /
  // "Leietakerfakturering") sier hvilken rute anlegget hører til - B for
  // strømkunde (sluttbruker), A for leietakerfakturering.
  if (h.includes("stromkunde") || h.includes("leietakerfakturering")) return "rute_kilde";
  // "Avtaletype" fanger opp verdien "Kundens avtale" (kunden har egen
  // Entelios-avtale, Adaptic er bare fakturamottaker) - skal ALDRI
  // importeres som en vanlig Adaptic-avtale uten videre. NB: ikke slå
  // sammen med "Fakturamottaker" her, selv om de gjerne står ved siden av
  // hverandre i samme mal - det er en annen kolonne (peker som regel bare
  // på Adaptic selv) og ville overskrevet denne verdien siden de deler
  // samme rå-nøkkel per rad.
  if (h.includes("avtaletype")) return "avtaletype_kilde";
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
      // Entelios sin egen innmeldingsmal har ingen egen "Adresse"-kolonne i
      // det hele tatt - bare "Bygg" (som ofte inneholder gateadressen i
      // parentes, f.eks. "TV12 (Tveitaråsvegen 12)"). Godta den som
      // adressekilde når "Adresse" mangler.
      if (values.includes("maalepunkt_id") && (values.includes("adresse") || values.includes("bygg")) && candidate.size >= 4) {
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
      const adresse = raw.adresse || raw.bygg || "";
      if (!maalepunktId && !adresse) continue;

      const maalenummer = cleanId(raw.maalenummer || "");
      const prisomrade = (raw.prisomrade || "").toUpperCase();
      const aarsforbruk = numberOrNull(raw.aarsforbruk_kwh || "");
      const oppstart = isoDate(raw.oppstartdato || "");
      const problemer: string[] = [];
      if (!adresse) problemer.push("Mangler adresse");
      if (!/^\d{18}$/.test(maalepunktId)) problemer.push("MålepunktID må være 18 siffer");
      // Målenummer er IKKE en blokkerende mangel: MålepunktID er den unike,
      // pålitelige identifikatoren. Målenummer hentes ofte automatisk etterpå
      // via "Sjekk i Cloud" (se sjekkEnMaalerICloud i stromflyt/page.tsx) -
      // å kreve det her ville blokkert import av ellers helt gyldige rader.
      if (!/^NO[1-5]$/.test(prisomrade)) problemer.push("Mangler/ugyldig prisområde");
      if (!(raw.netteier || "").trim()) problemer.push("Mangler netteier");
      if (aarsforbruk == null) problemer.push("Mangler årsforbruk");
      if (!oppstart) problemer.push("Mangler oppstartsdato");

      const bestilt = /^(ja|yes|sendt)$/i.test(raw.bestilt || "") || /^bestilt\b/i.test(sheet.name);
      const signertRaw = raw.signert || "";
      // "Kundens avtale" (se avtaletype_kilde over) betyr Adaptic kun er
      // fakturamottaker på en avtale kunden selv har med Entelios - IKKE en
      // vanlig Adaptic-avtale. Blokkeres alltid til noen har sett på den,
      // uansett om resten av raden ellers er komplett.
      const krevManuellAvklaring = /kundens avtale/i.test(raw.avtaletype_kilde || "");
      // Fremst i lista, ikke bakerst - dette er en helt annen og viktigere
      // advarsel enn et vanlig manglende datafelt (se
      // krever_manuell_avklaring over), og skal ikke drukne bak
      // "Mangler årsforbruk" e.l. i UI-et som bare viser problemer[0].
      if (krevManuellAvklaring) problemer.unshift("Kundens avtale - fakturamottaker, ikke standard Adaptic-avtale");
      const rutehint = raw.rute_kilde || "";
      const ruteHintVerdi: "A" | "B" | "" =
        /leietakerfakturering/i.test(rutehint) ? "A" : /stromkunde/i.test(normalized(rutehint)) ? "B" : "";
      rows.push({
        source_row: r,
        referansekode: raw.referansekode || "",
        kunde_hint: kundeHint,
        cloud_org: raw.cloud_org || "",
        org_nr: cleanId(raw.org_nr || "").slice(0, 9),
        selskapsnavn: raw.selskapsnavn || raw.kunde || "",
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
        rute_hint: ruteHintVerdi,
        krever_manuell_avklaring: krevManuellAvklaring,
        gyldig: problemer.length === 0,
        problemer,
      });
    }
    if (rows.length) sheets.push({ name: sheet.name, header_row: headerRow, rows });
  }

  return { sheets };
}

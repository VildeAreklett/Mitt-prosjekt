// Leser en signert Adaptic-strømavtale (tekst hentet fra PDF) og trekker ut
// kunde, kommersielle vilkår og alle målepunkt i "Anleggsopplysninger".
// Malen er fast (Strømavtale Adaptic Spot = rute B). Leietakeravtaler (rute A)
// har byggliste i stedet for målertabell, og gir da tomt rows-sett med en note.

export interface ParsedRow {
  adresse: string;
  maalenummer: string;
  maalepunkt_id: string;
  prisomrade: string;
  netteier: string;
  aarsforbruk_kwh: number | null;
  signert: boolean;
  gyldig: boolean;
  problem?: string;
}

export interface ParsedAvtale {
  kunde: string | null;
  org_nr: string | null;
  rute: "A" | "B" | null;
  paslag_ore_kwh: number | null;
  fast_pr_maaler: number | null;
  fast_aarspris: number | null;
  avtalt_oppstart: string | null; // ISO yyyy-mm-dd
  doc_ref: string | null;
  avtale_signert: boolean;
  rows: ParsedRow[];
  note?: string;
}

export function parseAvtale(raw: string): ParsedAvtale {
  const flat = raw.replace(/\r/g, " ").replace(/\n/g, " ").replace(/[ \t]+/g, " ").trim();

  const rute: "A" | "B" | null = /energikostnader til leietaker/i.test(flat)
    ? "A"
    : /str(ø|o)mavtale|adaptic spot|str(ø|o)mleveranse/i.test(flat)
      ? "B"
      : null;

  const orgM = flat.match(
    /for\s+([A-ZÆØÅ0-9][A-Za-zÆØÅæøå0-9 .&\-\/]+?)\s+med\s+org\.?\s*nr\.?:?\s*([0-9][0-9 ]{7,13})/,
  );
  const kunde = orgM ? orgM[1].trim() : null;
  const org_nr = orgM ? orgM[2].replace(/\D/g, "").slice(0, 9) : null;

  const pM = flat.match(/P(å|a)slag:?\s*([\d.,]+)\s*øre/i);
  const paslag_ore_kwh = pM ? parseFloat(pM[2].replace(",", ".")) : null;

  const fmM = flat.match(/Månedlig fastbeløp:?\s*kr\.?\s*([\d\s.,-]+)/i);
  let fast_pr_maaler: number | null = null;
  if (fmM) {
    const normalized = fmM[1].replace(/\s/g, "").replace(/,-?$/, "").replace(",", ".");
    const value = parseFloat(normalized);
    fast_pr_maaler = Number.isNaN(value) ? null : value;
  }

  const oM = flat.match(/Oppstart[^:]{0,60}?:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  const avtalt_oppstart = oM
    ? `${oM[3]}-${oM[2].padStart(2, "0")}-${oM[1].padStart(2, "0")}`
    : null;

  const dM = flat.match(/Document Ref:?\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,})/i);
  const doc_ref = dM ? dM[1] : null;
  const avtale_signert =
    /DOCUMENT COMPLETED BY ALL PARTIES/i.test(flat) ||
    /Signed with PandaDoc/i.test(flat) ||
    (/Signatur/i.test(flat) && (flat.match(/\bSIGNED\b/gi)?.length ?? 0) >= 2);

  let fast_aarspris: number | null = null;
  const faM = flat.match(/(?:LEIETAKERFAKTURERING|TOTAL ÅRSPRIS)[\s\S]{0,160}?kr\s*([\d .,]+)/i);
  if (rute === "A" && faM) {
    // Beløp kan være ført med tusenskille (mellomrom/punktum) og desimalkomma/-punktum.
    const num = faM[1].trim().replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const v = parseFloat(num);
    fast_aarspris = isNaN(v) ? null : Math.round(v);
  }

  // Isoler Anleggsopplysninger-seksjonen og kutt vekk kolonneoverskriftene.
  let seg = flat;
  const ai = seg.search(/Anleggsopplysninger/i);
  if (ai >= 0) seg = seg.slice(ai);
  const endM = seg.search(/\bOppstart\b|Document Ref|Leveringsbetingelser/i);
  if (endM > 0) seg = seg.slice(0, endM);
  const sig = seg.search(/Signert/i);
  if (sig >= 0) seg = seg.slice(sig + "Signert".length);

  const rowRe =
    /([A-Za-zÆØÅæøå][A-Za-zÆØÅæøå0-9 .\-]*?)\s+(\d{10,}|TBA)\s+(\d{18}|TBA)\s+(NO[1-5])\s+([A-Za-zÆØÅæøå][A-Za-zÆØÅæøå .\-]*?)\s+(\d[\d ]*?)\s+(Ja|Nei)\b/gi;
  const rows: ParsedRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(seg)) !== null) {
    const mp = m[3];
    const kwhRaw = m[6].replace(/\D/g, "");
    const kwh = kwhRaw ? parseInt(kwhRaw, 10) : NaN;
    const gyldig = /^\d{18}$/.test(mp);
    rows.push({
      adresse: m[1].trim(),
      maalenummer: m[2],
      maalepunkt_id: mp,
      prisomrade: m[4],
      netteier: m[5].trim(),
      aarsforbruk_kwh: isNaN(kwh) ? null : kwh,
      // Kolonnen «Signert» i anleggstabellen er ikke dokumentets signaturstatus.
      // PandaDoc-kvitteringen på siste side er kanonisk kilde for avtalen.
      signert: avtale_signert,
      gyldig,
      problem: gyldig ? undefined : "MålepunktID mangler (TBA) – kan ikke legges inn ennå",
    });
  }

  const note =
    rute === "A" && rows.length === 0
      ? "Leietakeravtale: fant byggliste, ikke en målertabell. Meld inn målere manuelt, eller last opp strøm-vedlegget."
      : rows.length === 0
        ? "Fant ingen målepunkt-tabell i avtalen. Sjekk at det er en Adaptic-strømavtale."
        : undefined;

  return {
    kunde,
    org_nr,
    rute,
    paslag_ore_kwh,
    fast_pr_maaler,
    fast_aarspris,
    avtalt_oppstart,
    doc_ref,
    avtale_signert,
    rows,
    note,
  };
}

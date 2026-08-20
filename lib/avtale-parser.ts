// Leser en signert Adaptic-strømavtale (PDF) og trekker ut kunde, kommersielle
// vilkår og alle målepunkt i "Anleggsopplysninger" - samt en kort, fri
// oppsummering av alt som avviker fra standardavtalen (uvanlige klausuler,
// forbehold, spesielle vilkår), slik at ingen trenger å lese hele avtalen
// selv for å fange opp det som faktisk er verdt å vite.
//
// Tidligere versjon var en fast regex-basert malgjenkjenner (fungerte kun på
// de faste feltene den lette etter, og så ALDRI noe utenfor de feltene - f.eks.
// en klausul om at påslaget kan justeres hvis kundens Adaptic Cloud-avtale
// sies opp, som dukket opp i én avtale men ikke andre). Leser nå hele PDF-en
// direkte med Claude (samme tilnærming som strømfaktura-leseren i
// faktura-parser.ts), som faktisk kan vurdere innholdet i stedet for bare å
// mønstergjenkjenne det.

import Anthropic from "@anthropic-ai/sdk";

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
  // Fritekst-oppsummering av alt som avviker fra standard Adaptic-vilkår,
  // eller andre ting som er verdt å kommentere på målepunktene (f.eks.
  // forbehold, spesielle klausuler, uvanlige beløp). Tom streng hvis avtalen
  // er en helt vanlig standardavtale uten noe å bemerke.
  kommentar_forslag: string;
}

const TOOL_NAME = "lagre_avtale_data";

const EXTRACTION_PROMPT = `Dette er en signert Adaptic-strømavtale (PDF, "Strømavtale Adaptic Spot Næring"
for rute B/rent strømsalg, eller en leietakerfaktureringsavtale for rute A).
Les hele dokumentet, inkludert signatursertifikatet på siste side, og kall
verktøyet ${TOOL_NAME} med feltene:

- kunde: kundens firmanavn (selskapet på motsatt side av Adaptic Technology AS)
- org_nr: kundens organisasjonsnummer, kun 9 siffer
- rute: "B" hvis dette er en ren strømsalgsavtale ("Strømavtale", "Adaptic
  Spot", "Strømleveranse"), "A" hvis dette er en leietakerfaktureringsavtale
  (kunden fakturerer egne leietakere, avtalen har en byggliste i stedet for
  en måler-tabell med MålepunktID). Bruk null hvis du er usikker.
- paslag_ore_kwh: påslag i øre/kWh (kun rute B), tallverdi
- fast_pr_maaler: månedlig fastbeløp per måler i kr (kun rute B, hvis oppgitt), tallverdi
- fast_aarspris: total årspris for leietakerfakturering i kr (kun rute A), tallverdi
- avtalt_oppstart: oppstartsdato for strømleveransen i format YYYY-MM-DD, slik
  den står under overskriften "Oppstart" (f.eks. "Oppstart av strømleveransen
  fra Adaptic Technology AS: 1.5.2026" -> "2026-05-01")
- doc_ref: dokumentreferansen (Document Ref / REF. NUMBER), f.eks.
  "EI7UE-NQUNZ-NFDZJ-VJZA3"
- avtale_signert: true kun hvis signatursertifikatet på siste side viser at
  BEGGE parter faktisk har signert (se etter "DOCUMENT COMPLETED BY ALL
  PARTIES" og to fullførte SIGNED-tidsstempler). IKKE stol på en eventuell
  "Signert"-kolonne i selve anleggstabellen - den er ofte bare en mal-rest og
  reflekterer ikke faktisk signaturstatus.
- rows: én rad per anlegg i "Anleggsopplysninger"-tabellen (gjelder rute B),
  med feltene:
  - adresse: adressen for anlegget
  - maalenummer: målernummer
  - maalepunkt_id: MålepunktID/EAN - skal være nøyaktig 18 siffer. Hvis
    feltet står som "TBA" eller er tomt i tabellen, sett maalepunkt_id til
    tom streng, gyldig til false, og problem til "MålepunktID mangler (TBA) -
    kan ikke legges inn ennå".
  - prisomrade: NO1-NO5
  - netteier: netteiers navn
  - aarsforbruk_kwh: årsforbruk i kWh, heltall
  - gyldig: true med mindre maalepunkt_id mangler (se over)
  - problem: kun satt hvis gyldig er false
  Hvis avtalen er rute A (leietakerfakturering) og har byggliste i stedet for
  målertabell, returner en tom rows-liste.
- note: valgfri kort tekst KUN hvis du ikke fant noen anleggstabell i det hele
  tatt (f.eks. "Fant ingen målepunkt-tabell i avtalen. Sjekk at det er en
  Adaptic-strømavtale."), eller hvis det er en leietakeravtale uten
  målertabell ("Leietakeravtale: fant byggliste, ikke en målertabell. Meld inn
  målere manuelt, eller last opp strøm-vedlegget."). Ellers null.
- kommentar_forslag: KORT (1-2 setninger) fritekst-oppsummering av alt i
  avtalen som AVVIKER fra en helt standard Adaptic-strømavtale, eller som
  ellers er verdt å vite når man senere ser på dette målepunktet i registeret
  - f.eks. uvanlige forbehold, klausuler om at vilkår kan endres under gitte
  betingelser, spesielle betalingsbetingelser, eller andre avvik fra det som
  er standard i Adaptic sine avtaler. IKKE gjenta standardvilkår som allerede
  fanges opp i de andre feltene (påslag, oppstart, signatur osv.) eller
  helt vanlige klausuler du forventer å se i enhver strømavtale (oppsigelsestid,
  betalingsbetingelser på 14 dager, mva-forbehold, generell fullmakt til
  leverandørskifte). Returner tom streng "" hvis avtalen er en helt
  standard/vanlig avtale uten noe spesielt å bemerke - ikke finn på noe å si.

Tallformat: norsk format (komma som desimaltegn) - IKKE amerikansk format.`;

export async function parseAvtalePdf(bytes: Uint8Array): Promise<ParsedAvtale> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Mangler ANTHROPIC_API_KEY. Sett den i .env.local (og i Vercel for produksjon) for å lese avtaler automatisk."
    );
  }

  const anthropic = new Anthropic({ apiKey });
  const base64 = Buffer.from(bytes).toString("base64");

  const rowSchema = {
    type: "object",
    properties: {
      adresse: { type: "string" },
      maalenummer: { type: "string" },
      maalepunkt_id: { type: "string" },
      prisomrade: { type: "string" },
      netteier: { type: "string" },
      aarsforbruk_kwh: { type: ["number", "null"] },
      gyldig: { type: "boolean" },
      problem: { type: ["string", "null"] },
    },
    required: ["adresse", "maalenummer", "maalepunkt_id", "prisomrade", "netteier", "gyldig"],
  };

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    tools: [
      {
        name: TOOL_NAME,
        description: "Lagre strukturerte data hentet ut fra en signert Adaptic-strømavtale.",
        input_schema: {
          type: "object",
          properties: {
            kunde: { type: ["string", "null"] },
            org_nr: { type: ["string", "null"] },
            rute: { type: ["string", "null"], enum: ["A", "B", null] },
            paslag_ore_kwh: { type: ["number", "null"] },
            fast_pr_maaler: { type: ["number", "null"] },
            fast_aarspris: { type: ["number", "null"] },
            avtalt_oppstart: { type: ["string", "null"] },
            doc_ref: { type: ["string", "null"] },
            avtale_signert: { type: "boolean" },
            rows: { type: "array", items: rowSchema },
            note: { type: ["string", "null"] },
            kommentar_forslag: { type: "string" },
          },
          required: ["kunde", "org_nr", "rute", "avtale_signert", "rows", "kommentar_forslag"],
        },
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const toolUse = message.content.find((b) => b.type === "tool_use" && b.name === TOOL_NAME);
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Fikk ikke strukturert svar fra Claude - prøv igjen eller last opp avtalen på nytt.");
  }

  const raw = toolUse.input as Record<string, unknown>;
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  const avtale_signert = !!raw.avtale_signert;

  const rows: ParsedRow[] = rawRows.map((item) => {
    const r = item as Record<string, unknown>;
    const maalepunkt_id = String(r.maalepunkt_id ?? "").replace(/\s/g, "");
    const gyldig = typeof r.gyldig === "boolean" ? r.gyldig : /^\d{18}$/.test(maalepunkt_id);
    return {
      adresse: String(r.adresse ?? "").trim(),
      maalenummer: String(r.maalenummer ?? "").replace(/\s/g, ""),
      maalepunkt_id,
      prisomrade: String(r.prisomrade ?? "").trim(),
      netteier: String(r.netteier ?? "").trim(),
      aarsforbruk_kwh: typeof r.aarsforbruk_kwh === "number" ? r.aarsforbruk_kwh : null,
      // Kolonnen "Signert" i selve anleggstabellen er ikke dokumentets
      // signaturstatus - PandaDoc-kvitteringen (avtale_signert) er kanonisk.
      signert: avtale_signert,
      gyldig,
      problem: r.problem ? String(r.problem) : (gyldig ? undefined : "MålepunktID mangler (TBA) - kan ikke legges inn ennå"),
    };
  });

  return {
    kunde: raw.kunde ? String(raw.kunde).trim() : null,
    org_nr: raw.org_nr ? String(raw.org_nr).replace(/\D/g, "").slice(0, 9) : null,
    rute: raw.rute === "A" || raw.rute === "B" ? raw.rute : null,
    paslag_ore_kwh: typeof raw.paslag_ore_kwh === "number" ? raw.paslag_ore_kwh : null,
    fast_pr_maaler: typeof raw.fast_pr_maaler === "number" ? raw.fast_pr_maaler : null,
    fast_aarspris: typeof raw.fast_aarspris === "number" ? raw.fast_aarspris : null,
    avtalt_oppstart: raw.avtalt_oppstart ? String(raw.avtalt_oppstart) : null,
    doc_ref: raw.doc_ref ? String(raw.doc_ref) : null,
    avtale_signert,
    rows,
    note: raw.note ? String(raw.note) : undefined,
    kommentar_forslag: raw.kommentar_forslag ? String(raw.kommentar_forslag).trim() : "",
  };
}

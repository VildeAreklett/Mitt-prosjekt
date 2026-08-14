// Leser en inngående strømfaktura (PDF, ofte skannet uten tekstlag) og
// trekker ut det selger i dag må lete opp og skrive inn for hånd på avtalen:
// målenummer, MålepunktID, anleggsadresse, netteier og årsforbruk.
//
// Strømfakturaer har IKKE et felles oppsett slik signerte Adaptic-avtaler har
// (hver netteier/kraftleverandør har sin egen mal - sammenlign en faktura fra
// Entelios/Glitre Nett med en fra Lnett, de har ingenting til felles bortsett
// fra hvilke opplysninger som finnes). Et fast tekstuttrekk (som avtale-parser.ts
// bruker) er derfor ikke robust nok her, og fakturaene er ofte skannet uten
// tekstlag i det hele tatt. Vi sender derfor PDF-en direkte til Claude
// (native PDF-støtte i Messages API) og ber om strukturert JSON tilbake.
//
// Prisområde står ALDRI på selve fakturaen - det slås opp separat fra
// adressen via /api/netteier (samme oppslag som brukes ved manuell
// registrering), se bruken i app/stromflyt/page.tsx.

import Anthropic from "@anthropic-ai/sdk";

export interface ParsedFaktura {
  kundenr_hos_leverandor: string;
  malenummer: string;
  malepunkt_id: string;
  adresse: string;
  postnr: string;
  poststed: string;
  netteier: string;
  arsforbruk_kwh: number | null;
  fakturadato: string;
  usikre_felt: string[];
}

const TOOL_NAME = "lagre_faktura_data";

const EXTRACTION_PROMPT = `Dette er en strømfaktura fra en norsk netteier eller kraftleverandør (skannet eller
tekstbasert PDF, ett eller flere sider). Les ut følgende felt og kall verktøyet
${TOOL_NAME} med resultatet:

- kundenr_hos_leverandor: kundenummer/kontonummer hos netteier eller
  kraftleverandør (IKKE Adaptic sitt eget kundenummer - dette er kundens
  nåværende leverandørforhold, før overtakelse)
- malenummer: målernummer / serienummer på selve måleren
- malepunkt_id: MålepunktID / EAN / GSRN / "fakturamerke" - skal være nøyaktig
  18 siffer (Elhub-standard). Noen fakturaer viser en kortere intern ID i
  tillegg til den fulle 18-sifrede - bruk alltid den fulle 18-sifrede når begge
  finnes.
- adresse: gateadresse til anlegget/leveringspunktet (ikke fakturamottakers
  postadresse hvis den er en annen)
- postnr: postnummer for anlegget
- poststed: poststed for anlegget
- netteier: navnet på netteier (nettselskapet), ikke kraftleverandøren, hvis de
  er forskjellige
- arsforbruk_kwh: forventet/antatt årsforbruk i kWh hvis oppgitt, ellers null
  (bruk periodeforbruket × årsfaktor KUN hvis et eksplisitt årsforbrukstall
  ikke finnes noe sted - merk det da som usikkert)
- fakturadato: fakturadato i format DD.MM.YYYY slik den står på fakturaen
- usikre_felt: navn på feltene over du var usikker på eller måtte gjette deg
  til (tom liste hvis alt var tydelig)

Prisområde (NO1-NO5) står ALDRI på en strømfaktura - ikke prøv å gjette det,
det slås opp separat fra adressen.`;

export async function parseFakturaPdf(bytes: Uint8Array): Promise<ParsedFaktura> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Mangler ANTHROPIC_API_KEY. Sett den i .env.local (og i Vercel for produksjon) for å lese strømfakturaer automatisk."
    );
  }

  const anthropic = new Anthropic({ apiKey });
  const base64 = Buffer.from(bytes).toString("base64");

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    tools: [
      {
        name: TOOL_NAME,
        description: "Lagre strukturerte data hentet ut fra en strømfaktura.",
        input_schema: {
          type: "object",
          properties: {
            kundenr_hos_leverandor: { type: "string" },
            malenummer: { type: "string" },
            malepunkt_id: { type: "string" },
            adresse: { type: "string" },
            postnr: { type: "string" },
            poststed: { type: "string" },
            netteier: { type: "string" },
            arsforbruk_kwh: { type: ["number", "null"] },
            fakturadato: { type: "string" },
            usikre_felt: { type: "array", items: { type: "string" } },
          },
          required: ["malenummer", "malepunkt_id", "adresse", "netteier"],
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
    throw new Error("Fikk ikke strukturert svar fra Claude - prøv igjen eller last opp fakturaen på nytt.");
  }

  const raw = toolUse.input as Record<string, unknown>;
  return {
    kundenr_hos_leverandor: String(raw.kundenr_hos_leverandor ?? ""),
    malenummer: String(raw.malenummer ?? "").replace(/\s/g, ""),
    malepunkt_id: String(raw.malepunkt_id ?? "").replace(/\s/g, ""),
    adresse: String(raw.adresse ?? ""),
    postnr: String(raw.postnr ?? ""),
    poststed: String(raw.poststed ?? ""),
    netteier: String(raw.netteier ?? ""),
    arsforbruk_kwh: typeof raw.arsforbruk_kwh === "number" ? raw.arsforbruk_kwh : null,
    fakturadato: String(raw.fakturadato ?? ""),
    usikre_felt: Array.isArray(raw.usikre_felt) ? raw.usikre_felt.map(String) : [],
  };
}

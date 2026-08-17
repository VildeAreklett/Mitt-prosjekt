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
// adressen via /api/netteier, se bruken i app/stromflyt/page.tsx.
//
// VIKTIG: én PDF kan inneholde MER ENN ÉN faktura/måler - f.eks. en
// samlefaktura for flere anlegg, eller (sett i praksis) to helt separate
// fakturaer fra to ulike selskaper limt sammen i én fil. Derfor returnerer
// dette alltid en LISTE, aldri et enkelt objekt.

import Anthropic from "@anthropic-ai/sdk";

export interface ParsedFakturaRow {
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

const EXTRACTION_PROMPT = `Dette er én eller flere strømfakturaer fra norske netteiere/kraftleverandører
(skannet eller tekstbasert PDF). VIKTIG: dokumentet kan inneholde MER ENN ÉN
faktura/måler - f.eks. en samlefaktura for flere anlegg, flere adresser i
samme fil, eller (forekommer i praksis) to helt separate fakturaer fra to
ulike selskaper limt sammen i samme PDF. Se etter tegn på dette: flere
avsendere/fakturanumre, flere "Måler nr"/"Målernummer"/MålepunktID-verdier,
eller flere leveringsadresser. IKKE slå sammen flere målere til én rad, og
IKKE returner bare den første du finner - identifiser HVER unike måler/
MålepunktID i dokumentet og returner én rad per unike måler i "fakturaer"-listen.

For hver rad, kall verktøyet ${TOOL_NAME} med feltene:

- kundenr_hos_leverandor: kundenummer/kontonummer hos netteier eller
  kraftleverandør (IKKE Adaptic sitt eget kundenummer - dette er kundens
  nåværende leverandørforhold, før overtakelse)
- malenummer: målernummer / serienummer på selve måleren
- malepunkt_id: MålepunktID / EAN / GSRN / "fakturamerke" / "Anl id" - skal
  være nøyaktig 18 siffer (Elhub-standard). Noen fakturaer viser en kortere
  intern ID i tillegg til den fulle 18-sifrede - bruk alltid den fulle
  18-sifrede når begge finnes.
- adresse: gateadresse til anlegget/leveringspunktet/leveringsstedet (ikke
  fakturamottakers postadresse hvis den er en annen)
- postnr: postnummer for anlegget
- poststed: poststed for anlegget
- netteier: navnet på netteier (nettselskapet), ikke kraftleverandøren, hvis
  de er forskjellige. Bruk gjeldende navn hvis fakturaen viser "(tidligere
  X)" i parentes - ikke det gamle navnet.
- arsforbruk_kwh: forventet/antatt årsforbruk i kWh hvis oppgitt eksplisitt
  (f.eks. "Forventet forbruk X kWh/år" eller "Antatt årsforbruk"), ellers
  null. IKKE regn ut et årstall selv fra ett enkelt måneds- eller
  periodeforbruk i linjetabellen - bruk kun et eksplisitt oppgitt årstall,
  og merk feltet som usikkert i usikre_felt hvis du måtte anslå det.
- fakturadato: fakturadato i format DD.MM.YYYY slik den står på fakturaen
- usikre_felt: navn på feltene over du var usikker på eller måtte gjette deg
  til (tom liste hvis alt var tydelig)

Tallformat: fakturaene bruker NORSK tallformat (komma som desimaltegn,
mellomrom eller punktum som tusenskilletegn) - IKKE amerikansk format. Tolk
f.eks. "1 594,80" eller "1.594,80" som ett tusen fem hundre og nittifire
komma åtti, ikke som et helt annet tall. Vær spesielt nøye med antall nuller
når du leser av kWh-forbrukstall.

Prisområde (NO1-NO5) står ALDRI på en strømfaktura - ikke prøv å gjette det,
det slås opp separat fra adressen.`;

export async function parseFakturaPdf(bytes: Uint8Array): Promise<ParsedFakturaRow[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Mangler ANTHROPIC_API_KEY. Sett den i .env.local (og i Vercel for produksjon) for å lese strømfakturaer automatisk."
    );
  }

  const anthropic = new Anthropic({ apiKey });
  const base64 = Buffer.from(bytes).toString("base64");

  const rowSchema = {
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
  };

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    tools: [
      {
        name: TOOL_NAME,
        description: "Lagre strukturerte data hentet ut fra én eller flere strømfakturaer/målere funnet i dokumentet.",
        input_schema: {
          type: "object",
          properties: {
            fakturaer: { type: "array", items: rowSchema, minItems: 1 },
          },
          required: ["fakturaer"],
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
  const list = Array.isArray(raw.fakturaer) ? raw.fakturaer : [];
  if (!list.length) {
    throw new Error("Fant ingen målepunkt i dokumentet.");
  }

  return list.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      kundenr_hos_leverandor: String(r.kundenr_hos_leverandor ?? ""),
      malenummer: String(r.malenummer ?? "").replace(/\s/g, ""),
      malepunkt_id: String(r.malepunkt_id ?? "").replace(/\s/g, ""),
      adresse: String(r.adresse ?? ""),
      postnr: String(r.postnr ?? ""),
      poststed: String(r.poststed ?? ""),
      netteier: String(r.netteier ?? ""),
      arsforbruk_kwh: typeof r.arsforbruk_kwh === "number" ? r.arsforbruk_kwh : null,
      fakturadato: String(r.fakturadato ?? ""),
      usikre_felt: Array.isArray(r.usikre_felt) ? r.usikre_felt.map(String) : [],
    };
  });
}

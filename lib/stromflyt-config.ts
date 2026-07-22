// Strømflyt: typer, konstanter og validering. Rammeverk-uavhengig.
// Kanonisk kilde er workspaces/stromflyt/konfigurasjon/. Hold i synk med den.

export type Rute = "A" | "B";

export type Status =
  | "Kladd"
  | "Innmeldt"
  | "Klar for bestilling"
  | "Sendt Entelios"
  | "Bekreftet"
  | "Satt opp i Cloud"
  | "Aktiv";

export const STAGES: Status[] = [
  "Kladd",
  "Innmeldt",
  "Klar for bestilling",
  "Sendt Entelios",
  "Bekreftet",
  "Satt opp i Cloud",
  "Aktiv",
];

// Nedtrekksverdier. Erstatt med live-uttrekk fra Adaptic Cloud lese-API når det er koblet.
export const CLOUD_ORGS: string[] = [
  "Strømkunder",
  "EGD Property AS",
  "Pareto Business Management AS",
  "Bergens Traverbane AS",
  "FAV Eiendomsutvikling AS",
  "Hathon Eiendom",
];

export const NETTEIERE: string[] = [
  "BKK",
  "Elvia",
  "Norgesnett",
  "Lede",
  "Tensio",
  "Glitre Nett",
  "L-nett",
  "Linja",
];

export const PRISOMRADER = ["NO1", "NO2", "NO3", "NO4", "NO5"] as const;

export interface Malepunkt {
  id: string;
  kunde: string;
  org_nr: string;
  selger: string;
  cloud_org: string;
  bygg: string;
  adresse: string;
  maalenummer: string;
  maalepunkt_id: string;
  netteier: string;
  prisomrade: string;
  aarsforbruk_kwh: number | null;
  avtalt_oppstart: string; // ISO date
  at_kode: string;
  rute: Rute | "";
  paslag_ore_kwh: number | null;
  fast_pr_maaler: number | null;
  fast_aarspris: number | null;
  signert: boolean;
  kommentar: string;
  status: Status;
  entelios_ref: string;
  created_at?: string;
  updated_at?: string;
}

export function nextStatus(s: Status): Status | null {
  const i = STAGES.indexOf(s);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

export function previousStatus(s: Status): Status | null {
  const i = STAGES.indexOf(s);
  return i > 0 ? STAGES[i - 1] : null;
}

// Validering. Returnerer { felt: feilmelding } for ugyldige felt.
export function validateMalepunkt(m: Partial<Malepunkt>): Record<string, string> {
  const e: Record<string, string> = {};
  const req = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";

  if (!req(m.kunde)) e.kunde = "Påkrevd.";
  if (!/^[0-9]{9}$/.test(String(m.org_nr ?? "").trim())) e.org_nr = "Org.nr må være 9 siffer.";
  if (!req(m.cloud_org)) e.cloud_org = "Velg organisasjon.";
  if (!req(m.bygg)) e.bygg = "Påkrevd.";
  if (!req(m.adresse)) e.adresse = "Påkrevd.";
  if (!req(m.maalenummer)) e.maalenummer = "Påkrevd.";
  if (!/^[0-9]{18}$/.test(String(m.maalepunkt_id ?? "").trim()))
    e.maalepunkt_id = "MålepunktID må være nøyaktig 18 siffer.";
  if (!req(m.netteier)) e.netteier = "Velg netteier.";
  if (!PRISOMRADER.includes(String(m.prisomrade) as (typeof PRISOMRADER)[number]))
    e.prisomrade = "Velg prisområde.";
  if (!/^[0-9]+$/.test(String(m.aarsforbruk_kwh ?? "").trim()))
    e.aarsforbruk_kwh = "Årsforbruk må være et helt tall (kWh).";
  if (!req(m.avtalt_oppstart)) e.avtalt_oppstart = "Velg oppstartsdato.";
  if (!req(m.at_kode)) e.at_kode = "Påkrevd.";
  if (!m.signert) e.signert = "Avtalen må være signert før innmelding.";

  if (m.rute !== "A" && m.rute !== "B") {
    e.rute = "Velg rute A eller B.";
  } else if (m.rute === "B") {
    if (!/^[0-9]+([.,][0-9]+)?$/.test(String(m.paslag_ore_kwh ?? "").trim()))
      e.paslag_ore_kwh = "Påslag i øre/kWh.";
  } else if (m.rute === "A") {
    if (!/^[0-9]+$/.test(String(m.fast_aarspris ?? "").trim()))
      e.fast_aarspris = "Fast årspris i kr.";
  }
  return e;
}

export function kommersielt(m: Malepunkt): string {
  if (m.rute === "A") return `Årspris ${fmt(m.fast_aarspris)} kr`;
  let s = `${m.paslag_ore_kwh ?? "?"} øre/kWh`;
  if (m.fast_pr_maaler && m.fast_pr_maaler > 0) s += ` + ${fmt(m.fast_pr_maaler)}/mnd`;
  return s;
}

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(Number(n))) return "-";
  return Number(n).toLocaleString("nb-NO");
}

// Kolonner Entelios trenger, jf. stages/03/references/entelios-bestillingsformat.md
export const ENTELIOS_COLUMNS: { key: keyof Malepunkt; label: string }[] = [
  { key: "kunde", label: "Selskapsnavn" },
  { key: "org_nr", label: "Org.nr" },
  { key: "adresse", label: "Adresse" },
  { key: "maalenummer", label: "Målenummer" },
  { key: "maalepunkt_id", label: "MålepunktID" },
  { key: "netteier", label: "Netteier" },
  { key: "prisomrade", label: "Prisområde" },
  { key: "aarsforbruk_kwh", label: "Årsforbruk (kWh)" },
  { key: "avtalt_oppstart", label: "Oppstartdato" },
  { key: "at_kode", label: "Referansekode" },
];

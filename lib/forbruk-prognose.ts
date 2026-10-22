// Beregner et helårs-forbruk (kWh) fra månedlige måledata i Adaptic Cloud.
//
// Har måleren minst 12 FULLE måneder med data, er svaret rett og slett summen
// av de siste 12 hele månedene (målt, ikke prognose). Har den kortere
// historikk (nye målere), regnes målt forbruk opp til helår med en sesongprofil
// i stedet for å la summen av noen få måneder stå som «årsforbruk» - det ga
// f.eks. Georgernes Verft 12 (data fra juni 2026) 336 303 kWh der et helår
// ligger langt høyere.
//
// Sesongprofilen er andelen av årsforbruket som typisk faller i hver
// kalendermåned, kalibrert 22.10.2026 mot fire målere med komplett år
// (okt. 2025 - sep. 2026) i Adaptic Cloud: Holtermandsvegen 15, Lund Asker,
// Lund Skytta og Nordhordland Folkehøgskole (BKK/Elvia, hovedsakelig elektrisk
// oppvarming). Den er sterkt sesongpreget (januar ~15 %, juli ~3 %) og passer
// derfor dårligere for jevne laster (f.eks. ladeanlegg) - og en prognose basert
// på bare sommermåneder er svært usikker. Rekalibrer når flere målere har
// fullt år.

export const MAANEDSPROFIL: Record<number, number> = {
  1: 0.1521, 2: 0.1185, 3: 0.1091, 4: 0.086, 5: 0.0565, 6: 0.0415,
  7: 0.0342, 8: 0.0421, 9: 0.059, 10: 0.0813, 11: 0.1083, 12: 0.1114,
};

export type Sikkerhet = "malt" | "middels" | "lav" | "svaert-lav";

export interface Prognose {
  aarskwh: number;        // helår (målt hvis 12 mnd, ellers sesongjustert prognose)
  maaneder: number;       // antall hele måneder med målinger som ligger til grunn
  fra: string | null;     // første måned som er med, "YYYY-MM"
  til: string | null;     // siste måned som er med, "YYYY-MM"
  maalt_kwh: number;      // summen av det som faktisk er målt i disse månedene
  sikkerhet: Sikkerhet;
}

export interface MaanedPunkt {
  ts?: string;
  timestamp?: string;
  value: number | null;
}

function maanedsnokkel(p: MaanedPunkt): string | null {
  const s = p.ts || p.timestamp;
  return s && /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
}

function naaMaaned(naa: Date): string {
  return naa.toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" }).slice(0, 7);
}

export function sikkerhetForMaaneder(n: number): Sikkerhet {
  if (n >= 12) return "malt";
  if (n >= 6) return "middels";
  if (n >= 3) return "lav";
  return "svaert-lav";
}

export function beregnPrognose(punkter: MaanedPunkt[], naa: Date = new Date()): Prognose | null {
  const inneværende = naaMaaned(naa);
  const alle = punkter
    .map((p) => ({ k: maanedsnokkel(p), v: p.value }))
    .filter((p): p is { k: string; v: number | null } => !!p.k && p.k < inneværende)
    .sort((a, b) => a.k.localeCompare(b.k));

  const forsteMedData = alle.findIndex((p) => typeof p.v === "number");
  if (forsteMedData < 0) return null;

  // Startet måleren midt i vinduet (det finnes måneder UTEN data før første
  // måling) er første måned nesten alltid en delmåned - ikke ta den med.
  let brukbare = alle.slice(forsteMedData).filter((p) => typeof p.v === "number") as { k: string; v: number }[];
  if (forsteMedData > 0 && brukbare.length > 1) brukbare = brukbare.slice(1);
  if (!brukbare.length) return null;

  const siste12 = brukbare.slice(-12);
  const maalt = siste12.reduce((s, p) => s + p.v, 0);
  const fra = siste12[0].k;
  const til = siste12[siste12.length - 1].k;

  if (siste12.length >= 12) {
    return { aarskwh: Math.round(maalt), maaneder: 12, fra, til, maalt_kwh: Math.round(maalt), sikkerhet: "malt" };
  }

  const andel = siste12.reduce((s, p) => s + (MAANEDSPROFIL[Number(p.k.slice(5, 7))] ?? 0), 0);
  if (andel <= 0.02) return null;
  return {
    aarskwh: Math.round(maalt / andel),
    maaneder: siste12.length,
    fra,
    til,
    maalt_kwh: Math.round(maalt),
    sikkerhet: sikkerhetForMaaneder(siste12.length),
  };
}

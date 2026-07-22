// Utled prisområde (NO1-NO5) fra norsk postnummer.
// Dette er en beste-gjetning basert på region. Grensene følger ikke postnummer
// helt eksakt, så verdien er et FORSLAG brukeren kan overstyre i nedtrekket.

export function prisomradeFromPostnr(postnr?: string | number | null): string | null {
  const n = parseInt(String(postnr ?? "").trim().slice(0, 4), 10);
  if (isNaN(n)) return null;
  if (n <= 3699) return "NO1"; // Oslo, Viken, Innlandet, Vestfold/Buskerud
  if (n <= 3999) return "NO2"; // Telemark/Grenland
  if (n <= 4999) return "NO2"; // Agder og Rogaland
  if (n <= 5999) return "NO5"; // Vestland/Bergen
  if (n <= 6699) return "NO3"; // Sunnmøre og Romsdal
  if (n <= 6999) return "NO5"; // Nordfjord og Sogn
  if (n <= 7999) return "NO3"; // Trøndelag
  if (n <= 9999) return "NO4"; // Nordland, Troms og Finnmark
  return null;
}

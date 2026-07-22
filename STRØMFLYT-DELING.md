# Strømflyt i mitt-prosjekt

Drop-in-filer for Next.js-appen (App Router + Supabase + Vercel), samme stack som fakturakontroll.

## Filer

```
sql/schema.sql                 -> kjøres i Supabase SQL Editor
lib/stromflyt-config.ts        -> typer, konstanter, validering (kopier til lib/)
lib/supabaseClient.ts          -> Supabase-klient (gjenbruk din egen om du har en)
lib/stromflyt-api.ts           -> dataaksess mot tabellen
lib/avtale-parser.ts           -> trekker felter og målepunkt fra Adaptic-avtaler
lib/excel-parser.ts            -> finner faner, kolonner og målepunkt i gammel arbeidsbok
app/api/avtale/parse/route.ts  -> PDF-lesing på serveren
app/api/excel/parse/route.ts   -> Excel-lesing på serveren
app/stromflyt/page.tsx         -> register + innmelding + PDF-/Excel-import, rute /stromflyt
```

## Steg

1. **Database.** Åpne Supabase-prosjektet -> SQL Editor -> lim inn og kjør `sql/schema.sql`. Det lager tabellen `strombestillinger` med validering, unik MålepunktID og RLS.

2. **Pakker.** Installer Supabase-klienten og PDF-leseren:
   ```bash
   npm install @supabase/supabase-js unpdf exceljs
   ```

3. **Env-variabler.** I `.env.local` (og i Vercel -> Settings -> Environment Variables):
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   ```
   Restart `npm run dev` etter endring. Har du allerede disse fra fakturakontroll, gjenbruk dem og slett `lib/supabaseClient.ts` (bruk din eksisterende klient i `lib/stromflyt-api.ts`).

4. **Kopier filene** inn i `mitt-prosjekt` med samme mappestruktur.

5. **Test.** `npm run dev`, gå til `/stromflyt`. Dra inn en signert PDF-avtale eller den gamle `.xlsx`-arbeidsboken, kontroller funnene og legg de valgte målepunktene i registeret. Prøv også statusflyten og «Lag Entelios-batch».

## Merk

- **Innlogging:** RLS-policyen krever innlogget bruker (`authenticated`). Har ikke appen Supabase Auth ennå, kan du midlertidig endre policyen i `schema.sql` til rollen `anon` for testing, men slå på auth før produksjon med ekte kundedata.
- **Nedtrekk fra Cloud:** `CLOUD_ORGS` og `NETTEIERE` i `stromflyt-config.ts` er en startliste. Bytt til live-uttrekk fra Adaptic Cloud lese-API når det er koblet, så matcher navnene alltid.
- **Kanonisk kilde:** feltdefinisjon og statuser følger `workspaces/stromflyt/konfigurasjon/`. Endres modellen der, oppdater `stromflyt-config.ts` og `schema.sql`.
- **Entelios-eksport:** «Kopier» gir TSV som limes rett i regneark eller mail. Når Entelios-API/importformat er avklart (se møteagendaen), bytt ut kopier-knappen med programmatisk innsending.

## Før plattformen deles

1. Åpne Supabase -> Authentication -> Users -> Add user. Opprett én bruker for deg og én for kollegaen. Bruk midlertidige passord som dere bytter sikkert.
2. Åpne Supabase -> SQL Editor og kjør hele `sql/migration-002-auth-history.sql`. Dette fjerner anonym tilgang og aktiverer automatisk endringshistorikk.
3. Legg til denne linjen i `.env.local`:
   ```
   NEXT_PUBLIC_REQUIRE_AUTH=true
   ```
4. Restart `npm run dev`, logg inn og kontroller at register, redigering og Historikk fungerer.
5. I Vercel-prosjektet, legg til de samme tre offentlige miljøvariablene:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   NEXT_PUBLIC_REQUIRE_AUTH=true
   ```
6. Push endringene til GitHub. Hvis Vercel-prosjektet er koblet til repoet, publiseres ny versjon automatisk. Ellers velger du Add New -> Project i Vercel og importerer `VildeAreklett/Mitt-prosjekt`.

Ikke legg `.env.local` i Git. Den er allerede ekskludert av `.gitignore`.

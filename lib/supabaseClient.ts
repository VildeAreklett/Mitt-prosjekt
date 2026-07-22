// Supabase-klient for strømflyt.
// Peker på strømflyt sitt EGET Supabase-prosjekt (Test prosjekt 1), holdt adskilt
// fra andre moduler som fakturakontroll (Test prosjekt 2).
//
// Sett i .env.local:
//   NEXT_PUBLIC_STROMFLYT_SUPABASE_URL=...
//   NEXT_PUBLIC_STROMFLYT_SUPABASE_ANON_KEY=...
// Faller tilbake på de generelle NEXT_PUBLIC_SUPABASE_* hvis de spesifikke ikke er satt.

import { createClient } from "@supabase/supabase-js";

const url =
  process.env.NEXT_PUBLIC_STROMFLYT_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey =
  process.env.NEXT_PUBLIC_STROMFLYT_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Mangler Supabase-nøkler for strømflyt. Sett NEXT_PUBLIC_STROMFLYT_SUPABASE_URL " +
      "og NEXT_PUBLIC_STROMFLYT_SUPABASE_ANON_KEY i .env.local (og i Vercel for produksjon)."
  );
}

export const supabase = createClient(url, anonKey);

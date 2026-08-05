"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Supabase-invitasjoner kan lande på rotadressen enten med tokens i URL-fragmentet
// (#access_token=...&type=invite, eldre implicit-flyt) eller som en ?code=...&type=invite
// spørrestreng (PKCE-flyt, standard i nyere Supabase-prosjekter). Send begge videre til
// Strømflyt og behold BÅDE søk og fragment slik at Supabase-klienten kan opprette
// sesjonen og la brukeren velge passord - før var kun fragmentet med, som gjorde at
// ?code=-lenker mistet koden sin og brukeren havnet rett på vanlig innlogging.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const hashType = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("type");
    const searchType = new URLSearchParams(window.location.search).get("type");
    const authType = hashType || searchType;
    if (authType === "invite" || authType === "recovery") {
      // Supabase-klienten kan rydde tokenet fra adressen når neste side
      // starter. Behold derfor en ufarlig markør som sikrer passordsteget.
      window.sessionStorage.setItem("stromflyt_pending_password", authType);
    }
    router.replace("/stromflyt" + window.location.search + window.location.hash);
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui" }}>
      <p>Åpner Strømflyt …</p>
    </main>
  );
}

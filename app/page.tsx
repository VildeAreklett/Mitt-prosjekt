"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Supabase-invitasjoner kan lande på rotadressen med tokens i URL-fragmentet.
// Send dem videre til Strømflyt og behold fragmentet slik at Supabase-klienten
// kan opprette sesjonen og la brukeren velge passord.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const authType = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("type");
    if (authType === "invite" || authType === "recovery") {
      // Supabase-klienten kan rydde tokenet fra adressen når neste side
      // starter. Behold derfor en ufarlig markør som sikrer passordsteget.
      window.sessionStorage.setItem("stromflyt_pending_password", authType);
    }
    router.replace("/stromflyt" + window.location.hash);
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui" }}>
      <p>Åpner Strømflyt …</p>
    </main>
  );
}

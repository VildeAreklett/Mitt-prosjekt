"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Supabase-invitasjoner kan lande på rotadressen med tokens i URL-fragmentet.
// Send dem videre til Strømflyt og behold fragmentet slik at Supabase-klienten
// kan opprette sesjonen og la brukeren velge passord.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/stromflyt" + window.location.hash);
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui" }}>
      <p>Åpner Strømflyt …</p>
    </main>
  );
}

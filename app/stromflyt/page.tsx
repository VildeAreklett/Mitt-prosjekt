"use client";

// Strømflyt: innmelding + register, koblet mot Supabase-tabellen strombestillinger.
// Drop-in for App Router: app/stromflyt/page.tsx. Krever @supabase/supabase-js
// og env-variablene NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.

import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import ExcelJS from "exceljs";
import {
  STAGES,
  CLOUD_ORGS,
  NETTEIERE,
  PRISOMRADER,
  validateMalepunkt,
  nextStatus,
  previousStatus,
  fmt,
  ENTELIOS_COLUMNS,
  ENTELIOS_MAIL,
  type Malepunkt,
  type Status,
} from "../../lib/stromflyt-config";
import {
  listMalepunkt,
  insertMalepunkt,
  insertMalepunktWithStatus,
  updateStatus,
  updateStatuses,
  updateAvtaletype,
  updateCloudOrg,
  updateMalepunktDetails,
  updateCustomerSeller,
  updateCustomerKontaktperson,
  deleteMalepunkt,
  listHistory,
  markBatchSent,
  type HistoryEvent,
  listNyeAvtaler,
  settNyAvtaleStatus,
  oppdaterNyAvtale,
  type NyAvtale,
} from "../../lib/stromflyt-api";
import type { ParsedAvtale } from "../../lib/avtale-parser";
import type { ParsedExcelWorkbook, ParsedExcelRow, ParsedExcelSheet } from "../../lib/excel-parser";
import type { ParsedFakturaRow } from "../../lib/faktura-parser";
import { prisomradeFromPostnr } from "../../lib/geo";
import { supabase } from "../../lib/supabaseClient";

type ExcelGroupConfig = {
  kunde: string;
  org_nr: string;
  selger: string;
  cloud_org: string;
  avtaletype: "Eierskifte" | "Spotavtale" | "";
  signert: boolean;
};

const excelGroupKey = (r: ParsedExcelRow) =>
  r.referansekode || r.selskapsnavn || r.kunde_hint || r.bygg || r.adresse;

const STATUS_CLASS: Record<Status, string> = {
  Kladd: "s-kladd",
  Innmeldt: "s-innmeldt",
  "Klar for bestilling": "s-klar",
  "Sendt Entelios": "s-sendt",
  Bekreftet: "s-bekreftet",
  "Satt opp i Cloud": "s-cloud",
  Aktiv: "s-aktiv",
};

const shortStage = (s: string) =>
  displayStatus(s).replace("Sendt Entelios", "Sendt").replace("Satt opp i Cloud", "Cloud")
    .replace("Registrert hos Entelios", "Hos Entelios");

const displayStatus = (s: string) => {
  if (s === "Innmeldt") return "Registrert internt";
  if (s === "Klar for bestilling") return "Klar til Entelios";
  // "Bekreftet" (DB-verdien, urørt) vises som "Registrert hos Entelios" - et
  // tydeligere motstykke til "Registrert internt" (Innmeldt), og unngår at
  // "Bekreftet" leses som et vagt mellomsteg.
  if (s === "Bekreftet") return "Registrert hos Entelios";
  return s;
};

// "I dag" / "I går" / "14. sep." - mer lesbart enn en rå ISO-dato i en
// tabell man skanner raskt gjennom. signert_dato er en ren dato (ingen
// klokkeslett lagret), så viser bevisst ikke et oppdiktet klokkeslett -
// det ville sett ut som ekte informasjon når det bare ville vært 00:00.
const relativDato = (iso: string | null) => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const naa = new Date();
  const dagerMs = 24 * 60 * 60 * 1000;
  const dToDag = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const naaToDag = new Date(naa.getFullYear(), naa.getMonth(), naa.getDate()).getTime();
  const diff = Math.round((naaToDag - dToDag) / dagerMs);
  if (diff === 0) return "I dag";
  if (diff === 1) return "I går";
  return d.toLocaleDateString("nb-NO", { day: "numeric", month: "short" });
};

// Samme relative form som relativDato, men MED klokkeslett - brukes kun for
// ekte tidsstempler (opprettet), aldri for signert_dato (se merknad over).
const relativDatoMedKlokke = (iso: string | null) => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const kl = d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
  return `${relativDato(iso)}, ${kl}`;
};

const displayNameFromEmail = (email: string | null) => {
  if (!email) return "Profil";
  return email.split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
};

type WorkFilter = "" | "kladd" | "handling" | "venter" | "klar-cloud" | "cloud" | "drift" | "revisjon";
type SortKey = "arbeidsrekkefolge" | "oppstart" | "kunde" | "status" | "nyeste";

const MANEDSNAVN = ["Jan", "Feb", "Mar", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Des"];

const WORK_FILTERS: { key: WorkFilter; label: string; statuses: Status[]; skjult?: boolean }[] = [
  { key: "", label: "Alle", statuses: [] },
  // Selgers eget forarbeid FØR avtalen finnes - laster opp strømfaktura for
  // en potensiell kunde og får innmeldingsfaktorene hentet ut automatisk
  // (adresse/MålepunktID/netteier/forbruk), uten at noe av det ennå er en
  // reell innmelding. Egen, skjult WORK_FILTERS-oppføring - vises i sitt eget
  // sidemenyavsnitt (se "FORARBEID" i navigasjonen) i stedet for blant de
  // andre arbeidskøene, siden den ikke hører til selve innmeldingsløpet.
  { key: "kladd", label: "Kladd", statuses: ["Kladd"], skjult: true },
  // Alt som ikke er sendt til Entelios ennå, uansett om det er registrert
  // internt (Kladd/Innmeldt) eller klart (Klar for bestilling) - én enkel
  // samlekø for "dette gjenstår å sende inn".
  { key: "handling", label: "Ikke meldt inn", statuses: ["Kladd", "Innmeldt", "Klar for bestilling"] },
  { key: "venter", label: "Venter på Entelios", statuses: ["Sendt Entelios"] },
  { key: "klar-cloud", label: "Registrert Entelios", statuses: ["Bekreftet"] },
  { key: "cloud", label: "Cloud-oppsett", statuses: ["Satt opp i Cloud"] },
  { key: "drift", label: "I drift", statuses: ["Aktiv"] },
  // Ikke en arbeidskø (den trenger ingen handling - "Satt opp i Cloud" og
  // "Aktiv" har egne køer over for det som faktisk gjenstår) - dette er en
  // revisjonsliste: ALT som noensinne er bekreftet av Entelios, uansett hvor
  // langt det har kommet videre i Cloud-oppsettet. Skjult fra sidemenyen
  // (skjult: true), bare nåbar via "Bekreftet av Entelios totalt"-panelet på
  // Oversikt - se diskusjon om Elgsetergate 16 (sept. 2026): de to radene
  // der IKKE dukket opp i "Registrert hos Entelios" fordi de allerede hadde
  // rukket videre til "Satt opp i Cloud", noe som så ut som de manglet fra
  // registreringen selv om de faktisk var bekreftet for lengst.
  { key: "revisjon", label: "Bekreftet av Entelios (alle)", statuses: ["Bekreftet", "Satt opp i Cloud", "Aktiv"], skjult: true },
];

// Kolonner i arbeidslisten som kan skrus av/på - Kunde og Handling vises alltid,
// resten er valgfrie. Lagres pr. nettleser (localStorage), ikke pr. bruker i
// databasen - det er en visningspreferanse, ikke data.
const REG_COLUMNS: { key: string; label: string }[] = [
  { key: "selger", label: "Selger" },
  { key: "bygg", label: "Bygg" },
  { key: "maalepunkt_id", label: "MålepunktID" },
  { key: "netteier", label: "Netteier" },
  { key: "prisomrade", label: "Prisområde" },
  { key: "aarsforbruk_kwh", label: "Årsforbruk" },
  { key: "avtalt_oppstart", label: "Oppstartsdato" },
  { key: "tsdb_id", label: "tsdb_id" },
  { key: "status", label: "Status" },
];
const REG_COLUMNS_STORAGE_KEY = "stromflyt_synlige_kolonner";

const emptyForm: Partial<Malepunkt> = {
  kunde: "", org_nr: "", selger: "", cloud_org: "", bygg: "", adresse: "", maalenummer: "",
  maalepunkt_id: "", netteier: "", prisomrade: "", aarsforbruk_kwh: null,
  avtalt_oppstart: "", at_kode: "", signert: false, kommentar: "",
  avtaletype: "", leverandoravtale_fil_sti: null,
  kontaktperson_navn: "", kontaktperson_epost: "", tsdb_id: null,
};

export default function StromflytPage() {
  const requireAuth = process.env.NEXT_PUBLIC_REQUIRE_AUTH === "true";
  const [tab, setTab] = useState<"reg" | "overview" | "form" | "import" | "excel" | "faktura" | "nye">("reg");
  // Avtaler sendt hit fra fakturakontroll, som ennå ikke har målepunkter.
  const [nyeAvtaler, setNyeAvtaler] = useState<NyAvtale[]>([]);
  const [nyeFane, setNyeFane] = useState<"aktiv" | "ferdig">("aktiv");
  // Til "Oppdatert HH:MM" i Oversikt-headeren - når dataene sist faktisk ble
  // hentet, ikke når siden ble lastet (kan være ulikt om noen lar fanen stå
  // åpen lenge).
  const [sistOppdatert, setSistOppdatert] = useState<Date | null>(null);
  const [nyeJobber, setNyeJobber] = useState<string | null>(null);
  // Hvilken "Nye avtaler"-rad en PDF akkurat nå er sluppet/lastet opp for -
  // brukes til å koble den ferdige AI-lesingen tilbake til riktig rad, slik
  // at raden kan settes til "Klargjort" automatisk når målepunktene er lagt
  // inn, i stedet for at brukeren må huske å gjøre det som et eget steg.
  const [nyAvtaleKobling, setNyAvtaleKobling] = useState<NyAvtale | null>(null);
  const [nyAvtaleDrag, setNyAvtaleDrag] = useState<string | null>(null);
  // Signert-datoen vises normalt som lesbar tekst (relativDato), ikke som en
  // rå datovelger - klikk for å slå om til redigering for én rad av gangen.
  const [nyAvtaleDatoRedigerer, setNyAvtaleDatoRedigerer] = useState<string | null>(null);
  const [rows, setRows] = useState<Malepunkt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fltStatus, setFltStatus] = useState("");
  const [bulkCloudOrg, setBulkCloudOrg] = useState("");
  const [workFilter, setWorkFilter] = useState<WorkFilter>("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("arbeidsrekkefolge");
  const [visibleCols, setVisibleCols] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(REG_COLUMNS.map((c) => [c.key, true]))
  );
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [toast, setToast] = useState<{ tittel: string; detalj?: string } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [form, setForm] = useState<Partial<Malepunkt>>({ ...emptyForm });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [leverandoravtaleUploading, setLeverandoravtaleUploading] = useState(false);
  const [leverandoravtaleUrl, setLeverandoravtaleUrl] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [lookup, setLookup] = useState<{ loading: boolean; msg: string }>({ loading: false, msg: "" });
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [parsed, setParsed] = useState<ParsedAvtale | null>(null);
  const [selectedRows, setSelectedRows] = useState<Record<number, boolean>>({});
  const [rowAtCodes, setRowAtCodes] = useState<Record<number, string>>({});
  // Rader avtalen matcher mot et MålepunktID som allerede ligger i registeret
  // (typisk en Kladd fanget opp fra en strømfaktura, som mangler oppstart/
  // avtaletype) - disse kan velges for OPPDATERING i stedet for å bare
  // hoppes over som dublett.
  const [updateRows, setUpdateRows] = useState<Record<number, boolean>>({});
  const [updatingExisting, setUpdatingExisting] = useState(false);
  const [importCloudOrg, setImportCloudOrg] = useState("Strømkunder");
  const [importSeller, setImportSeller] = useState("");
  const [importName, setImportName] = useState("");
  const [fakturaParsing, setFakturaParsing] = useState(false);
  const [fakturaSaving, setFakturaSaving] = useState(false);
  const [fakturaName, setFakturaName] = useState("");
  // Én PDF kan inneholde flere fakturaer/målere (samlefaktura, eller - sett i
  // praksis - to helt separate fakturaer limt i samme fil) - derfor en liste,
  // med egen redigerbar netteier/prisområde/valgt-status per rad. Kunde,
  // org.nr er felles for hele opplastingen, siden det vanligste er at alle
  // radene i én faktura tilhører samme kunde.
  const [fakturaRows, setFakturaRows] = useState<ParsedFakturaRow[] | null>(null);
  const [fakturaRowNetteier, setFakturaRowNetteier] = useState<Record<number, string>>({});
  const [fakturaRowPrisomrade, setFakturaRowPrisomrade] = useState<Record<number, string>>({});
  const [fakturaRowLookupMsg, setFakturaRowLookupMsg] = useState<Record<number, string>>({});
  const [fakturaSelected, setFakturaSelected] = useState<Record<number, boolean>>({});
  const [fakturaKunde, setFakturaKunde] = useState("");
  const [fakturaOrgNr, setFakturaOrgNr] = useState("");
  const [fakturaEnhetMsg, setFakturaEnhetMsg] = useState("");
  const [fakturaCloudOrg, setFakturaCloudOrg] = useState("Strømkunder");
  const [fakturaSignert, setFakturaSignert] = useState(false);
  const [excelParsing, setExcelParsing] = useState(false);
  const [excelImporting, setExcelImporting] = useState(false);
  const [excelData, setExcelData] = useState<ParsedExcelWorkbook | null>(null);
  const [excelSheetName, setExcelSheetName] = useState("");
  const [excelName, setExcelName] = useState("");
  const [excelSelected, setExcelSelected] = useState<Record<number, boolean>>({});
  const [excelMappings, setExcelMappings] = useState<Record<string, ExcelGroupConfig>>({});
  // Org.nr mangler ofte helt fra kilden (Entelios sin egen innmeldingsmal har
  // bare kundenavn) - søkes automatisk opp mot Brønnøysundregisteret pr.
  // referansegruppe når vi ikke allerede kjenner kunden fra registeret fra før.
  const [excelOrgSokMsg, setExcelOrgSokMsg] = useState<Record<string, string>>({});
  const [excelOrgSokTreff, setExcelOrgSokTreff] = useState<Record<string, { organisasjonsnummer: string; navn: string }[]>>({});
  // Netteier/prisområde står sjeldent i Entelios' egne innmeldingsmaler (de
  // har bare adresse/MålepunktID) - samme adresseoppslag som fakturaimporten
  // bruker, ett kall pr. rad som mangler feltet fra kilden.
  const [excelRowNetteier, setExcelRowNetteier] = useState<Record<number, string>>({});
  const [excelRowPrisomrade, setExcelRowPrisomrade] = useState<Record<number, string>>({});
  const [excelRowLookupMsg, setExcelRowLookupMsg] = useState<Record<number, string>>({});
  // Entelios sin egen innmeldingsmal har ingen årsforbruk-kolonne i det hele
  // tatt - ikke noe adresseoppslag kan gi oss den, så den må fylles inn for
  // hånd (f.eks. fra Cloud, etter at "Sjekk i Cloud" er kjørt på raden).
  const [excelRowAarsforbruk, setExcelRowAarsforbruk] = useState<Record<number, string>>({});
  const [dragTarget, setDragTarget] = useState<"pdf" | "excel" | "faktura" | null>(null);
  const [authLoading, setAuthLoading] = useState(requireAuth);
  const [userEmail, setUserEmail] = useState<string | null>(requireAuth ? null : "lokal test");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordContext, setPasswordContext] = useState<"invite" | "account">("invite");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [nyOpen, setNyOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<Malepunkt | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Kolonnevisning er en nettleser-preferanse, ikke data - lagres lokalt slik
  // at valget står ved neste besøk, men uten å blande det inn i registeret.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REG_COLUMNS_STORAGE_KEY);
      if (saved) setVisibleCols((v) => ({ ...v, ...JSON.parse(saved) }));
    } catch { /* ignorer korrupt/lokalt lagret preferanse */ }
  }, []);
  useEffect(() => {
    window.localStorage.setItem(REG_COLUMNS_STORAGE_KEY, JSON.stringify(visibleCols));
  }, [visibleCols]);

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const searchParams = new URLSearchParams(window.location.search);
    const authType = hashParams.get("type") || searchParams.get("type");
    const code = searchParams.get("code");
    const pendingPassword = window.sessionStorage.getItem("stromflyt_pending_password");
    const isInvite =
      authType === "invite" || authType === "recovery" ||
      pendingPassword === "invite" || pendingPassword === "recovery" || !!code;
    if (isInvite) { setPasswordContext("invite"); setNeedsPassword(true); setAuthLoading(true); }

    async function establishSession() {
      // Nyere Supabase-prosjekter sender invitasjons-/gjenopprettingslenker som
      // ?code=... (PKCE), ikke #access_token=...&type=invite i fragmentet. Uten
      // denne utvekslingen blir koden aldri brukt, og brukeren havner rett på
      // vanlig innlogging med kontoen fortsatt uverifisert.
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        window.history.replaceState({}, document.title, "/stromflyt");
        if (error) {
          setPasswordError("Lenken er ugyldig eller utløpt. Be om en ny invitasjon.");
          setNeedsPassword(true);
          setAuthLoading(false);
          return;
        }
      }
      if (!requireAuth && !isInvite) { refresh(); return; }
      const { data } = await supabase.auth.getSession();
      setUserEmail(data.session?.user.email || null);
      setAuthLoading(false);
      if (data.session) refresh();
    }
    establishSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email || null);
      setAuthLoading(false);
      if (session) refresh(); else { setRows([]); setLoading(false); }
    });
    return () => listener.subscription.unsubscribe();
  }, [requireAuth]);

  // Et utvalg skal alltid tilhøre arbeidslisten brukeren ser. Når søk eller
  // filter endres, fjernes tidligere valg slik at skjulte rader ikke behandles.
  useEffect(() => {
    setSelectedIds([]);
  }, [search, fltStatus, workFilter]);

  async function refresh() {
    setLoading(true);
    try {
      setRows(await listMalepunkt());
      // Køen fra fakturakontroll hentes samtidig. Feiler den — typisk fordi
      // migrasjonen ikke er kjørt — skal ikke resten av siden ryke med.
      try { setNyeAvtaler(await listNyeAvtaler()); } catch { setNyeAvtaler([]); }
      setErr(null);
      setSistOppdatert(new Date());
    }
    catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }

  async function settNyStatus(a: NyAvtale, status: NyAvtale["status"]) {
    setNyeJobber(a.id);
    try { await settNyAvtaleStatus(a.id, status); await refresh(); flash(`«${a.avtalenavn}» satt til ${status}.`); }
    catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setNyeJobber(null); }
  }
  // `detalj` er valgfri - gir et to-linjers kort (fet tittel + dempet
  // detaljlinje, f.eks. "Systemene svarer" / "Cloud-sjekk 08:42") i stedet
  // for den vanlige ett-linjes bekreftelsen. Brukt for lengre kjørende
  // handlinger (Cloud-oppslag) der brukeren har nytte av å se AT noe pågår,
  // ikke bare det ferdige resultatet.
  function flash(tittel: string, detalj?: string) {
    // Flere flash()-kall etter hverandre (f.eks. "Sjekker i Cloud …" fulgt av
    // selve resultatet et par sekunder senere) må kansellere HVERANDRES
    // planlagte fjerning - ellers kan en tidligere, kortere timeout fyre av
    // rett etter at den nye meldingen ble satt, og slette den igjen nesten
    // øyeblikkelig (så meldingen "blinker" og forsvinner på under et sekund).
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ tittel, detalj });
    // Lengre meldinger (f.eks. feilmeldinger med detaljer) trenger mer tid
    // til å bli lest enn en kort bekreftelse - varier visningstiden med
    // tekstlengden i stedet for én fast, ofte for kort, varighet.
    const lengde = tittel.length + (detalj?.length ?? 0);
    const varighet = Math.min(9000, Math.max(3000, lengde * 60));
    toastTimerRef.current = window.setTimeout(() => setToast(null), varighet);
  }

  async function stromflytAuthHeaders(): Promise<HeadersInit> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setLoginError("");
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail.trim(), password: loginPassword });
    if (error) { setLoginError("Feil e-post eller passord."); setAuthLoading(false); }
  }

  async function signOut() {
    setProfileOpen(false);
    await supabase.auth.signOut();
    setUserEmail(null);
  }

  async function finishInvitation(e: FormEvent) {
    e.preventDefault();
    setPasswordError("");
    if (newPassword.length < 8) { setPasswordError("Passordet må ha minst 8 tegn."); return; }
    if (newPassword !== confirmPassword) { setPasswordError("Passordene er ikke like."); return; }
    setAuthLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setAuthLoading(false);
    if (error) { setPasswordError("Kunne ikke lagre passordet. Be om en ny invitasjon."); return; }
    window.sessionStorage.removeItem("stromflyt_pending_password");
    window.history.replaceState({}, document.title, "/stromflyt");
    setNeedsPassword(false);
    flash("Passord lagret. Du er nå logget inn.");
    refresh();
  }

  // Redigering av en eksisterende rad skal ikke kreve at ALLE innmeldingsfelt
  // (oppstart, referansekode, signert) er utfylt - en Kladd skal kunne
  // rettes opp litt etter litt. Kun ved ny manuell registrering (ikke
  // redigering) kreves alt utfylt før man kan trykke "Registrer målepunkt".
  const errors = useMemo(() => validateMalepunkt(form, { draft: !!editingId }), [form, editingId]);
  const isValid = Object.keys(errors).length === 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const activeWork = WORK_FILTERS.find((f) => f.key === workFilter);
    const result = rows.filter((r) => {
      const text = [r.kunde, r.selger, r.bygg, r.adresse, r.maalepunkt_id, r.maalenummer, r.at_kode, r.netteier].join(" ").toLowerCase();
      return (!fltStatus || r.status === fltStatus)
        && (!activeWork?.statuses.length || activeWork.statuses.includes(r.status))
        && (!q || text.includes(q));
    });
    return [...result].sort((a, b) => {
      if (sortKey === "oppstart") {
        // Nyeste oppstartsdato først. Rader uten oppstartsdato satt havner
        // alltid sist, uansett sorteringsretning - ikke helt øverst som om
        // "ikke satt" var en dato i fremtiden.
        if (!a.avtalt_oppstart && !b.avtalt_oppstart) return 0;
        if (!a.avtalt_oppstart) return 1;
        if (!b.avtalt_oppstart) return -1;
        return b.avtalt_oppstart.localeCompare(a.avtalt_oppstart);
      }
      if (sortKey === "kunde") return a.kunde.localeCompare(b.kunde, "nb");
      if (sortKey === "status") return STAGES.indexOf(a.status) - STAGES.indexOf(b.status);
      if (sortKey === "nyeste") return String(b.created_at || "").localeCompare(String(a.created_at || ""));
      // Operativ kø: først neste steg i prosessen, deretter nærmeste oppstart.
      const stage = STAGES.indexOf(a.status) - STAGES.indexOf(b.status);
      return stage || (a.avtalt_oppstart || "9999").localeCompare(b.avtalt_oppstart || "9999");
    });
  }, [rows, fltStatus, workFilter, search, sortKey]);

  // Globalt søk i toppen: finner et målepunkt uansett hvilken visning man står
  // i, i motsetning til søkefeltet i arbeidslisten som bare filtrerer der.
  const globalMatches = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    if (!q) return [];
    return rows
      .filter((r) => [r.kunde, r.selger, r.bygg, r.adresse, r.maalepunkt_id, r.maalenummer, r.at_kode, r.netteier].join(" ").toLowerCase().includes(q))
      .slice(0, 8);
  }, [rows, globalSearch]);
  const regColSpan = useMemo(
    () => 4 + REG_COLUMNS.filter((c) => visibleCols[c.key] ?? true).length,
    [visibleCols]
  );
  const batchRows = useMemo(() => rows.filter((r) => r.status === "Klar for bestilling"), [rows]);
  const selectedRowsForBulk = useMemo(() => rows.filter((r) => selectedIds.includes(r.id)), [rows, selectedIds]);
  const selectedRegisteredIds = useMemo(
    () => selectedRowsForBulk.filter((r) => r.status === "Innmeldt").map((r) => r.id),
    [selectedRowsForBulk],
  );
  const selectedDeletableIds = useMemo(
    () => selectedRowsForBulk.filter((r) => r.status === "Kladd" || r.status === "Innmeldt" || r.status === "Klar for bestilling").map((r) => r.id),
    [selectedRowsForBulk],
  );
  const excelSheet = useMemo(
    () => excelData?.sheets.find((s) => s.name === excelSheetName) || null,
    [excelData, excelSheetName],
  );
  const excelGroupKeys = useMemo(
    () => excelSheet ? [...new Set(excelSheet.rows.map(excelGroupKey))] : [],
    [excelSheet],
  );
  const excelReadyCount = useMemo(() => excelSheet?.rows.filter((r) => {
    const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
    return excelSelected[r.source_row] && excelRowValid(r) && !duplicate && excelMappingValid(excelMappings[excelGroupKey(r)]);
  }).length || 0, [excelSheet, excelSelected, excelMappings, excelRowNetteier, excelRowPrisomrade, excelRowAarsforbruk, rows]);

  const tiles = useMemo(() => {
    const trenger = rows.filter((r) => r.status === "Innmeldt" || r.status === "Klar for bestilling").length;
    const eierskifte = rows.filter((r) => r.avtaletype === "Eierskifte").length;
    const spotavtale = rows.filter((r) => r.avtaletype === "Spotavtale").length;
    const ikkeAvklart = rows.filter((r) => !r.avtaletype).length;

    // Volum vi faktisk skal levere på - summert årsforbruk for alt som er
    // sendt til Entelios eller lenger (dvs. reelt registrert hos dem, ikke
    // bare planlagt internt hos oss). Vist i GWh siden kWh-tallene blir
    // uoversiktlig store i sum.
    const registrertHosEntelios = rows.filter(
      (r) => STAGES.indexOf(r.status) >= STAGES.indexOf("Sendt Entelios")
    );
    const bekreftetAvEntelios = registrertHosEntelios.filter(
      (r) => STAGES.indexOf(r.status) >= STAGES.indexOf("Bekreftet")
    );
    const sumKwh = (liste: Malepunkt[]) => liste.reduce((s, r) => s + (r.aarsforbruk_kwh || 0), 0);
    const gwhRegistrert = sumKwh(registrertHosEntelios) / 1_000_000;
    const gwhBekreftet = sumKwh(bekreftetAvEntelios) / 1_000_000;
    const registrertUtenForbruk = registrertHosEntelios.filter((r) => !r.aarsforbruk_kwh).length;

    // Totalt solgt volum - ALT som er registrert her, uansett om det er
    // sendt til Entelios ennå eller ikke. Skiller seg bevisst fra
    // gwhRegistrert over: den teller kun det som faktisk er sendt videre,
    // dette teller hele salgspipelinen (inkl. Kladd/Innmeldt/Klar for
    // bestilling), som normalt er et større tall.
    const gwhSolgtTotalt = sumKwh(rows) / 1_000_000;
    const solgtUtenForbruk = rows.filter((r) => !r.aarsforbruk_kwh).length;

    const enUkeSiden = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const nyeDenneUken = rows.filter((r) => r.created_at && new Date(r.created_at).getTime() >= enUkeSiden).length;

    return {
      total: rows.length, trenger, eierskifte, spotavtale, ikkeAvklart, nyeDenneUken,
      gwhRegistrert, gwhBekreftet, registrertAntall: registrertHosEntelios.length, registrertUtenForbruk,
      gwhSolgtTotalt, solgtUtenForbruk,
    };
  }, [rows]);

  // Livsløp: antall målepunkt per steg i statuslinjen, til den vannrette
  // stolpelisten i Oversikt - viser hvor "tykk" hver fase er akkurat nå.
  const livslop = useMemo(() => {
    const maks = Math.max(1, ...STAGES.map((s) => rows.filter((r) => r.status === s).length));
    return STAGES.map((s) => ({ status: s, antall: rows.filter((r) => r.status === s).length, maks }));
  }, [rows]);

  // Revisjonstall - IKKE en arbeidskø (statuslinjens køer viser bevisst kun
  // "hva trenger jeg å gjøre nå", ett steg av gangen), men et svar på "er
  // absolutt alt faktisk bekreftet av Entelios, uansett hvor langt det har
  // kommet videre i Cloud-oppsettet etterpå". Uten dette tallet så det ut
  // som Elgsetergate 16 (Satt opp i Cloud) manglet fra registreringen, når
  // den i realiteten bare hadde rukket videre.
  const bekreftetTotalt = useMemo(() => {
    const antall = rows.filter((r) => STAGES.indexOf(r.status) >= STAGES.indexOf("Bekreftet")).length;
    return { antall, avTotalt: rows.length };
  }, [rows]);

  // Prioriterte køer på Oversikt - de tre køene som faktisk trenger en
  // konkret handling fra noen, med de eldste/mest presserende radene synlig
  // med en direkte handlingsknapp, i stedet for bare et tall å klikke seg inn på.
  const prioriterteKoer = useMemo(() => {
    const dagerSiden = (iso?: string) => {
      if (!iso) return null;
      return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
    };
    const ikkeMeldtInn = rows.filter((r) => r.status === "Kladd" || r.status === "Innmeldt" || r.status === "Klar for bestilling");
    const venterPaEntelios = rows.filter((r) => r.status === "Sendt Entelios");
    const cloudOppsett = rows.filter((r) => r.status === "Satt opp i Cloud");
    const venterDager = venterPaEntelios.map((r) => dagerSiden(r.updated_at) ?? 0);
    // "Mangler Cloud-kobling" - bekreftet av Entelios eller satt opp i Cloud,
    // men ingen tsdb_id lagret ennå. Dette er nettopp de radene "Sjekk i
    // Cloud" faktisk kan gjøre noe med - ikke en egen statuslinje-fase, men
    // et konkret, handlingsrettet utvalg på tvers av to av dem.
    const manglerCloudKobling = rows.filter(
      (r) => (r.status === "Bekreftet" || r.status === "Satt opp i Cloud") && !r.tsdb_id
    );
    return {
      ikkeMeldtInn: { total: ikkeMeldtInn.length, rader: ikkeMeldtInn.slice(0, 2) },
      venterPaEntelios: {
        total: venterPaEntelios.length,
        eldsteDager: venterDager.length ? Math.max(...venterDager) : 0,
        rader: venterPaEntelios.slice(0, 2).map((r) => ({ rad: r, dager: dagerSiden(r.updated_at) })),
      },
      cloudOppsett: { total: cloudOppsett.length, rader: cloudOppsett.slice(0, 2) },
      manglerCloudKobling: { total: manglerCloudKobling.length, rader: manglerCloudKobling.slice(0, 2) },
    };
  }, [rows]);

  // Registrert volum per måned - viser IKKE ekte målt forbruk (det ligger i
  // Adaptic Cloud/Entelios, ikke i vårt register), men hvor mye estimert
  // årsforbruk (aarsforbruk_kwh) vi har fått registrert hos Entelios,
  // fordelt på måneden anlegget har avtalt oppstart. avtalt_oppstart er en
  // "YYYY-MM-DD"-tekststreng - hentes ut med substring i stedet for
  // new Date(...), som ville gitt feil måned pga. tidssone-forskyvning på
  // rene datostrenger (samme grunn som resten av filen aldri Date-parser
  // dette feltet, bare sammenligner det som tekst).
  const [volumChartYear, setVolumChartYear] = useState(() => new Date().getFullYear());
  const [volumVisning, setVolumVisning] = useState<"maned" | "kumulativt" | "faktisk">("maned");
  // Faktisk (ekte, målt) forbruk hentes fra Cloud på forespørsel, ikke i
  // samme useMemo som resten av volum-grafen - det er et nettverkskall, ikke
  // en lokal utregning fra rows.
  const [faktiskForbruk, setFaktiskForbruk] = useState<{ perMonthGwh: number[]; antallMalere: number; feilmeldinger: string[] } | null>(null);
  const [faktiskLaster, setFaktiskLaster] = useState(false);
  const [faktiskFeil, setFaktiskFeil] = useState<string | null>(null);

  useEffect(() => {
    if (volumVisning !== "faktisk") return;
    let avbrutt = false;
    setFaktiskLaster(true);
    setFaktiskFeil(null);
    (async () => {
      try {
        const res = await fetch(`/api/cloud/forbruk?year=${volumChartYear}`, { headers: await stromflytAuthHeaders() });
        const data = await res.json();
        if (avbrutt) return;
        if (!res.ok || !data.ok) throw new Error(data.error || "Kunne ikke hente faktisk forbruk");
        setFaktiskForbruk(data);
      } catch (e: any) {
        if (!avbrutt) setFaktiskFeil(e.message ?? String(e));
      } finally {
        if (!avbrutt) setFaktiskLaster(false);
      }
    })();
    return () => { avbrutt = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumVisning, volumChartYear]);
  const volumChart = useMemo(() => {
    const alleRegistrert = rows.filter((r) => STAGES.indexOf(r.status) >= STAGES.indexOf("Sendt Entelios"));
    const registrert = alleRegistrert.filter((r) => /^\d{4}-\d{2}/.test(r.avtalt_oppstart));
    // Rader som ER sendt til Entelios, men mangler oppstartsdato, kan ikke
    // plasseres i noen måned - de teller med i GWh-flisen på Oversikt, men
    // forsvinner fra denne grafen. Regnes ut eksplisitt slik at vi kan si
    // fra om gapet i stedet for at tallene bare tilsynelatende ikke stemmer.
    const utenOppstart = alleRegistrert.filter((r) => !/^\d{4}-\d{2}/.test(r.avtalt_oppstart));
    const gwhUtenOppstart = utenOppstart.reduce((s, r) => s + (r.aarsforbruk_kwh || 0), 0) / 1_000_000;
    const years = Array.from(new Set(registrert.map((r) => Number(r.avtalt_oppstart.slice(0, 4))))).sort((a, b) => b - a);
    const perMonth = Array(12).fill(0);
    for (const r of registrert) {
      const year = Number(r.avtalt_oppstart.slice(0, 4));
      const month = Number(r.avtalt_oppstart.slice(5, 7)) - 1;
      if (year !== volumChartYear || month < 0 || month > 11) continue;
      perMonth[month] += (r.aarsforbruk_kwh || 0) / 1_000_000;
    }
    const naa = new Date();
    const naavarendeManed = volumChartYear === naa.getFullYear() ? naa.getMonth() : -1;
    // Kumulativt volum - hvor mye estimert forbruk som totalt har blitt
    // registrert etter hvert som nye avtaler kommer inn, i stedet for bare
    // hvor mye som kom inn i den enkelte måneden. Gir et "vekst"-bilde av
    // porteføljen, med totalen ved årsslutt som siste punkt.
    const kumulativt: number[] = [];
    perMonth.reduce((sum, v, i) => { kumulativt[i] = sum + v; return kumulativt[i]; }, 0);
    return {
      years: years.length ? years : [volumChartYear], perMonth, kumulativt,
      maks: Math.max(...perMonth, 0.01), maksKumulativt: Math.max(...kumulativt, 0.01),
      naavarendeManed, total: kumulativt[11] ?? 0,
      gwhUtenOppstart, antallUtenOppstart: utenOppstart.length,
    };
  }, [rows, volumChartYear]);

  function set<K extends keyof Malepunkt>(k: K, v: Malepunkt[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setTouched((t) => ({ ...t, [k]: true }));
  }

  // Slår opp netteier + prisområde fra adressen (Kartverket + NVE, via /api/netteier).
  async function lookupAddress(addr: string) {
    const a = (addr || "").trim();
    if (!a) return;
    setLookup({ loading: true, msg: "Henter netteier og prisområde …" });
    try {
      const r = await fetch("/api/netteier?address=" + encodeURIComponent(a));
      const d = await r.json();
      if (!d.ok) {
        setLookup({ loading: false, msg: d.error || "Fant ikke automatisk – fyll inn manuelt" });
        return;
      }
      setForm((f) => ({
        ...f,
        adresse: d.adresse || f.adresse,
        netteier: d.netteier || f.netteier,
        prisomrade: d.prisomrade || f.prisomrade,
      }));
      setTouched((t) => ({ ...t, adresse: true, netteier: true, prisomrade: true }));
      const deler = [d.netteier, d.prisomrade, d.poststed].filter(Boolean).join(" · ");
      setLookup({ loading: false, msg: deler ? "Fylte inn: " + deler : "Adresse funnet" });
    } catch {
      setLookup({ loading: false, msg: "Oppslag feilet – fyll inn manuelt" });
    }
  }

  async function parsePdf(file: File | undefined, fraNyAvtale?: NyAvtale) {
    if (!file) return;
    setNyAvtaleKobling(fraNyAvtale ?? null);
    setParsing(true);
    setParsed(null);
    setImportName(file.name);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/avtale/parse", { method: "POST", body, headers: await stromflytAuthHeaders() });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Kunne ikke lese avtalen");
      const result = data as ParsedAvtale & { ok: true };
      setParsed(result);
      setImportCloudOrg(result.kunde || "");
      setImportSeller(rows.find((r) => r.org_nr === result.org_nr)?.selger || "");
      const next: Record<number, boolean> = {};
      const nextUpdate: Record<number, boolean> = {};
      result.rows.forEach((r, i) => {
        const existing = rows.find((row) => row.maalepunkt_id === r.maalepunkt_id);
        next[i] = r.gyldig && !existing;
        // Foreslå oppdatering som standard kun når det som allerede ligger der
        // faktisk er en Kladd (fanget fra en strømfaktura, mangler oppstart/
        // avtaletype) - ikke overskriv en ferdig utfylt rad uten at brukeren
        // ber om det.
        if (existing && existing.status === "Kladd") nextUpdate[i] = true;
      });
      setSelectedRows(next);
      setUpdateRows(nextUpdate);
      setRowAtCodes({});
    } catch (e: any) {
      flash("Kunne ikke lese avtalen: " + (e.message ?? e));
    } finally {
      setParsing(false);
    }
  }

  // Strømfaktura: ingen fast mal (hver netteier/kraftleverandør har sitt eget
  // oppsett, og fakturaene er ofte skannet uten tekstlag) - se lib/faktura-parser.ts
  // for hvorfor dette sendes til Claude i stedet for et fast tekstuttrekk.
  async function parseFaktura(file: File | undefined) {
    if (!file) return;
    setFakturaParsing(true);
    setFakturaRows(null);
    setFakturaRowNetteier({});
    setFakturaRowPrisomrade({});
    setFakturaRowLookupMsg({});
    setFakturaSelected({});
    setFakturaName(file.name);
    // Lastes opp til Supabase Storage i stedet for å sendes direkte i
    // forespørselen - Vercel avviser forespørsler over ca. 4,5 MB, og
    // skannede fakturaer med mye historikk (flere sider) overskrider ofte det.
    // Filnavnet kan ikke brukes rått som lagringsnøkkel - mellomrom og norske
    // bokstaver (æøå) gir "Invalid key" fra Storage.
    const trygtNavn = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${(await supabase.auth.getUser()).data.user?.id || "ukjent"}/${Date.now()}-${trygtNavn}`;
    try {
      const { error: uploadError } = await supabase.storage.from("fakturaer").upload(storagePath, file);
      if (uploadError) throw new Error("Kunne ikke laste opp filen: " + uploadError.message);
      const res = await fetch("/api/faktura/parse", {
        method: "POST",
        body: JSON.stringify({ storagePath }),
        headers: { ...(await stromflytAuthHeaders()), "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Kunne ikke lese fakturaen");
      const result = data.fakturaer as ParsedFakturaRow[];
      setFakturaRows(result);
      const selected: Record<number, boolean> = {};
      const netteier: Record<number, string> = {};
      result.forEach((r, i) => {
        selected[i] = !rows.some((existing) => existing.maalepunkt_id === r.malepunkt_id);
        netteier[i] = r.netteier;
        const adresseForOppslag = [r.adresse, r.postnr, r.poststed].filter(Boolean).join(", ");
        if (adresseForOppslag) void lookupFakturaAdresse(i, adresseForOppslag, r.postnr);
      });
      setFakturaSelected(selected);
      setFakturaRowNetteier(netteier);
      flash(`${result.length} målepunkt funnet${result.length > 1 ? " i dokumentet" : ""}`);
    } catch (e: any) {
      flash("Kunne ikke lese fakturaen: " + (e.message ?? e));
    } finally {
      setFakturaParsing(false);
    }
  }

  // Prisområde står aldri på selve fakturaen - samme adresseoppslag
  // (Kartverket + NVE) som brukes ved manuell registrering. Ikke alle adresser
  // (særlig nyere/industri) finnes i Kartverket sitt register selv om gate og
  // postnummer er riktig lest (f.eks. "Trøngsla 4" i Flekkefjord) - da faller vi
  // tilbake på postnummeret vi allerede har fra selve fakturaen, som ikke
  // krever geokoding i det hele tatt. Slås opp pr. rad siden én PDF kan ha
  // flere målere på ulike adresser.
  async function lookupFakturaAdresse(index: number, addr: string, postnrFraFaktura: string) {
    setFakturaRowLookupMsg((m) => ({ ...m, [index]: "Henter prisområde …" }));
    try {
      const r = await fetch("/api/netteier?address=" + encodeURIComponent(addr));
      const d = await r.json();
      if (!d.ok) {
        const fallback = prisomradeFromPostnr(postnrFraFaktura);
        if (fallback) {
          setFakturaRowPrisomrade((p) => ({ ...p, [index]: fallback }));
          setFakturaRowLookupMsg((m) => ({ ...m, [index]: `Utledet fra postnr (${postnrFraFaktura})` }));
        } else {
          setFakturaRowLookupMsg((m) => ({ ...m, [index]: d.error || "Fant ikke automatisk - fyll inn manuelt" }));
        }
        return;
      }
      setFakturaRowPrisomrade((p) => ({ ...p, [index]: d.prisomrade || prisomradeFromPostnr(postnrFraFaktura) || "" }));
      setFakturaRowLookupMsg((m) => ({ ...m, [index]: d.prisomrade ? "" : "Fant adressen, men ikke prisområdet" }));
    } catch {
      const fallback = prisomradeFromPostnr(postnrFraFaktura);
      if (fallback) {
        setFakturaRowPrisomrade((p) => ({ ...p, [index]: fallback }));
        setFakturaRowLookupMsg((m) => ({ ...m, [index]: `Oppslag feilet, utledet fra postnr: ${fallback}` }));
      } else {
        setFakturaRowLookupMsg((m) => ({ ...m, [index]: "Oppslag feilet - fyll inn manuelt" }));
      }
    }
  }

  // Det vanlige er flere hovedmålere på samme kunde/bygg over tid, ikke bare
  // ett. Kjenner vi igjen kunden fra før, fylles org.nr/Cloud-org inn
  // automatisk fra siste registrering på samme kunde i stedet for at
  // selgeren må taste det på nytt for hver nye faktura. Overskriver aldri felt
  // brukeren allerede har endret manuelt.
  function handleFakturaKundeChange(value: string) {
    setFakturaKunde(value);
    const match = rows.find((r) => r.kunde.trim().toLowerCase() === value.trim().toLowerCase());
    if (!match) return;
    if (!fakturaOrgNr) setFakturaOrgNr(match.org_nr);
    if (!fakturaCloudOrg || fakturaCloudOrg === "Strømkunder") setFakturaCloudOrg(match.cloud_org);
  }

  // Motsatt vei av kunde->org.nr-utfyllingen over: skriv inn org.nr, få
  // firmanavnet slått opp automatisk fra Brønnøysundregistrene (gratis,
  // offisiell kilde - samme prinsipp som adresseoppslaget). Overskriver
  // aldri et kundenavn brukeren allerede har skrevet inn selv.
  async function handleFakturaOrgNrChange(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 9);
    setFakturaOrgNr(digits);
    setFakturaEnhetMsg("");
    if (digits.length !== 9 || fakturaKunde.trim()) return;
    const existing = rows.find((r) => r.org_nr === digits);
    if (existing) { setFakturaKunde(existing.kunde); setFakturaEnhetMsg(`Fylt inn fra registeret: ${existing.kunde}`); return; }
    setFakturaEnhetMsg("Slår opp firmanavn …");
    try {
      const r = await fetch("/api/enhet?orgnr=" + digits);
      const d = await r.json();
      if (!d.ok) { setFakturaEnhetMsg(d.error || "Fant ikke enhet - skriv inn kundenavn manuelt"); return; }
      setFakturaKunde(d.navn);
      setFakturaEnhetMsg(`Hentet fra Brønnøysundregistrene${d.underenhet ? " (underenhet)" : ""}: ${d.navn}`);
    } catch {
      setFakturaEnhetMsg("Oppslag feilet - skriv inn kundenavn manuelt");
    }
  }

  async function saveFaktura() {
    // Oppstartsdato og avtaletype kommer fra AVTALEN, ikke fra fakturaen - de
    // er ikke avklart ennå når selger fanger opp et målepunkt fra en faktura
    // i forarbeidet (Kladd). Kun kunde/org.nr (for å vite hvem det tilhører)
    // og det fakturaen faktisk kan gi (adresse/målenummer/MålepunktID/netteier)
    // er påkrevd her - resten fylles ut senere når avtalen er klar. Kunde/
    // org.nr er felles for alle valgte rader i denne opplastingen.
    if (!fakturaRows || !fakturaKunde.trim() || !/^\d{9}$/.test(fakturaOrgNr)) {
      flash("Kunde og org.nr (9 siffer) må fylles ut");
      return;
    }
    const chosen = fakturaRows.map((r, i) => ({ r, i })).filter(({ i }) => fakturaSelected[i]);
    if (!chosen.length) { flash("Velg minst ett målepunkt"); return; }
    setFakturaSaving(true);
    let ok = 0;
    const failures: string[] = [];
    for (const { r, i } of chosen) {
      if (rows.some((existing) => existing.maalepunkt_id === r.malepunkt_id)) {
        failures.push(`${r.adresse}: finnes allerede i registeret`);
        continue;
      }
      try {
        await insertMalepunktWithStatus({
          kunde: fakturaKunde.trim(),
          org_nr: fakturaOrgNr,
          selger: "",
          cloud_org: fakturaCloudOrg.trim(),
          bygg: r.adresse,
          adresse: r.adresse,
          maalenummer: r.malenummer,
          maalepunkt_id: r.malepunkt_id,
          netteier: (fakturaRowNetteier[i] ?? r.netteier).trim(),
          prisomrade: fakturaRowPrisomrade[i] ?? "",
          aarsforbruk_kwh: r.arsforbruk_kwh,
          avtalt_oppstart: "",
          at_kode: "",
          signert: fakturaSignert,
          kommentar: [
            `Importert fra strømfaktura: ${fakturaName}${r.kundenr_hos_leverandor ? ` (kundenr ${r.kundenr_hos_leverandor} hos nåværende leverandør)` : ""}`,
            r.usikre_felt.length ? `Usikre felt ved utlesing: ${r.usikre_felt.join(", ")} - bør bekreftes.` : "",
            "Oppstart/avtaletype ikke avklart ennå - fyll inn når avtalen er klar.",
          ].filter(Boolean).join(" "),
          avtaletype: "",
          leverandoravtale_fil_sti: null,
          kontaktperson_navn: "",
          kontaktperson_epost: "",
          tsdb_id: null,
          cloud_metric_id: null,
        }, "Kladd");
        ok += 1;
      } catch (e: any) {
        failures.push(`${r.adresse}: ${e.message ?? e}`);
      }
    }
    setFakturaSaving(false);
    if (ok) {
      flash(`${ok} målepunkt lagt i registeret${failures.length ? `, ${failures.length} hoppet over` : ""}`);
      setFakturaRows(null);
      setFakturaName("");
      setFakturaKunde("");
      setFakturaOrgNr("");
      setFakturaSignert(false);
      await refresh();
      // Rutene havner alltid i Kladd (se lenger opp) - send brukeren dit,
      // uansett om opplastingen skjedde fra selve Kladd-fanen eller fra den
      // frittstående "Last opp strømfaktura"-siden, slik at resultatet alltid
      // dukker opp der brukeren faktisk ser etter det.
      setTab("reg");
      setWorkFilter("kladd");
      setFltStatus("");
    } else {
      flash(failures[0] || "Ingen målepunkt ble lagt inn");
    }
  }

  function dropFile(e: DragEvent<HTMLDivElement>, kind: "pdf" | "excel" | "faktura") {
    e.preventDefault();
    setDragTarget(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (kind === "pdf") {
      if (!file.name.toLowerCase().endsWith(".pdf")) { flash("Slipp en PDF-avtale her"); return; }
      parsePdf(file);
    } else if (kind === "faktura") {
      if (!file.name.toLowerCase().endsWith(".pdf")) { flash("Slipp en strømfaktura (PDF) her"); return; }
      parseFaktura(file);
    } else {
      if (!file.name.toLowerCase().endsWith(".xlsx")) { flash("Slipp en .xlsx-fil her"); return; }
      parseExcel(file);
    }
  }

  // Målepunkt-radene fra Entelios-innmeldingsmalen oppgir ofte ikke netteier/
  // prisområde i det hele tatt (det er kildefilens jobb å liste anlegget, ikke
  // slå opp nettleverandøren) - samme adresseoppslag (Kartverket + NVE) som
  // fakturaimporten bruker til det samme problemet.
  function excelRowProblemer(r: ParsedExcelRow): string[] {
    const netteierOk = !!(excelRowNetteier[r.source_row] ?? r.netteier).trim();
    const prisomradeOk = /^NO[1-5]$/.test((excelRowPrisomrade[r.source_row] ?? r.prisomrade).toUpperCase());
    return r.problemer.filter((p) => {
      if (p === "Mangler netteier") return !netteierOk;
      if (p === "Mangler/ugyldig prisområde") return !prisomradeOk;
      return true;
    });
  }

  function excelRowValid(r: ParsedExcelRow): boolean {
    return excelRowProblemer(r).length === 0;
  }

  // Rader som ble sperret fra huking av bare et manglende netteier/prisområde
  // (ingen andre problemer) merkes automatisk på nytt så snart oppslaget
  // løser dem - ellers må selgeren huke av dem manuelt for hver eneste rad i
  // en fil på 100+ rader, selv om alt annet allerede er i orden.
  function autoSelectIfResolved(r: ParsedExcelRow, netteier: string, prisomrade: string) {
    const otherProblems = r.problemer.filter((p) => p !== "Mangler netteier" && p !== "Mangler/ugyldig prisområde");
    const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
    if (otherProblems.length === 0 && !duplicate && netteier.trim() && /^NO[1-5]$/.test(prisomrade.toUpperCase())) {
      setExcelSelected((s) => ({ ...s, [r.source_row]: true }));
    }
  }

  async function lookupExcelRowAdresse(r: ParsedExcelRow) {
    const sourceRow = r.source_row;
    setExcelRowLookupMsg((m) => ({ ...m, [sourceRow]: "Henter netteier/prisområde …" }));
    try {
      const res = await fetch("/api/netteier?address=" + encodeURIComponent(r.adresse));
      const d = await res.json();
      if (!d.ok) {
        setExcelRowLookupMsg((m) => ({ ...m, [sourceRow]: d.error || "Fant ikke automatisk - fyll inn manuelt" }));
        return;
      }
      const netteier = d.netteier || r.netteier;
      const prisomrade = d.prisomrade || r.prisomrade;
      if (d.netteier) setExcelRowNetteier((n) => ({ ...n, [sourceRow]: d.netteier }));
      if (d.prisomrade) setExcelRowPrisomrade((p) => ({ ...p, [sourceRow]: d.prisomrade }));
      setExcelRowLookupMsg((m) => ({ ...m, [sourceRow]: d.netteier && d.prisomrade ? "" : "Fant adressen, men ikke alt - kontroller manuelt" }));
      autoSelectIfResolved(r, netteier, prisomrade);
    } catch {
      setExcelRowLookupMsg((m) => ({ ...m, [sourceRow]: "Oppslag feilet - fyll inn manuelt" }));
    }
  }

  // Fritekstsøk mot Brønnøysundregisteret - se merknad i app/api/enhet/route.ts
  // om hvorfor dette gir kandidater å velge mellom fremfor å gjette blindt.
  // Ett søk pr. UNIKT kundenavn (ikke ett pr. referansegruppe - en fil med 30
  // referanser for samme kunde skal ikke slå opp samme navn 30 ganger),
  // resultatet påføres alle gruppene som deler det navnet.
  async function sokOrgNrForKunde(keys: string[], navn: string) {
    for (const key of keys) setExcelOrgSokMsg((m) => ({ ...m, [key]: "Søker org.nr …" }));
    try {
      const res = await fetch("/api/enhet?navn=" + encodeURIComponent(navn));
      const d = await res.json();
      if (!d.ok || !d.treff?.length) {
        for (const key of keys) setExcelOrgSokMsg((m) => ({ ...m, [key]: "Fant ikke automatisk - fyll inn manuelt" }));
        return;
      }
      for (const key of keys) setExcelOrgSokTreff((t) => ({ ...t, [key]: d.treff }));
      // Kildefilen oppgir ofte kundenavn uten selskapsform ("Propcap" i
      // stedet for "PROPCAP AS") - normaliser bort AS/ASA/DA/ANS og
      // skilletegn før sammenligning, ellers ville dette ALDRI telt som et
      // sikkert nok treff til å fylles inn automatisk.
      const norm = (s: string) => s.toLowerCase().replace(/[.,]/g, "").replace(/\b(as|asa|da|ans)\b/g, "").replace(/\s+/g, " ").trim();
      const eksakt = d.treff.find((tr: { navn: string }) => norm(tr.navn) === norm(navn));
      if (eksakt) {
        for (const key of keys) {
          setExcelMapping(key, { org_nr: eksakt.organisasjonsnummer });
          setExcelOrgSokMsg((m) => ({ ...m, [key]: "" }));
        }
      } else {
        for (const key of keys) setExcelOrgSokMsg((m) => ({ ...m, [key]: `${d.treff.length} mulige treff - velg riktig under` }));
      }
    } catch {
      for (const key of keys) setExcelOrgSokMsg((m) => ({ ...m, [key]: "Søk feilet - fyll inn manuelt" }));
    }
  }

  function setupExcelSheet(sheet: ParsedExcelSheet) {
    setExcelSheetName(sheet.name);
    setExcelRowNetteier({});
    setExcelRowPrisomrade({});
    setExcelRowLookupMsg({});
    setExcelRowAarsforbruk({});
    setExcelOrgSokMsg({});
    setExcelOrgSokTreff({});
    const selected: Record<number, boolean> = {};
    const mappings: Record<string, ExcelGroupConfig> = {};
    const navnOppslagQueue: { key: string; kunde: string }[] = [];
    sheet.rows.forEach((r) => {
      const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
      const netteierMissing = !r.netteier.trim();
      const prisomradeMissing = !/^NO[1-5]$/.test(r.prisomrade);
      const otherProblems = r.problemer.filter((p) => p !== "Mangler netteier" && p !== "Mangler/ugyldig prisområde");
      selected[r.source_row] = otherProblems.length === 0 && !duplicate;
      if (r.adresse && (netteierMissing || prisomradeMissing)) void lookupExcelRowAdresse(r);
      const key = excelGroupKey(r);
      if (!mappings[key]) {
        const kundeNavn = (r.selskapsnavn || r.kunde_hint || r.bygg || r.cloud_org || key).trim();
        // Kildefilen oppgir ofte ikke org.nr i det hele tatt - prøv da å
        // kjenne igjen kunden på NAVN mot resten av registeret først (gratis,
        // instant), før vi eventuelt søker eksternt mot Brønnøysund.
        const existingCustomer =
          rows.find((existing) => existing.org_nr === r.org_nr) ||
          rows.find((existing) => existing.kunde.trim().toLowerCase() === kundeNavn.toLowerCase());
        const orgNr = /^\d{9}$/.test(r.org_nr) ? r.org_nr : (existingCustomer?.org_nr || "");
        mappings[key] = {
          kunde: kundeNavn,
          org_nr: orgNr,
          selger: existingCustomer?.selger || "",
          cloud_org: r.cloud_org || existingCustomer?.cloud_org || "",
          avtaletype: r.avtaletype_hint,
          signert: r.signert ?? r.status_suggestion === "Sendt Entelios",
        };
        if (!orgNr && kundeNavn) navnOppslagQueue.push({ key, kunde: kundeNavn });
      }
    });
    setExcelSelected(selected);
    setExcelMappings(mappings);
    const keysPerKunde = new Map<string, string[]>();
    for (const { key, kunde } of navnOppslagQueue) {
      const k = kunde.toLowerCase();
      keysPerKunde.set(k, [...(keysPerKunde.get(k) ?? []), key]);
    }
    for (const [, keys] of keysPerKunde) {
      const kunde = navnOppslagQueue.find((q) => keys.includes(q.key))!.kunde;
      void sokOrgNrForKunde(keys, kunde);
    }
  }

  async function parseExcel(file: File | undefined) {
    if (!file) return;
    setExcelParsing(true);
    setExcelData(null);
    setExcelName(file.name);
    setExcelRowNetteier({});
    setExcelRowPrisomrade({});
    setExcelRowLookupMsg({});
    setExcelRowAarsforbruk({});
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/excel/parse", { method: "POST", body, headers: await stromflytAuthHeaders() });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Kunne ikke lese Excel-filen");
      const workbook = data as ParsedExcelWorkbook & { ok: true };
      setExcelData(workbook);
      setupExcelSheet(workbook.sheets[0]);
    } catch (e: any) {
      flash("Kunne ikke lese Excel-filen: " + (e.message ?? e));
    } finally {
      setExcelParsing(false);
    }
  }

  function setExcelMapping(key: string, patch: Partial<ExcelGroupConfig>) {
    setExcelMappings((m) => ({ ...m, [key]: { ...m[key], ...patch } }));
  }

  // Én Entelios-innmeldingsmal grupperer ofte etter Prosjektnr/referanse (én
  // rad pr. referanse i denne tabellen), men de fleste referansene i praksis
  // tilhører samme kunde og skal ha identisk org.nr/selger/strøm-org/
  // avtaletype/signert - uten dette måtte selgeren skrive det samme på nytt
  // for hver eneste referanse (30+ ganger for en fil som Propcap sin).
  function kopierMappingTilSammeKunde(key: string) {
    const kilde = excelMappings[key];
    if (!kilde) return;
    const kildeKunde = kilde.kunde.trim().toLowerCase();
    if (!kildeKunde) return;
    setExcelMappings((m) => {
      const next = { ...m };
      let antall = 0;
      for (const k of Object.keys(next)) {
        if (k === key) continue;
        if (next[k].kunde.trim().toLowerCase() !== kildeKunde) continue;
        next[k] = { ...next[k], org_nr: kilde.org_nr, selger: kilde.selger, cloud_org: kilde.cloud_org, avtaletype: kilde.avtaletype, signert: kilde.signert };
        antall += 1;
      }
      flash(antall ? `Kopiert til ${antall} andre referanser for ${kilde.kunde}` : "Fant ingen andre referanser med samme kundenavn");
      return next;
    });
  }

  // Selger/strøm-org/avtaletype/signert er IKKE blokkerende for selve
  // importen - kunde og org.nr er de eneste feltene databasen faktisk krever
  // (org_nr har en formatsjekk, resten kan ettermeldes fra Arbeidsliste når
  // avtalen er klar). Å kreve alt her ville tvunget selgeren gjennom en hel
  // runde med kommersielle detaljer bare for å få adressen/MålepunktID-en
  // inn i registeret.
  function excelMappingValid(m: ExcelGroupConfig | undefined) {
    return !!m && !!m.kunde.trim() && /^\d{9}$/.test(m.org_nr);
  }

  async function importExcelRows() {
    if (!excelSheet) return;
    const chosen = excelSheet.rows.filter((r) => {
      const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
      return excelSelected[r.source_row] && excelRowValid(r) && !duplicate && excelMappingValid(excelMappings[excelGroupKey(r)]);
    });
    if (!chosen.length) { flash("Ingen komplette, nye rader er klare for import"); return; }
    setExcelImporting(true);
    let ok = 0;
    let failed = 0;
    for (const r of chosen) {
      const mapping = excelMappings[excelGroupKey(r)];
      try {
        await insertMalepunktWithStatus({
          kunde: mapping.kunde.trim(),
          org_nr: mapping.org_nr,
          selger: mapping.selger.trim(),
          cloud_org: mapping.cloud_org.trim(),
          bygg: r.bygg || r.kunde_hint || r.adresse,
          adresse: r.adresse,
          maalenummer: r.maalenummer,
          maalepunkt_id: r.maalepunkt_id,
          netteier: (excelRowNetteier[r.source_row] ?? r.netteier).trim(),
          prisomrade: (excelRowPrisomrade[r.source_row] ?? r.prisomrade).toUpperCase(),
          aarsforbruk_kwh: r.aarsforbruk_kwh ?? (/^[0-9]+$/.test((excelRowAarsforbruk[r.source_row] ?? "").trim()) ? Number(excelRowAarsforbruk[r.source_row]) : null),
          avtalt_oppstart: r.oppstartdato,
          at_kode: r.referansekode,
          signert: mapping.signert,
          kommentar: [r.kommentar, `Importert fra ${excelName} · ${excelSheet.name} rad ${r.source_row}`].filter(Boolean).join(" · "),
          avtaletype: mapping.avtaletype,
          leverandoravtale_fil_sti: null,
          kontaktperson_navn: "",
          kontaktperson_epost: "",
          tsdb_id: null,
          cloud_metric_id: null,
        }, r.status_suggestion);
        if (mapping.selger.trim()) await updateCustomerSeller(mapping.org_nr, mapping.selger);
        ok += 1;
      } catch { failed += 1; }
    }
    setExcelImporting(false);
    await refresh();
    if (ok) { setTab("reg"); flash(`${ok} Excel-rader importert${failed ? `, ${failed} feilet` : ""}`); }
    else flash("Ingen rader ble importert");
  }

  async function importParsedRows() {
    if (!parsed || !parsed.kunde || !parsed.org_nr) return;
    if (!parsed.avtale_signert) {
      flash("Avtalen må være ferdig signert før den legges i registeret");
      return;
    }
    const chosen = parsed.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => selectedRows[index] && row.gyldig);
    if (!chosen.length) { flash("Ingen nye, gyldige målepunkt er valgt"); return; }

    setImporting(true);
    let ok = 0;
    const failures: string[] = [];
    for (const { row, index } of chosen) {
      try {
        await insertMalepunkt({
          kunde: parsed.kunde,
          org_nr: parsed.org_nr,
          selger: importSeller.trim(),
          cloud_org: importCloudOrg || parsed.kunde,
          bygg: row.adresse,
          adresse: row.adresse,
          maalenummer: row.maalenummer,
          maalepunkt_id: row.maalepunkt_id,
          netteier: row.netteier,
          prisomrade: row.prisomrade,
          aarsforbruk_kwh: row.aarsforbruk_kwh,
          avtalt_oppstart: parsed.avtalt_oppstart || "",
          // AT-kode finnes normalt ikke i avtalen. Den kan fylles per rad i
          // forhåndsvisningen, eller suppleres senere før Entelios-bestilling.
          at_kode: (rowAtCodes[index] || "").trim(),
          signert: parsed.avtale_signert,
          kommentar: [
            `Importert fra avtale-PDF: ${importName}${parsed.doc_ref ? ` · PandaDoc ${parsed.doc_ref}` : ""}`,
            parsed.kommentar_forslag || "",
          ].filter(Boolean).join(" | "),
          avtaletype: "",
          leverandoravtale_fil_sti: null,
          kontaktperson_navn: "",
          kontaktperson_epost: "",
          tsdb_id: null,
          cloud_metric_id: null,
        });
        if (importSeller.trim()) await updateCustomerSeller(parsed.org_nr, importSeller);
        ok += 1;
      } catch (e: any) {
        failures.push(`${row.adresse}: ${e.message ?? e}`);
      }
    }
    setImporting(false);
    // Kom denne PDF-en fra en "Nye avtaler"-rad, er den nå faktisk klargjort -
    // målepunktene finnes i registeret, ingen grunn til at noen må huske å
    // gå tilbake og endre statusen manuelt som et eget steg.
    if (ok && nyAvtaleKobling) {
      try { await settNyAvtaleStatus(nyAvtaleKobling.id, "Klargjort"); } catch { /* raden kan settes manuelt om dette feiler */ }
    }
    await refresh();
    if (ok) {
      setParsed(null);
      setNyAvtaleKobling(null);
      setTab("reg");
      flash(`${ok} målepunkt lagt i registeret${failures.length ? `, ${failures.length} hoppet over` : ""}`);
    } else {
      flash(failures[0] || "Ingen målepunkt ble lagt inn");
    }
  }

  // Fyller igjen hullene (oppstart/signert/AT-kode) på målepunkt som allerede
  // ligger i registeret - typisk en Kladd fanget opp fra en strømfaktura, der
  // avtalen ikke var klar ennå. Overskriver aldri felt som allerede har en
  // verdi, bortsett fra "signert" og "avtalt_oppstart" som legitimt kan gå
  // fra ukjent til kjent når avtalen kommer på plass.
  //
  // Selve poenget med Kladd (forarbeidet) er at den er ferdig i det øyeblikket
  // en signert avtale lastes opp for den - tilbudet er akseptert. Knappen er
  // uansett sperret til parsed.avtale_signert er true (se disabled-attributtet
  // under), så her er avtalen alltid bekreftet signert når dette faktisk
  // kjøres - flytt derfor raden videre fra Kladd til Innmeldt automatisk,
  // uten at noen må huske å gjøre det som et eget steg etterpå.
  async function updateExistingFromAvtale() {
    if (!parsed) return;
    const chosen = parsed.rows
      .map((row, index) => ({ row, index }))
      .filter(({ index }) => updateRows[index]);
    if (!chosen.length) { flash("Ingen eksisterende målepunkt er valgt for oppdatering"); return; }

    setUpdatingExisting(true);
    let ok = 0;
    let advanced = 0;
    const failures: string[] = [];
    for (const { row, index } of chosen) {
      const existing = rows.find((r) => r.maalepunkt_id === row.maalepunkt_id);
      if (!existing) { failures.push(`${row.adresse}: fant ikke lenger raden i registeret`); continue; }
      try {
        const willAdvance = existing.status === "Kladd";
        await updateMalepunktDetails(existing.id, {
          avtalt_oppstart: existing.avtalt_oppstart || parsed.avtalt_oppstart || "",
          at_kode: existing.at_kode || (rowAtCodes[index] || "").trim(),
          signert: existing.signert || parsed.avtale_signert,
          status: willAdvance ? "Innmeldt" : existing.status,
          kommentar: [
            existing.kommentar,
            `Oppdatert fra avtale-PDF: ${importName}${parsed.doc_ref ? ` · PandaDoc ${parsed.doc_ref}` : ""}`,
            parsed.kommentar_forslag || "",
          ].filter(Boolean).join(" | "),
        });
        ok += 1;
        if (willAdvance) advanced += 1;
      } catch (e: any) {
        failures.push(`${row.adresse}: ${e.message ?? e}`);
      }
    }
    setUpdatingExisting(false);
    await refresh();
    if (ok) {
      flash(`${ok} eksisterende målepunkt oppdatert${advanced ? ` (${advanced} flyttet fra Kladd til Klar til innmelding)` : ""}${failures.length ? `, ${failures.length} feilet` : ""}`);
      setUpdateRows({});
    } else {
      flash(failures[0] || "Ingen målepunkt ble oppdatert");
    }
  }

  async function advance(r: Malepunkt) {
    const next = nextStatus(r.status);
    if (!next) return;
    const extra: Partial<Malepunkt> =
      next === "Bekreftet" && !r.entelios_ref
        ? { entelios_ref: "TST-" + (10000 + (parseInt(r.maalenummer.slice(-4), 10) || 1234)) }
        : {};
    try { await updateStatus(r.id, next, extra); await refresh(); flash(`${r.bygg} → ${displayStatus(next)}`); }
    catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }

  async function moveBack(r: Malepunkt) {
    const previous = previousStatus(r.status);
    if (!previous) return;
    if (!window.confirm(`Flytte ${r.bygg} tilbake fra «${displayStatus(r.status)}» til «${displayStatus(previous)}»?`)) return;
    try {
      await updateStatus(r.id, previous);
      await refresh();
      flash(`${r.bygg} flyttet tilbake til ${displayStatus(previous)}`);
    } catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }

  async function remove(r: Malepunkt) {
    const deletable = r.status === "Kladd" || r.status === "Innmeldt" || r.status === "Klar for bestilling";
    if (!deletable) { flash("Kan ikke slettes etter at posten er sendt til Entelios"); return; }
    if (!window.confirm(`Slette ${r.bygg} (${r.maalepunkt_id}) fra registeret?`)) return;
    try {
      await deleteMalepunkt(r.id);
      await refresh();
      flash(`${r.bygg} slettet`);
    } catch (e: any) { flash("Kunne ikke slette: " + (e.message ?? e)); }
  }

  function startEdit(r: Malepunkt) {
    setEditingId(r.id);
    setForm({ ...r });
    setTouched({});
    setShowAll(false);
    setTab("form");
    setLeverandoravtaleUrl(null);
    if (r.leverandoravtale_fil_sti) void refreshLeverandoravtaleUrl(r.leverandoravtale_fil_sti);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function newManualEntry() {
    setEditingId(null);
    setForm({ ...emptyForm });
    setTouched({});
    setShowAll(false);
    setTab("form");
    setLeverandoravtaleUrl(null);
  }

  async function refreshLeverandoravtaleUrl(storagePath: string) {
    const { data } = await supabase.storage.from("leverandoravtaler").createSignedUrl(storagePath, 60 * 10);
    setLeverandoravtaleUrl(data?.signedUrl ?? null);
  }

  async function uploadLeverandoravtale(file: File) {
    setLeverandoravtaleUploading(true);
    try {
      const trygtNavn = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const userId = (await supabase.auth.getUser()).data.user?.id || "ukjent";
      const storagePath = `${userId}/${Date.now()}-${trygtNavn}`;
      const { error: uploadError } = await supabase.storage.from("leverandoravtaler").upload(storagePath, file);
      if (uploadError) throw new Error("Kunne ikke laste opp leverandøravtalen: " + uploadError.message);
      setForm((f) => ({ ...f, leverandoravtale_fil_sti: storagePath }));
      await refreshLeverandoravtaleUrl(storagePath);
      flash("Leverandøravtale lastet opp");
    } catch (e: any) {
      flash("Feil: " + (e.message ?? e));
    } finally {
      setLeverandoravtaleUploading(false);
    }
  }

  function setCustomerOrgNr(value: string) {
    const orgNr = value.replace(/\D/g, "").slice(0, 9);
    const existingCustomer = rows.find((r) => r.org_nr === orgNr);
    setForm((f) => ({
      ...f,
      org_nr: orgNr,
      selger: existingCustomer?.selger || f.selger || "",
    }));
    setTouched((t) => ({ ...t, org_nr: true }));
  }

  function handleRowAction(r: Malepunkt, action: string) {
    if (action === "advance") void advance(r);
    if (action === "back") void moveBack(r);
    if (action === "edit") startEdit(r);
    if (action === "history") void showHistory(r);
    if (action === "delete") void remove(r);
    if (action === "sjekk-cloud") void sjekkICloud(r);
  }

  // Slår opp i det ekte Adaptic Cloud API-et (ikke MCP) om måleren allerede
  // finnes der - se app/api/cloud/sjekk-malepunkt/route.ts.
  // Kjernelogikken for ett enkelt Cloud-oppslag, uten toast - gjenbrukes både
  // av enkeltrad-handlingen og bulk-sjekken. Oppdaterer status i databasen
  // (fremover, aldri bakover) når måleren faktisk finnes, og returnerer et
  // resultat til den som kalte, som selv bestemmer hvordan det vises frem.
  async function sjekkEnMaalerICloud(r: Malepunkt): Promise<
    { ok: true; funnet: false; merknad?: string } | { ok: true; funnet: true; melding: string } | { ok: false; error: string }
  > {
    try {
      const headers = await stromflytAuthHeaders();
      const qs = new URLSearchParams({ malepunkt_id: r.maalepunkt_id, cloud_org: r.cloud_org || "", bygg: r.bygg || "" });
      const res = await fetch(`/api/cloud/sjekk-malepunkt?${qs.toString()}`, { headers });
      const data = await res.json();
      if (!res.ok || !data.ok) return { ok: false, error: data.error || "Ukjent feil" };
      if (!data.funnet) return { ok: true, funnet: false, merknad: data.merknad };

      // Flytter status fremover automatisk basert på hva som faktisk finnes i
      // Cloud, ALDRI bakover - en rad som allerede er lenger fremme i egen
      // oppfølging (f.eks. manuelt satt til Aktiv) skal ikke reverseres bare
      // fordi datatilkoblingen ikke kunne bekreftes her.
      //
      // MEN: dette gjelder BARE rader som allerede er meldt inn og bekreftet
      // av Entelios (status >= Bekreftet). En rad som fremdeles står på
      // Kladd/Innmeldt/Klar for bestilling/Sendt Entelios er IKKE meldt inn
      // ennå - at måleren tilfeldigvis allerede har data i Cloud (fra en helt
      // annen sammenheng) er ingen grunn til å hoppe forbi selve
      // innmeldingssteget. Det var nettopp denne bug'en som sendte
      // Nesttun Invest-målere rett i "Satt opp i Cloud"/"Aktiv" uten at de
      // noensinne var meldt inn til Entelios (sept. 2026) - se
      // sql/audit-2026-09-21-hoppet-over-bekreftet.sql for opprydding.
      const foreslatt = data.foreslatt_status as Status | undefined;
      const alleredeMeldtInn = STAGES.indexOf(r.status) >= STAGES.indexOf("Bekreftet");
      let statusMelding = "";
      if (foreslatt && alleredeMeldtInn && STAGES.indexOf(foreslatt) > STAGES.indexOf(r.status)) {
        await updateStatus(r.id, foreslatt);
        statusMelding = ` → satt til «${displayStatus(foreslatt)}»`;
      } else if (foreslatt && !alleredeMeldtInn && STAGES.indexOf(foreslatt) > STAGES.indexOf(r.status)) {
        statusMelding = ` (Cloud viser «${displayStatus(foreslatt)}», men må meldes inn til Entelios først - status ikke endret)`;
      }
      // Lagre tsdb_id permanent på raden, ikke bare vise den i en toast - så
      // den kan tas ut i Excel og sendes videre til Entelios på historiske
      // målere som allerede er koblet opp i Cloud. cloud_metric_id lagres
      // samtidig - trengs for å hente faktisk forbruk senere uten et nytt
      // org-oppslag (se "Faktisk forbruk" i Oversikt).
      const detaljer: Partial<Malepunkt> = {};
      if (data.tsdb_id && data.tsdb_id !== r.tsdb_id) detaljer.tsdb_id = data.tsdb_id;
      if (data.cloud_metric_id && data.cloud_metric_id !== r.cloud_metric_id) detaljer.cloud_metric_id = data.cloud_metric_id;
      // Målenummer blokkerer ikke lenger innmelding fra Excel (se
      // excel-parser.ts) - fylles inn her i etterkant når Cloud faktisk vet
      // det, samme prinsipp som tsdb_id/cloud_metric_id over.
      if (data.malenummer && !r.maalenummer.trim()) detaljer.maalenummer = data.malenummer;
      // Årsforbruk mangler heller ikke sjelden fra kilden (Entelios sin egen
      // innmeldingsmal har ingen slik kolonne) - er måleren allerede i drift
      // i Cloud, bruk faktiske måledata som et estimat i stedet for å la
      // feltet stå tomt til noen finner det manuelt.
      let forbrukMelding = "";
      if (data.estimert_aarsforbruk_kwh && r.aarsforbruk_kwh == null) {
        detaljer.aarsforbruk_kwh = data.estimert_aarsforbruk_kwh;
        forbrukMelding = `, estimert årsforbruk ${fmt(data.estimert_aarsforbruk_kwh)} kWh`;
      }
      if (Object.keys(detaljer).length > 0) await updateMalepunktDetails(r.id, detaljer);
      return {
        ok: true,
        funnet: true,
        melding: `funnet i Cloud (${data.metode || "?"}) - bygg «${data.bygg ?? "?"}»${data.tsdb_id ? `, tsdb_id ${data.tsdb_id}` : ""}${statusMelding}${forbrukMelding}`,
      };
    } catch (e: any) {
      return { ok: false, error: e.message ?? String(e) };
    }
  }

  function klokkeslett() {
    return new Date().toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
  }

  async function sjekkICloud(r: Malepunkt) {
    flash("Systemene svarer", `Cloud-sjekk ${klokkeslett()}`);
    const result = await sjekkEnMaalerICloud(r);
    if (!result.ok) { flash("Feil ved Cloud-oppslag: " + result.error); return; }
    if (!result.funnet) {
      flash(result.merknad ? `${r.bygg}: ${result.merknad}` : `${r.bygg}: IKKE funnet i Adaptic Cloud ennå`);
      await refresh();
      return;
    }
    flash(`${r.bygg}: ${result.melding}`);
    await refresh();
  }

  // Sjekker alle valgte rader mot Cloud etter hverandre (ikke parallelt - vi
  // vil ikke hamre løs på Adaptic Cloud sitt API med mange samtidige kall for
  // hver rad, som gjerne allerede gjør 1-3 kall internt per måler).
  async function sjekkFlereICloud() {
    const targets = selectedRowsForBulk;
    if (!targets.length) return;
    let funnet = 0, ikkeFunnet = 0, feilet = 0;
    // Uten dette forsvant selve FEILMELDINGEN sporløst - "2 feilet" alene
    // sier ingenting om HVORFOR (feil cloud_org-navn? Cloud nede? tom
    // organisasjon?), og gjorde det umulig å feilsøke fra grensesnittet.
    const feilmeldinger: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      flash("Systemene svarer", `Cloud-sjekk ${i + 1}/${targets.length}: ${r.bygg}`);
      const result = await sjekkEnMaalerICloud(r);
      if (!result.ok) {
        feilet += 1;
        if (!feilmeldinger.includes(result.error)) feilmeldinger.push(result.error);
      }
      else if (result.funnet) funnet += 1;
      else ikkeFunnet += 1;
    }
    await refresh();
    flash(
      `Cloud-sjekk ferdig: ${funnet} funnet, ${ikkeFunnet} ikke funnet${feilet ? `, ${feilet} feilet` : ""}`,
      feilmeldinger.length ? feilmeldinger.slice(0, 2).join(" | ") : undefined,
    );
  }

  async function showHistory(r: Malepunkt) {
    setHistoryFor(r);
    setHistoryRows([]);
    setHistoryLoading(true);
    try { setHistoryRows(await listHistory(r.id)); }
    catch { flash("Historikk er tilgjengelig etter at sikkerhetsmigreringen er kjørt"); }
    finally { setHistoryLoading(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setShowAll(true);
    if (!isValid) { flash("Kan ikke meldes inn ennå"); return; }
    try {
      const aarsforbrukTomt = form.aarsforbruk_kwh === undefined || form.aarsforbruk_kwh === null || String(form.aarsforbruk_kwh).trim() === "";
      const payload = {
        kunde: form.kunde!, org_nr: form.org_nr!, selger: form.selger?.trim() || "", cloud_org: form.cloud_org!,
        bygg: form.bygg!, adresse: form.adresse!, maalenummer: form.maalenummer!,
        maalepunkt_id: form.maalepunkt_id!, netteier: form.netteier!, prisomrade: form.prisomrade!,
        aarsforbruk_kwh: aarsforbrukTomt ? null : Number(form.aarsforbruk_kwh), avtalt_oppstart: form.avtalt_oppstart || "",
        at_kode: form.at_kode || "",
        signert: !!form.signert, kommentar: form.kommentar ?? "",
        avtaletype: (form.avtaletype || "") as Malepunkt["avtaletype"],
        leverandoravtale_fil_sti: form.avtaletype === "Eierskifte" ? (form.leverandoravtale_fil_sti ?? null) : null,
        kontaktperson_navn: form.kontaktperson_navn?.trim() || "",
        kontaktperson_epost: form.kontaktperson_epost?.trim() || "",
        tsdb_id: form.tsdb_id ?? null,
        cloud_metric_id: form.cloud_metric_id ?? null,
      };
      if (editingId) {
        await updateMalepunktDetails(editingId, payload);
        await updateCustomerSeller(payload.org_nr, payload.selger);
        await updateCustomerKontaktperson(payload.org_nr, payload.kontaktperson_navn, payload.kontaktperson_epost);
      } else {
        await insertMalepunkt(payload);
        if (payload.selger) await updateCustomerSeller(payload.org_nr, payload.selger);
        if (payload.kontaktperson_navn || payload.kontaktperson_epost) {
          await updateCustomerKontaktperson(payload.org_nr, payload.kontaktperson_navn, payload.kontaktperson_epost);
        }
      }
      const bygg = form.bygg;
      const wasEditing = !!editingId;
      setEditingId(null); setForm({ ...emptyForm }); setTouched({}); setShowAll(false);
      await refresh(); setTab("reg"); flash(wasEditing ? `${bygg} oppdatert` : `${bygg} registrert internt`);
    } catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }

  async function sendBatch() {
    try { await markBatchSent(batchRows.map((r) => r.id)); const n = batchRows.length; setBatchOpen(false); await refresh(); flash(`${n} målepunkt markert som sendt til Entelios`); }
    catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((current) => checked
      ? current.includes(id) ? current : [...current, id]
      : current.filter((selectedId) => selectedId !== id));
  }

  function toggleAllVisible(checked: boolean) {
    const visibleIds = filtered.map((r) => r.id);
    setSelectedIds((current) => checked
      ? [...new Set([...current, ...visibleIds])]
      : current.filter((id) => !visibleIds.includes(id)));
  }

  async function markSelectedReady() {
    const ids = selectedRegisteredIds;
    if (!ids.length) { flash("Velg poster med status Registrert internt"); return; }
    if (!window.confirm(`Sette ${ids.length} valgte målepunkt som «Klar til Entelios»?`)) return;
    try {
      await updateStatuses(ids, "Klar for bestilling", "Innmeldt");
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      await refresh();
      flash(`${ids.length} målepunkt satt som klare til Entelios`);
    } catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }

  // Sett Eierskifte/Spotavtale på alle valgte rader samtidig - typisk brukt
  // når en hel kundes anlegg (f.eks. alle Bergensgruppen-målerne) avklares
  // til å gå på samme overtakelsestype, i stedet for å redigere hver rad.
  async function setSelectedAvtaletype(avtaletype: "Eierskifte" | "Spotavtale") {
    const ids = selectedRowsForBulk.map((r) => r.id);
    if (!ids.length) return;
    try {
      await updateAvtaletype(ids, avtaletype);
      await refresh();
      flash(`${ids.length} målepunkt satt til «${avtaletype === "Eierskifte" ? "Eierskifte · eiers vilkår" : "Over på vår spotavtale"}»`);
    } catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }

  // Retter opp cloud_org i etterkant på flere rader samtidig - typisk rett
  // etter en bulkimport (Excel/Kladd) der feltet bevisst ble stått åpent.
  // "Sjekk i Cloud" finner ingenting uten et cloud_org å søke i - tomt felt,
  // ikke feil i selve Cloud-oppslaget, er den vanlige årsaken til at en hel
  // bunke rader kommer tilbake som "ikke funnet".
  async function setSelectedCloudOrg(cloudOrg: string) {
    const ids = selectedRowsForBulk.map((r) => r.id);
    if (!ids.length || !cloudOrg.trim()) return;
    try {
      await updateCloudOrg(ids, cloudOrg.trim());
      await refresh();
      flash(`${ids.length} målepunkt satt til strøm-org «${cloudOrg.trim()}»`);
    } catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }

  // Samme regel som enkeltrad-slett: kun det som ikke er sendt til Entelios
  // ennå kan fjernes - unngår at noen ved et uhell slår sammen dette med
  // sletting av noe som allerede er ute av huset.
  async function removeSelected() {
    const targets = selectedRowsForBulk.filter((r) => r.status === "Kladd" || r.status === "Innmeldt" || r.status === "Klar for bestilling");
    if (!targets.length) { flash("Ingen av de valgte kan slettes (allerede sendt til Entelios eller senere)"); return; }
    if (!window.confirm(`Slette ${targets.length} valgte målepunkt fra registeret? Dette kan ikke angres.`)) return;
    let ok = 0;
    const failures: string[] = [];
    for (const r of targets) {
      try { await deleteMalepunkt(r.id); ok += 1; }
      catch (e: any) { failures.push(`${r.bygg}: ${e.message ?? e}`); }
    }
    setSelectedIds((current) => current.filter((id) => !targets.some((t) => t.id === id)));
    await refresh();
    if (ok) flash(`${ok} målepunkt slettet${failures.length ? `, ${failures.length} feilet` : ""}`);
    else flash(failures[0] || "Ingen målepunkt ble slettet");
  }
  function copyBatch() {
    const header = ENTELIOS_COLUMNS.map((c) => c.label).join("\t");
    const lines = batchRows.map((r) => ENTELIOS_COLUMNS.map((c) => String((r as any)[c.key] ?? "")).join("\t"));
    const tsv = [header, ...lines].join("\n");
    navigator.clipboard?.writeText(tsv).then(() => flash("Entelios-grunnlag kopiert"), () => flash("Kunne ikke kopiere"));
  }

  // Frem til vi har en Entelios-API-integrasjon sendes bestillinger på mail:
  // last ned vedlegget her, så åpne et ferdig utfylt mailutkast (bruker sender selv).
  const NORSKE_MANEDER = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];

  async function downloadEntelioBatchXlsx() {
    if (!batchRows.length) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Bestilling");
    ws.addRow(ENTELIOS_COLUMNS.map((c) => c.label));
    batchRows.forEach((r) => ws.addRow(ENTELIOS_COLUMNS.map((c) => (r as any)[c.key] ?? "")));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => { col.width = 20; });
    const buf = await wb.xlsx.writeBuffer();
    const now = new Date();
    const navn = `Adaptic - Bestilling ${NORSKE_MANEDER[now.getMonth()]} ${now.getFullYear()}.xlsx`;
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = navn;
    link.click();
    URL.revokeObjectURL(url);
    flash(`Lastet ned ${navn} (${batchRows.length} målepunkt)`);
  }

  function openEntelioEmailDraft() {
    if (!batchRows.length) return;
    const grupper = new Map<string, number>();
    batchRows.forEach((r) => {
      const key = r.avtalt_oppstart || "ukjent oppstart";
      grupper.set(key, (grupper.get(key) || 0) + 1);
    });
    const oppstartLinje = [...grupper.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dato, antall]) => `${dato} (${antall} målere)`)
      .join(", ");
    const body = [
      "Hei Inger Brit,",
      "",
      "Vi har samlet opp flere nye målere vi ønsker å få meldt inn.",
      "",
      "Vedlagt finner dere oversikt over alle nye målere med referansekode, overtagelsesdato og historikk.",
      `Ønsket overtakelse: ${oppstartLinje}.`,
      "[Rediger her ved behov, f.eks. om noen målere mangler historikk eller har alternativ overtakelsesdato.]",
      "",
      ENTELIOS_MAIL.kundenrLinje,
      "",
      "Bare ta kontakt om du har noen spørsmål!",
    ].join("\n");
    const params = new URLSearchParams({
      subject: ENTELIOS_MAIL.subject,
      cc: ENTELIOS_MAIL.cc.join(","),
      body,
    });
    window.location.href = `mailto:${ENTELIOS_MAIL.to}?${params.toString()}`;
    flash("Mailutkast åpnet - husk å legge ved den nedlastede Excel-filen før du sender");
  }

  async function downloadWorklist() {
    const columns: { label: string; value: (r: Malepunkt) => string | number }[] = [
      { label: "Kunde", value: (r) => r.kunde },
      { label: "Selger", value: (r) => r.selger || "" },
      { label: "Bygg", value: (r) => r.bygg },
      { label: "Adresse", value: (r) => r.adresse },
      { label: "MålepunktID", value: (r) => r.maalepunkt_id },
      { label: "Referansekode", value: (r) => r.at_kode || "" },
      { label: "Prisområde", value: (r) => r.prisomrade },
      { label: "Status", value: (r) => displayStatus(r.status) },
      { label: "Neste handling", value: (r) => nextStatus(r.status) ? displayStatus(nextStatus(r.status)!) : "Ferdig" },
      { label: "Oppstart", value: (r) => r.avtalt_oppstart || "" },
      { label: "Netteier", value: (r) => r.netteier },
      { label: "Årsforbruk (kWh)", value: (r) => r.aarsforbruk_kwh ?? "" },
      { label: "Overtakelse", value: (r) => r.avtaletype || "" },
      { label: "tsdb_id", value: (r) => r.tsdb_id || "" },
      { label: "Kommentar", value: (r) => r.kommentar || "" },
    ];
    // Full eksport uavhengig av kolonnevisningen på skjermen - dette er ment
    // som et komplett uttrekk, ikke bare det som er slått på i tabellen.
    // Er noe huket av i arbeidslisten, eksporter kun de valgte radene -
    // ellers hele det filtrerte utvalget.
    const eksportRader = selectedRowsForBulk.length > 0 ? selectedRowsForBulk : filtered;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Arbeidsliste");
    ws.addRow(columns.map((c) => c.label));
    eksportRader.forEach((r) => ws.addRow(columns.map((c) => c.value(r))));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => { col.width = 20; });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stromflyt-arbeidsliste-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
    flash(`${eksportRader.length} rader lastet ned`);
  }

  // Adaptic-fronten selgeren laster ned fra Kladd-fanen for å bruke i eget
  // avtalearbeid - egen, penere stil enn den interne arbeidslisteeksporten
  // (bransjelogo finnes ikke ennå, se merknad i sidenav - bruker firmanavn +
  // aksentfarge i stedet, samme stil som resten av appen).
  async function eksporterKladd() {
    const eksportRader = selectedRowsForBulk.length > 0 ? selectedRowsForBulk : filtered;
    if (!eksportRader.length) { flash("Ingen kladd-rader å eksportere"); return; }
    const columns: { label: string; value: (r: Malepunkt) => string | number; width: number; numFmt?: string; align?: "right" }[] = [
      { label: "Kunde", value: (r) => r.kunde, width: 26 },
      { label: "Bygg", value: (r) => r.bygg, width: 26 },
      { label: "Adresse", value: (r) => r.adresse, width: 28 },
      { label: "Målenummer", value: (r) => r.maalenummer || "", width: 20 },
      { label: "MålepunktID", value: (r) => r.maalepunkt_id, width: 22 },
      { label: "Netteier", value: (r) => r.netteier, width: 16 },
      { label: "Prisområde", value: (r) => r.prisomrade, width: 12 },
      { label: "Årsforbruk (kWh)", value: (r) => r.aarsforbruk_kwh ?? "", width: 16, numFmt: "#,##0", align: "right" },
      { label: "Kommentar", value: (r) => r.kommentar || "", width: 32 },
    ];

    const wb = new ExcelJS.Workbook();
    wb.creator = "Adaptic Technology AS - Strømflyt";
    const ws = wb.addWorksheet("Kladd");
    const lastCol = columns.length;

    ws.mergeCells(1, 1, 1, lastCol);
    const tittel = ws.getCell(1, 1);
    tittel.value = "Adaptic Technology AS";
    tittel.font = { bold: true, size: 18, color: { argb: "FF10202E" } };
    tittel.alignment = { vertical: "middle" };
    ws.getRow(1).height = 30;

    ws.mergeCells(2, 1, 2, lastCol);
    const undertittel = ws.getCell(2, 1);
    const kunder = [...new Set(eksportRader.map((r) => r.kunde).filter(Boolean))];
    undertittel.value = `Strømflyt · Kladd-liste${kunder.length === 1 ? ` - ${kunder[0]}` : ""} · ${new Date().toLocaleDateString("nb-NO")}`;
    undertittel.font = { size: 12, color: { argb: "FF566571" } };
    ws.getRow(2).height = 20;

    const overskriftRad = 4;
    ws.getRow(overskriftRad).values = columns.map((c) => c.label);
    const overskrift = ws.getRow(overskriftRad);
    overskrift.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF009C91" } };
      cell.alignment = { vertical: "middle" };
    });
    overskrift.height = 20;

    eksportRader.forEach((r, i) => {
      const row = ws.getRow(overskriftRad + 1 + i);
      row.values = columns.map((c) => c.value(r));
      columns.forEach((c, ci) => {
        const cell = row.getCell(ci + 1);
        if (c.numFmt) cell.numFmt = c.numFmt;
        if (c.align) cell.alignment = { horizontal: c.align };
        if (i % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F7F9" } };
      });
    });

    columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
    ws.views = [{ state: "frozen", ySplit: overskriftRad }];

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const filnavnKunde = kunder.length === 1 ? `-${kunder[0].toLowerCase().replace(/[^a-z0-9æøå]+/g, "-").replace(/(^-|-$)/g, "")}` : "";
    link.download = `adaptic-kladd${filnavnKunde}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
    flash(`${eksportRader.length} rader lastet ned`);
  }

  async function eksporterNyeAvtaler() {
    if (!nyeAvtaler.length) { flash("Ingen nye avtaler å eksportere"); return; }
    const columns: { label: string; value: (a: NyAvtale) => string | number }[] = [
      { label: "Status", value: (a) => a.status },
      { label: "Avtale", value: (a) => a.avtalenavn },
      { label: "Kunde", value: (a) => a.kunde },
      { label: "AT-kode", value: (a) => a.at_nummer },
      { label: "Signert", value: (a) => a.signert_dato ?? "" },
      { label: "Beløp", value: (a) => a.belop ?? "" },
      { label: "PandaDoc", value: (a) => a.pandadoc_url },
      { label: "Kommentar", value: (a) => a.kommentar },
      { label: "Opprettet", value: (a) => a.opprettet },
    ];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Nye avtaler");
    ws.addRow(columns.map((c) => c.label));
    nyeAvtaler.forEach((a) => ws.addRow(columns.map((c) => c.value(a))));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => { col.width = 22; });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stromflyt-nye-avtaler-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
    flash(`${nyeAvtaler.length} avtaler lastet ned`);
  }

  const errFor = (name: string) => ((showAll || touched[name]) && errors[name]) || "";
  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selectedIds.includes(r.id));

  if (needsPassword) {
    return <div className="sf-root auth-root">
      <style>{CSS}</style>
      <form className="login-card" onSubmit={finishInvitation}>
        <span className="spark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="currentColor" /></svg></span>
        <div><h1>{passwordContext === "invite" ? "Velg passord" : "Sett nytt passord"}</h1><p>{passwordContext === "invite" ? "Invitasjonen er godkjent. Opprett passordet du skal bruke i Strømflyt." : "Opprett et nytt passord for Strømflyt-kontoen din."}</p></div>
        <Field label="Nytt passord"><input type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></Field>
        <Field label="Gjenta passord"><input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></Field>
        {passwordError && <div className="banner">{passwordError}</div>}
        <button className="btn primary" disabled={authLoading}>{authLoading ? "Lagrer …" : "Lagre passord"}</button>
        {passwordContext === "account" && <button className="btn" type="button" onClick={() => setNeedsPassword(false)}>Avbryt</button>}
      </form>
    </div>;
  }

  if (requireAuth && (authLoading || !userEmail)) {
    return <div className="sf-root auth-root">
      <style>{CSS}</style>
      <form className="login-card" onSubmit={signIn}>
        <span className="spark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="currentColor" /></svg></span>
        <div><h1>Logg inn i Strømflyt</h1><p>Kun inviterte Adaptic-brukere har tilgang.</p></div>
        <Field label="E-post"><input type="email" autoComplete="email" required value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} /></Field>
        <Field label="Passord"><input type="password" autoComplete="current-password" required value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} /></Field>
        {loginError && <div className="banner">{loginError}</div>}
        <button className="btn primary" disabled={authLoading}>{authLoading ? "Logger inn …" : "Logg inn"}</button>
      </form>
    </div>;
  }

  // Delt mellom "Last opp strømfaktura"-siden (tab==="faktura", nåbar fra
  // "+ Ny") og selve Kladd-fanen (tab==="reg", workFilter==="kladd") - selger
  // skal kunne laste opp en faktura og se resultatet dukke opp rett under, i
  // stedet for å måtte laste opp ett sted og lete etter resultatet et annet.
  function renderFakturaOpplasting() {
    return (
      <>
        <div
          className={"upload-card drop-zone" + (dragTarget === "faktura" ? " dragging" : "")}
          onDragOver={(e) => { e.preventDefault(); setDragTarget("faktura"); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragTarget(null); }}
          onDrop={(e) => dropFile(e, "faktura")}
        >
          <span className="drop-zone-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V4M12 4 7 9M12 4l5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
          </span>
          <h2>Last opp strømfaktura</h2>
          <p>Dra en inngående strømfaktura hit (PDF, fra netteier eller kraftleverandør). Systemet leser målenummer, MålepunktID, adresse, netteier og forbruk uansett hvilket oppsett fakturaen har - ulike leverandører (Entelios, Lnett, Fjordkraft osv.) ser helt forskjellige ut. Du kontrollerer alltid funnene før de lagres.</p>
          <span className="drop-zone-or">eller</span>
          <label className="upload-btn">
            <input type="file" accept="application/pdf,.pdf" disabled={fakturaParsing || fakturaSaving} onChange={(e) => parseFaktura(e.target.files?.[0])} />
            {fakturaParsing ? "Leser fakturaen …" : "Velg strømfaktura"}
          </label>
        </div>

        {fakturaRows && (
          <div className="import-review">
            <div className="panel import-summary">
              <div className="hd">
                <h2>Kontroller funnene</h2>
                <span className="sub">{fakturaName} · {fakturaRows.length} målepunkt funnet{fakturaRows.length > 1 ? " i dokumentet" : ""}</span>
              </div>
              {fakturaRows.length > 1 && (
                <div className="banner" style={{ margin: "0 18px 18px", background: "var(--sf-accent-soft)", color: "var(--sf-accent)" }}>
                  Denne PDF-en inneholder flere målere - kontroller hver rad for seg, de kan gjelde ulike adresser eller til og med ulike leverandører.
                </div>
              )}

              <div className="import-org">
                <label>Kunde/organisasjon</label>
                <input list="faktura-kunde-list" value={fakturaKunde} onChange={(e) => handleFakturaKundeChange(e.target.value)} placeholder="Kundens navn" />
                <datalist id="faktura-kunde-list">{[...new Set(rows.map((r) => r.kunde).filter(Boolean))].map((k) => <option key={k} value={k} />)}</datalist>
                <span>
                  {(() => {
                    const count = fakturaKunde.trim() ? rows.filter((r) => r.kunde.trim().toLowerCase() === fakturaKunde.trim().toLowerCase()).length : 0;
                    return fakturaKunde.trim()
                      ? `${count} målepunkt allerede registrert på ${fakturaKunde.trim()} fra før${count > 0 ? " - org.nr/Cloud-org fylt inn automatisk under" : ""}.`
                      : "Skriv inn eller velg fra listen - kjent kunde fyller resten ut automatisk.";
                  })()}
                </span>
              </div>
              <div className="import-org">
                <label>Org.nr</label>
                <input className="num" maxLength={9} value={fakturaOrgNr} onChange={(e) => handleFakturaOrgNrChange(e.target.value)} placeholder="9 siffer" />
                <span>{fakturaEnhetMsg || "Skriv inn org.nr for å hente kundenavn automatisk fra Brønnøysundregistrene."}</span>
              </div>
              <div className="import-org">
                <label>Cloud-org</label>
                <input list="faktura-cloud-orgs" value={fakturaCloudOrg} onChange={(e) => setFakturaCloudOrg(e.target.value)} />
                <datalist id="faktura-cloud-orgs">{CLOUD_ORGS.map((o) => <option key={o} value={o} />)}</datalist>
                <span>Hvilken organisasjon i Adaptic Cloud målepunktene hører til - gjelder alle valgte rader under.</span>
              </div>
              <div className="import-org">
                <label className="checkline"><input type="checkbox" checked={fakturaSignert} onChange={(e) => setFakturaSignert(e.target.checked)} /> Avtalen er signert</label>
                <span />
                <span>Gjelder alle valgte rader. Kan ikke sendes til Entelios før dette er krysset av.</span>
              </div>
            </div>

            <div className="toolbar">
              <strong>{Object.values(fakturaSelected).filter(Boolean).length} av {fakturaRows.length} valgt</strong>
              <span className="muted">Nye, gyldige rader er valgt automatisk. Dubletter er avhuket.</span>
              <span className="grow" />
              <button className="btn primary" disabled={fakturaSaving || !Object.values(fakturaSelected).some(Boolean)} onClick={saveFaktura}>
                {fakturaSaving ? "Lagrer …" : `Legg ${Object.values(fakturaSelected).filter(Boolean).length} i registeret`}
              </button>
            </div>

            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th />
                  <th>Adresse</th><th>Målenummer</th><th>MålepunktID</th><th>Netteier</th><th>Prisområde</th>
                  <th className="num">Årsforbruk</th><th>Fakturadato</th><th>Kontroll</th>
                </tr></thead>
                <tbody>{fakturaRows.map((r, i) => {
                  const duplicate = rows.some((existing) => existing.maalepunkt_id === r.malepunkt_id);
                  const idBad = r.malepunkt_id.length !== 18;
                  return (
                    <tr key={`${r.malepunkt_id}-${i}`}>
                      <td><input type="checkbox" checked={!!fakturaSelected[i]} disabled={duplicate} onChange={(e) => setFakturaSelected((s) => ({ ...s, [i]: e.target.checked }))} /></td>
                      <td>{r.adresse}{r.postnr && <div className="muted">{r.postnr} {r.poststed}</div>}</td>
                      <td className="num">{r.malenummer}</td>
                      <td className="num" style={idBad ? { color: "var(--sf-crit)" } : undefined}>{r.malepunkt_id || "mangler"}</td>
                      <td><input className="compact-input" value={fakturaRowNetteier[i] ?? r.netteier} onChange={(e) => setFakturaRowNetteier((n) => ({ ...n, [i]: e.target.value }))} /></td>
                      <td>
                        <input className="compact-input" style={{ width: 60 }} placeholder="NO1-NO5" value={fakturaRowPrisomrade[i] ?? ""} onChange={(e) => setFakturaRowPrisomrade((p) => ({ ...p, [i]: e.target.value }))} />
                        {fakturaRowLookupMsg[i] && <div className="muted" style={{ fontSize: 11 }}>{fakturaRowLookupMsg[i]}</div>}
                      </td>
                      <td className="num">{r.arsforbruk_kwh != null ? fmt(r.arsforbruk_kwh) : "-"}</td>
                      <td className="num">{r.fakturadato || "-"}</td>
                      <td>
                        {duplicate
                          ? <span className="pill s-kladd">Finnes allerede</span>
                          : idBad
                            ? <span className="pill" style={{ color: "var(--sf-crit)", background: "var(--sf-crit-soft)" }}>MålepunktID ≠ 18 siffer</span>
                            : r.usikre_felt.length
                              ? <span className="pill s-klar" title={r.usikre_felt.join(", ")}>Usikker: {r.usikre_felt[0]}{r.usikre_felt.length > 1 ? ` +${r.usikre_felt.length - 1}` : ""}</span>
                              : <span className="pill s-aktiv">Klar</span>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="sf-root">
      <style>{CSS}</style>

      <div className="app-shell">
        <header className="topbar">
          <div className="brand-panel">
            <span className="spark" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="currentColor" /></svg>
            </span>
            <div>
              <h1>Strømflyt</h1>
              <p>ADAPTIC · INNMELDING OG REGISTER</p>
            </div>
          </div>

          {/* Globalt søk. Arbeidslistens eget søk finner bare i den køen man
              står i akkurat da; dette finner et målepunkt uansett hvor det
              ligger, og hopper rett til arbeidslisten med treffet forhåndsfylt. */}
          <div className="globalsok">
            <div className="globalsok-felt">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input
                type="search"
                placeholder="Søk kunde, adresse, MålepunktID, AT-kode …"
                value={globalSearch}
                onChange={(e) => { setGlobalSearch(e.target.value); setGlobalSearchOpen(true); }}
                onFocus={() => setGlobalSearchOpen(true)}
              />
            </div>
            {globalSearchOpen && globalSearch.trim() && (
              <>
                <div className="dropdown-backdrop" onClick={() => setGlobalSearchOpen(false)} />
                <div className="globalsok-treff">
                  {globalMatches.length === 0 && <div className="globalsok-tom">Ingen treff</div>}
                  {globalMatches.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setSearch(globalSearch.trim());
                        setTab("reg");
                        setWorkFilter("");
                        setFltStatus("");
                        setGlobalSearchOpen(false);
                        setGlobalSearch("");
                      }}
                    >
                      <span className="globalsok-tittel">{r.kunde || "Uten kunde"} · {r.bygg}</span>
                      <span className="globalsok-under"><span>{r.adresse}</span><span className="num">{r.maalepunkt_id}</span><span>{displayStatus(r.status)}</span></span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="top-actions">
            <div className="ny-meny">
              <button className="ny-knapp" aria-haspopup="menu" aria-expanded={nyOpen} onClick={() => setNyOpen((open) => !open)}>+ Ny</button>
              {nyOpen && (
                <>
                  <div className="dropdown-backdrop" onClick={() => setNyOpen(false)} />
                  <div className="ny-panel" role="menu">
                    <button role="menuitem" onClick={() => { setTab("import"); setNyOpen(false); }}>
                      <span className="ny-tittel">Last opp PDF-avtale</span>
                      <span className="ny-hint">Les beløp og datoer rett ut av signert avtale</span>
                    </button>
                    <button role="menuitem" onClick={() => { newManualEntry(); setNyOpen(false); }}>
                      <span className="ny-tittel">Ny registrering</span>
                      <span className="ny-hint">Legg inn et målepunkt for hånd</span>
                    </button>
                    <button role="menuitem" onClick={() => { setTab("excel"); setNyOpen(false); }}>
                      <span className="ny-tittel">Importer målepunktliste</span>
                      <span className="ny-hint">Les inn hele arbeidsboken på nytt</span>
                    </button>
                    <button role="menuitem" onClick={() => { setTab("faktura"); setNyOpen(false); }}>
                      <span className="ny-tittel">Last opp strømfaktura</span>
                      <span className="ny-hint">Les målenummer, MålepunktID, adresse og forbruk automatisk</span>
                    </button>
                  </div>
                </>
              )}
            </div>
            <button className="icon-btn" onClick={refresh} title="Oppdater data" aria-label="Oppdater data">↻</button>
            {requireAuth && <div className="profile-menu-wrap">
              <button className="profile-trigger" aria-haspopup="menu" aria-expanded={profileOpen} onClick={() => setProfileOpen((open) => !open)}>
                <span className="profile-avatar" aria-hidden="true">{displayNameFromEmail(userEmail).charAt(0)}</span>
                <span>{displayNameFromEmail(userEmail)}</span>
                <span className="profile-chevron" aria-hidden="true">⌄</span>
              </button>
              {profileOpen && (
                <>
                  <div className="dropdown-backdrop" onClick={() => setProfileOpen(false)} />
                  <div className="profile-menu" role="menu">
                    <div className="profile-identity">
                      <span>Innlogget som</span>
                      <b>{displayNameFromEmail(userEmail)}</b>
                      <small>{userEmail}</small>
                    </div>
                    <button role="menuitem" onClick={() => { setProfileOpen(false); setPasswordContext("account"); setNewPassword(""); setConfirmPassword(""); setPasswordError(""); setNeedsPassword(true); }}>Endre passord</button>
                    <button role="menuitem" className="profile-logout" onClick={signOut}>Logg ut</button>
                  </div>
                </>
              )}
            </div>}
          </div>
        </header>

        <div className="app-body">
          <nav className="sidenav" aria-label="Hovedmeny">
            <div className="sidenav-merke">ARBEIDSFLATE</div>
            <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
              <svg className="sidenav-ikon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
              <span>Oversikt</span>
            </button>
            <button className={tab === "reg" && workFilter === "" ? "active" : ""} onClick={() => { setTab("reg"); setWorkFilter(""); setFltStatus(""); }}>
              <svg className="sidenav-ikon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
              <span>Arbeidsliste</span>
            </button>
            {/* Nye avtaler kommer automatisk fra fakturakontroll når en ren
                strømleveranse blir signert. De har ingen målepunkter ennå, og
                står derfor foran resten av løpet. */}
            <button className={tab === "nye" ? "active" : ""} onClick={() => setTab("nye")}>
              <svg className="sidenav-ikon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
              <span>Nye avtaler</span>
              {nyeAvtaler.filter((a) => a.status === "Ny" || a.status === "Under arbeid").length > 0 && (
                <span className="sidenav-tall varsel">
                  {nyeAvtaler.filter((a) => a.status === "Ny" || a.status === "Under arbeid").length}
                </span>
              )}
            </button>
            {/* For selgere som utarbeider en avtale før den finnes - laster
                opp strømfaktura og får målepunktene hentet ut som Kladd,
                lenge før noe sendes til Entelios. */}
            <button className={tab === "reg" && workFilter === "kladd" ? "active" : ""} onClick={() => { setTab("reg"); setWorkFilter("kladd"); setFltStatus(""); }}>
              <svg className="sidenav-ikon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              <span>Kladd</span>
              {rows.filter((r) => r.status === "Kladd").length > 0 && (
                <span className="sidenav-tall">{rows.filter((r) => r.status === "Kladd").length}</span>
              )}
            </button>
            <button className={tab === "form" ? "active" : ""} onClick={newManualEntry}>
              <svg className="sidenav-ikon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>
              <span>Registrering</span>
            </button>
            <div className="sidenav-merke">STATUSKØER</div>
            {WORK_FILTERS.filter((f) => f.key && !f.skjult).map((f) => {
              const count = rows.filter((r) => f.statuses.includes(r.status)).length;
              const active = tab === "reg" && workFilter === f.key;
              return (
                <button key={f.key} className={active ? "active" : ""} onClick={() => { setTab("reg"); setWorkFilter(f.key); setFltStatus(""); }}>
                  <span>{f.label}</span>
                  {count > 0 && <span className={`sidenav-tall${f.key === "handling" ? " varsel" : ""}`}>{count}</span>}
                </button>
              );
            })}
            <div className="sidenav-fot">
              <span className="sidenav-status-dot" aria-hidden="true" />
              <span>{loading ? "Henter register …" : sistOppdatert ? `Oppdatert ${sistOppdatert.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}` : "Ikke oppdatert ennå"}</span>
            </div>
          </nav>

          <div className="content-shell">
      <main>
        {err && <div className="banner">Kunne ikke laste registeret: {err}</div>}

        {tab === "nye" && (
          <section>
            {nyeAvtaler.some((a) => a.status === "Ny" || a.status === "Under arbeid") && (
              <div className="venter-varsel">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
                {nyeAvtaler.filter((a) => a.status === "Ny" || a.status === "Under arbeid").length} venter på handling
              </div>
            )}
            <div className="worklist-heading">
              <div>
                <h1>Signerte avtaler</h1>
                <span>Bekreft avtalen, hent anleggsdata og opprett målepunktutkast.</span>
              </div>
              <button className="btn" onClick={() => void eksporterNyeAvtaler()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -2 }}><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
                Eksporter
              </button>
            </div>

            {nyeAvtaler.length === 0 ? (
              <p className="muted" style={{ marginTop: 16 }}>
                Ingen nye avtaler. De dukker opp her automatisk når en ren strømleveranse blir
                signert og registrert i fakturakontrollen.
              </p>
            ) : (
              <>
                <div className="nye-faner">
                  <button
                    className={nyeFane === "aktiv" ? "active" : ""}
                    onClick={() => setNyeFane("aktiv")}
                  >
                    Krever handling <span className="nye-faner-tall">{nyeAvtaler.filter((a) => a.status === "Ny" || a.status === "Under arbeid").length}</span>
                  </button>
                  <button
                    className={nyeFane === "ferdig" ? "active" : ""}
                    onClick={() => setNyeFane("ferdig")}
                  >
                    Ferdig <span className="nye-faner-tall">{nyeAvtaler.filter((a) => a.status === "Klargjort" || a.status === "Avvist").length}</span>
                  </button>
                </div>
                <div className="panel" style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Avtale</th>
                      <th>Signert</th>
                      <th style={{ textAlign: "right" }}>Beløp</th>
                      <th>Dokument</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {nyeAvtaler.filter((a) => (nyeFane === "aktiv") === (a.status === "Ny" || a.status === "Under arbeid")).map((a) => {
                      const ferdig = a.status === "Klargjort" || a.status === "Avvist";
                      const lagreFelt = (patch: Partial<Pick<NyAvtale, "kunde" | "avtalenavn" | "belop" | "at_nummer" | "kommentar" | "pandadoc_url" | "signert_dato">>) =>
                        void oppdaterNyAvtale(a.id, patch).then(refresh).catch((e) => flash("Kunne ikke lagre: " + (e.message ?? e)));
                      const slippFil = (file: File | undefined) => {
                        if (!file) return;
                        setTab("import");
                        void parsePdf(file, a);
                      };
                      return (
                        <tr
                          key={a.id}
                          className={nyAvtaleDrag === a.id ? "ny-avtale-drag-over" : undefined}
                          style={ferdig ? { opacity: 0.55 } : undefined}
                          onDragOver={(e) => { if (ferdig) return; e.preventDefault(); setNyAvtaleDrag(a.id); }}
                          onDragLeave={() => setNyAvtaleDrag((d) => (d === a.id ? null : d))}
                          onDrop={(e) => {
                            if (ferdig) return;
                            e.preventDefault();
                            setNyAvtaleDrag(null);
                            slippFil(e.dataTransfer.files?.[0]);
                          }}
                        >
                          <td><span className={"pill " + (a.status === "Klargjort" ? "s-aktiv" : a.status === "Avvist" ? "s-kladd" : "s-innmeldt")}>{a.status}</span></td>
                          <td style={{ whiteSpace: "normal", minWidth: 240 }}>
                            <div className="ny-avtale-edit">
                              <input
                                key={a.id + "-navn"}
                                className="ny-avtale-navn"
                                defaultValue={a.avtalenavn}
                                disabled={ferdig}
                                onBlur={(e) => { if (e.target.value !== a.avtalenavn) lagreFelt({ avtalenavn: e.target.value }); }}
                              />
                              <div className="ny-avtale-rad2">
                                <input
                                  key={a.id + "-kunde"}
                                  className="ny-avtale-kunde"
                                  placeholder="Kunde"
                                  defaultValue={a.kunde}
                                  disabled={ferdig}
                                  onBlur={(e) => { if (e.target.value !== a.kunde) lagreFelt({ kunde: e.target.value }); }}
                                />
                                <span className="ny-avtale-sep">·</span>
                                <input
                                  key={a.id + "-at"}
                                  className="ny-avtale-at"
                                  placeholder="AT-kode"
                                  defaultValue={a.at_nummer}
                                  disabled={ferdig}
                                  onBlur={(e) => { if (e.target.value !== a.at_nummer) lagreFelt({ at_nummer: e.target.value }); }}
                                />
                              </div>
                              <input
                                key={a.id + "-kommentar"}
                                placeholder="Kommentar"
                                defaultValue={a.kommentar}
                                disabled={ferdig}
                                onBlur={(e) => { if (e.target.value !== a.kommentar) lagreFelt({ kommentar: e.target.value }); }}
                              />
                            </div>
                          </td>
                          <td className="num">
                            {!ferdig && nyAvtaleDatoRedigerer === a.id ? (
                              <input
                                key={a.id + "-signert"}
                                type="date"
                                className="ny-avtale-dato"
                                autoFocus
                                defaultValue={a.signert_dato ?? ""}
                                onBlur={(e) => {
                                  if (e.target.value !== (a.signert_dato ?? "")) lagreFelt({ signert_dato: e.target.value || null });
                                  setNyAvtaleDatoRedigerer(null);
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="ny-avtale-dato-visning"
                                disabled={ferdig}
                                onClick={() => setNyAvtaleDatoRedigerer(a.id)}
                                title={ferdig ? undefined : "Klikk for å endre"}
                              >
                                {a.signert_dato ? relativDato(a.signert_dato) : relativDatoMedKlokke(a.opprettet)}
                              </button>
                            )}
                          </td>
                          <td className="num" style={{ textAlign: "right" }}>
                            <input
                              key={a.id + "-belop"}
                              type="number"
                              className="ny-avtale-belop"
                              defaultValue={a.belop ?? ""}
                              disabled={ferdig}
                              onBlur={(e) => {
                                const v = e.target.value === "" ? null : Number(e.target.value);
                                if (v !== a.belop) lagreFelt({ belop: v });
                              }}
                            />
                          </td>
                          <td style={{ minWidth: 145 }}>
                            {a.pandadoc_url ? (
                              <a className="ny-avtale-pandadoc-link" href={a.pandadoc_url} target="_blank" rel="noreferrer">
                                Åpne i PandaDoc
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></svg>
                              </a>
                            ) : (
                              <input
                                key={a.id + "-pandadoc"}
                                className="ny-avtale-lenke"
                                placeholder="Lim inn PandaDoc-lenke"
                                defaultValue={a.pandadoc_url}
                                disabled={ferdig}
                                onBlur={(e) => { if (e.target.value !== a.pandadoc_url) lagreFelt({ pandadoc_url: e.target.value.trim() }); }}
                              />
                            )}
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <div className="ny-avtale-knapper">
                              {a.pandadoc_url && (
                                <a className="btn primary sm" href={a.pandadoc_url} target="_blank" rel="noreferrer">
                                  Åpne avtale
                                </a>
                              )}
                              {!ferdig && (
                                <label className={"btn sm ny-avtale-hent" + (a.pandadoc_url ? "" : " primary")} title="Dra avtale-PDF-en hit, eller klikk for å velge fil - leser ut målepunktene automatisk">
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M12 18v-6m0 0-2.5 2.5M12 12l2.5 2.5" /></svg>
                                  {a.pandadoc_url ? "Last opp avtale" : "Bekreft og hent"}
                                  <input type="file" accept="application/pdf" onChange={(e) => { slippFil(e.target.files?.[0]); e.target.value = ""; }} />
                                </label>
                              )}
                              {a.status === "Ny" && (
                                <button className="btn sm" disabled={nyeJobber === a.id}
                                  onClick={() => settNyStatus(a, "Under arbeid")}>
                                  Under arbeid
                                </button>
                              )}
                              {a.status === "Under arbeid" && (
                                <button className="btn sm" disabled={nyeJobber === a.id}
                                  onClick={() => settNyStatus(a, "Klargjort")}>
                                  {nyeJobber === a.id ? "Lagrer ..." : "Merk klargjort"}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            )}
          </section>
        )}

        {tab === "overview" && (
          <section className="overview-page">
            <div className="page-heading">
              <div><h1>Driftsbildet</h1><span>Det som trenger oppmerksomhet først.</span></div>
              <div className="page-heading-hoyre">
                {sistOppdatert && <span className="sist-oppdatert">Oppdatert {sistOppdatert.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}</span>}
                <button className="btn" onClick={refresh}>Oppdater oversikt</button>
              </div>
            </div>

            <div className="tiles">
              <Tile k="Målepunkt totalt" v={String(tiles.total)} sub={tiles.nyeDenneUken > 0 ? `+${tiles.nyeDenneUken} denne uken` : undefined} />
              <Tile k="Ikke meldt inn" v={String(tiles.trenger)} sub="uansett status - før sending til Entelios" alert={tiles.trenger > 0} />
              <Tile
                k="Eierskifte / Spotavtale"
                v={<><span className="tile-v-num">{tiles.spotavtale}</span><span className="tile-v-unit"> spot</span><span className="tile-v-sep"> · </span><span className="tile-v-num">{tiles.eierskifte}</span><span className="tile-v-unit"> eierskifte</span></>}
                sub={`${tiles.ikkeAvklart} ikke avklart ennå`}
                alert={tiles.ikkeAvklart > 0}
                bar={tiles.total > 0 ? (
                  <div className="tile-bar" title={`${tiles.eierskifte} eierskifte · ${tiles.spotavtale} spotavtale · ${tiles.ikkeAvklart} ikke avklart`}>
                    <span style={{ width: `${(tiles.eierskifte / tiles.total) * 100}%` }} className="seg-1" />
                    <span style={{ width: `${(tiles.spotavtale / tiles.total) * 100}%` }} className="seg-2" />
                  </div>
                ) : undefined}
              />
              <Tile
                k="Estimert GWh sendt Entelios"
                v={`${tiles.gwhRegistrert.toFixed(2)} GWh`}
                sub={`anslag, ikke målt · ${tiles.registrertAntall} målepunkt${tiles.registrertUtenForbruk > 0 ? ` · ${tiles.registrertUtenForbruk} mangler årsforbruk` : ""}`}
                alert={tiles.registrertUtenForbruk > 0}
              />
              <Tile
                k="Totalt solgt volum"
                v={`${tiles.gwhSolgtTotalt.toFixed(2)} GWh`}
                sub={`anslag, alle ${tiles.total} - uansett status · ${tiles.solgtUtenForbruk > 0 ? `${tiles.solgtUtenForbruk} mangler årsforbruk` : "alle har årsforbruk"}`}
                alert={tiles.solgtUtenForbruk > 0}
              />
            </div>

            <div className="overview-2col">
              <div className="panel livslop">
                <div className="hd">
                  <div><h2>Livsløp</h2><span className="sub">Fordeling på hvert steg</span></div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="livslop-puls" aria-hidden="true"><path d="M3 12h4l2-7 4 14 3-9 2 4h3" /></svg>
                </div>
                <div className="livslop-soyler">
                  {livslop.map((s, i) => (
                    <div className="livslop-soyle-col" key={s.status}>
                      <span className="livslop-soyle-val">{s.antall}</span>
                      <div className="livslop-soyle-track">
                        <div
                          className={"livslop-soyle" + (i === STAGES.length - 1 ? " naa" : "")}
                          style={{ height: `${(s.antall / s.maks) * 100}%` }}
                        />
                      </div>
                      <span className="livslop-soyle-label">{displayStatus(s.status)}</span>
                    </div>
                  ))}
                </div>
                <button
                  className="livslop-revisjon"
                  onClick={() => { setTab("reg"); setWorkFilter("revisjon"); setFltStatus(""); }}
                  title="Ikke en arbeidskø - viser ALT som er bekreftet av Entelios, uansett om det har kommet videre til Cloud-oppsett eller er aktivt i drift"
                >
                  Bekreftet av Entelios totalt: <b>{bekreftetTotalt.antall}</b> av {bekreftetTotalt.avTotalt} →
                </button>
              </div>

              <div className="panel volum-chart">
                <div className="hd">
                  <div>
                    <h2>Registrert volum</h2>
                    <span className="sub">
                      {volumVisning === "maned" && (
                        <>GWh nytt volum per måned · estimert, ikke målt forbruk{volumChart.antallUtenOppstart > 0 && ` · ${volumChart.gwhUtenOppstart.toFixed(2)} GWh (${volumChart.antallUtenOppstart} målepunkt) mangler oppstartsdato og vises ikke her`}</>
                      )}
                      {volumVisning === "kumulativt" && (
                        <>GWh totalt akkumulert · estimert helårstotal {volumChart.total.toFixed(2)} GWh{volumChart.antallUtenOppstart > 0 && ` (+ ${volumChart.gwhUtenOppstart.toFixed(2)} GWh mangler oppstartsdato, vises ikke her)`}</>
                      )}
                      {volumVisning === "faktisk" && (
                        faktiskLaster ? "Henter faktisk forbruk fra Cloud …"
                        : faktiskFeil ? `Kunne ikke hente: ${faktiskFeil}`
                        : faktiskForbruk
                        ? `GWh faktisk målt · ${faktiskForbruk.antallMalere} målere satt opp i Cloud${faktiskForbruk.feilmeldinger.length ? ` · ${faktiskForbruk.feilmeldinger.length} organisasjon(er) feilet` : ""}`
                        : ""
                      )}
                    </span>
                  </div>
                  <div className="volum-chart-valg">
                    <div className="seg-toggle">
                      <button className={volumVisning === "maned" ? "active" : ""} onClick={() => setVolumVisning("maned")}>Per måned</button>
                      <button className={volumVisning === "kumulativt" ? "active" : ""} onClick={() => setVolumVisning("kumulativt")}>Kumulativt</button>
                      <button className={volumVisning === "faktisk" ? "active" : ""} onClick={() => setVolumVisning("faktisk")}>Faktisk forbruk</button>
                    </div>
                    <select value={volumChartYear} onChange={(e) => setVolumChartYear(Number(e.target.value))}>
                      {volumChart.years.map((y) => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </div>
                </div>
                <div className="volum-bars">
                  {MANEDSNAVN.map((navn, i) => {
                    const verdi =
                      volumVisning === "maned" ? volumChart.perMonth[i]
                      : volumVisning === "kumulativt" ? volumChart.kumulativt[i]
                      : faktiskForbruk?.perMonthGwh[i] ?? 0;
                    const serie =
                      volumVisning === "maned" ? volumChart.perMonth
                      : volumVisning === "kumulativt" ? volumChart.kumulativt
                      : faktiskForbruk?.perMonthGwh ?? [];
                    const maks = Math.max(...serie, 0.01);
                    return (
                      <div className="volum-bar-col" key={navn}>
                        <div className="volum-bar-track" title={`${verdi.toFixed(2)} GWh`}>
                          <div className={"volum-bar" + (i === volumChart.naavarendeManed ? " naa" : "")} style={{ height: `${(verdi / maks) * 100}%` }} />
                        </div>
                        <span className="volum-bar-val">{verdi > 0 ? verdi.toFixed(1) : ""}</span>
                        <span className="volum-bar-label">{navn}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="panel neste-handling">
              <div className="hd"><h2>Neste handling</h2><span className="sub">Prioritert etter alder og blokkering</span></div>
              <div className="neste-handling-rader">
                {prioriterteKoer.ikkeMeldtInn.total > 0 && (
                  <button className="neste-rad" onClick={() => { setTab("nye"); setNyeFane("aktiv"); }}>
                    <span className="neste-ikon" aria-hidden="true">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                    </span>
                    <span className="neste-tekst">
                      <b>{nyeAvtaler.filter((a) => a.status === "Ny" || a.status === "Under arbeid").length || prioriterteKoer.ikkeMeldtInn.total} nye avtaler</b>
                      <span>Bekreft og hent anleggsdata</span>
                    </span>
                    <span className="neste-pil">→</span>
                  </button>
                )}
                {prioriterteKoer.venterPaEntelios.total > 0 && (
                  <button className="neste-rad" onClick={() => { setTab("reg"); setWorkFilter("venter"); setFltStatus(""); }}>
                    <span className="neste-ikon" aria-hidden="true">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
                    </span>
                    <span className="neste-tekst">
                      <b>{prioriterteKoer.venterPaEntelios.total} venter på Entelios</b>
                      <span>Eldste har ventet i {prioriterteKoer.venterPaEntelios.eldsteDager} dag{prioriterteKoer.venterPaEntelios.eldsteDager === 1 ? "" : "er"}</span>
                    </span>
                    <span className="neste-pil">→</span>
                  </button>
                )}
                {prioriterteKoer.manglerCloudKobling.total > 0 && (
                  <button className="neste-rad" onClick={() => { setTab("reg"); setWorkFilter("revisjon"); setFltStatus(""); }}>
                    <span className="neste-ikon" aria-hidden="true">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10Z" /></svg>
                    </span>
                    <span className="neste-tekst">
                      <b>{prioriterteKoer.manglerCloudKobling.total} mangler Cloud-kobling</b>
                      <span>Kjør oppslag mot Adaptic Cloud</span>
                    </span>
                    <span className="neste-pil">→</span>
                  </button>
                )}
                {prioriterteKoer.ikkeMeldtInn.total === 0 && prioriterteKoer.venterPaEntelios.total === 0 && prioriterteKoer.manglerCloudKobling.total === 0 && (
                  <p className="muted" style={{ padding: "12px 4px" }}>Ingenting trenger oppmerksomhet akkurat nå.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {tab === "reg" && (
          <section>
            {workFilter === "kladd" ? (
              <>
                <div className="worklist-heading">
                  <div><h1>Kladd</h1><span>{filtered.length} målepunkt under utarbeidelse - last opp en strømfaktura under for å hente ut flere. Velg rader og last ned en Adaptic-liste når alt er klart.</span></div>
                </div>
                <div className="import-page kladd-opplasting">{renderFakturaOpplasting()}</div>
              </>
            ) : (
              <div className="worklist-heading">
                <div><h1>Arbeidsliste</h1><span>{filtered.length} målepunkt i valgt kø</span></div>
                <button className="btn primary" onClick={() => setBatchOpen(true)}>Merk som sendt til Entelios</button>
              </div>
            )}

            <div className="toolbar work-toolbar">
              <input className="work-search" type="search" placeholder="Søk kunde, bygg, adresse, MålepunktID …" value={search} onChange={(e) => setSearch(e.target.value)} />
              <label className="flt">Status
                <select value={fltStatus} onChange={(e) => { setFltStatus(e.target.value); setWorkFilter(""); }}>
                  <option value="">alle</option>
                  {STAGES.map((s) => <option key={s} value={s}>{displayStatus(s)}</option>)}
                </select>
              </label>
              <label className="flt">Sorter
                <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                  <option value="arbeidsrekkefolge">arbeidsrekkefølge</option>
                  <option value="oppstart">oppstartsdato (nyeste først)</option>
                  <option value="kunde">kunde A–Å</option>
                  <option value="status">status</option>
                  <option value="nyeste">nyeste først</option>
                </select>
              </label>
              <div className="ny-meny">
                <button className="btn" aria-haspopup="menu" aria-expanded={colsMenuOpen} onClick={() => setColsMenuOpen((v) => !v)}>Kolonner</button>
                {colsMenuOpen && (
                  <>
                    <div className="dropdown-backdrop" onClick={() => setColsMenuOpen(false)} />
                    <div className="ny-panel" role="menu" style={{ width: 220 }}>
                      {REG_COLUMNS.map((c) => (
                        <label key={c.key} className="checkline" style={{ padding: "6px 10px" }}>
                          <input
                            type="checkbox"
                            checked={visibleCols[c.key] ?? true}
                            onChange={(e) => setVisibleCols((v) => ({ ...v, [c.key]: e.target.checked }))}
                          />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {workFilter === "kladd" ? (
                <button className="btn primary" disabled={!filtered.length} onClick={() => void eksporterKladd()}>Last ned Adaptic-liste (Excel)</button>
              ) : (
                <button className="btn" disabled={!filtered.length} onClick={downloadWorklist}>Last ned arbeidsliste (Excel)</button>
              )}
            </div>

            {selectedRowsForBulk.length > 0 && <div className="bulk-bar">
              <b>{selectedRowsForBulk.length} valgt</b>
              <span>{selectedRegisteredIds.length} kan settes som klare til Entelios · {selectedDeletableIds.length} kan slettes</span>
              <span className="grow" />
              <button className="btn sm" onClick={() => setSelectedAvtaletype("Eierskifte")}>Sett {selectedRowsForBulk.length} som Eierskifte</button>
              <button className="btn sm" onClick={() => setSelectedAvtaletype("Spotavtale")}>Sett {selectedRowsForBulk.length} som Spotavtale</button>
              <input
                list="cloud-org-list-bulk"
                className="compact-input"
                style={{ width: 140 }}
                placeholder="strøm-org"
                value={bulkCloudOrg}
                onChange={(e) => setBulkCloudOrg(e.target.value)}
                title="Nødvendig for at «Sjekk i Cloud» skal vite hvilken organisasjon den skal lete i"
              />
              <datalist id="cloud-org-list-bulk">{CLOUD_ORGS.map((o) => <option key={o} value={o} />)}</datalist>
              <button className="btn sm" disabled={!bulkCloudOrg.trim()} onClick={() => setSelectedCloudOrg(bulkCloudOrg)}>Sett {selectedRowsForBulk.length} sin strøm-org</button>
              <button className="btn sm" onClick={sjekkFlereICloud}>Sjekk {selectedRowsForBulk.length} i Cloud</button>
              <button className="btn sm" onClick={() => setSelectedIds([])}>Fjern valg</button>
              <button className="btn sm danger" disabled={!selectedDeletableIds.length} onClick={removeSelected}>
                Slett {selectedDeletableIds.length || "valgte"}
              </button>
              <button className="btn sm primary" disabled={!selectedRegisteredIds.length} onClick={markSelectedReady}>
                Sett {selectedRegisteredIds.length || "valgte"} som klar til Entelios
              </button>
            </div>}

            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th className="select-cell"><input type="checkbox" aria-label="Velg alle synlige" checked={allVisibleSelected} onChange={(e) => toggleAllVisible(e.target.checked)} /></th>
                  <th>Kunde</th>
                  <th>Avtaletype</th>
                  {visibleCols.selger && <th>Selger</th>}
                  {visibleCols.bygg && <th>Bygg</th>}
                  {visibleCols.maalepunkt_id && <th>MålepunktID</th>}
                  {visibleCols.netteier && <th>Netteier</th>}
                  {visibleCols.prisomrade && <th>Prisomr.</th>}
                  {visibleCols.aarsforbruk_kwh && <th className="num">Årsforbruk</th>}
                  {visibleCols.avtalt_oppstart && <th>Oppstartsdato</th>}
                  {visibleCols.tsdb_id && <th>tsdb_id</th>}
                  {visibleCols.status && <th>Status</th>}
                  <th>Handling</th>
                </tr></thead>
                <tbody>
                  {loading && <tr><td colSpan={regColSpan}><div className="empty">Laster …</div></td></tr>}
                  {!loading && filtered.length === 0 && <tr><td colSpan={regColSpan}><div className="empty"><b>Ingen målepunkt her</b><span>Juster søk eller filter, eller registrer et nytt målepunkt eller last opp en avtale.</span></div></td></tr>}
                  {!loading && filtered.map((r) => {
                    const next = nextStatus(r.status);
                    const previous = previousStatus(r.status);
                    return (
                      <tr key={r.id}>
                        <td className="select-cell"><input type="checkbox" aria-label={`Velg ${r.bygg}`} checked={selectedIds.includes(r.id)} onChange={(e) => toggleSelected(r.id, e.target.checked)} /></td>
                        <td>{r.kunde}</td>
                        <td>{r.avtaletype || <span className="muted">Ikke satt</span>}</td>
                        {visibleCols.selger && <td>{r.selger || <span className="muted">Ikke satt</span>}</td>}
                        {visibleCols.bygg && <td>{r.bygg}{r.adresse && r.adresse.split(",")[0].trim() !== (r.bygg || "").trim() && <div className="muted">{r.adresse}</div>}</td>}
                        {visibleCols.maalepunkt_id && <td className="num">{r.maalepunkt_id}</td>}
                        {visibleCols.netteier && <td>{r.netteier}</td>}
                        {visibleCols.prisomrade && <td>{r.prisomrade}</td>}
                        {visibleCols.aarsforbruk_kwh && <td className="num">{fmt(r.aarsforbruk_kwh)}</td>}
                        {visibleCols.avtalt_oppstart && <td>{r.avtalt_oppstart || <span className="muted">Ikke satt</span>}</td>}
                        {visibleCols.tsdb_id && <td className="num">{r.tsdb_id || <span className="muted">Ikke satt</span>}</td>}
                        {visibleCols.status && <td><span className={"pill " + STATUS_CLASS[r.status]}>{displayStatus(r.status)}</span></td>}
                        <td>
                          <select
                            className="action-select"
                            aria-label={`Handlinger for ${r.bygg}`}
                            value=""
                            onChange={(e) => handleRowAction(r, e.target.value)}
                          >
                            <option value="" disabled>Handlinger</option>
                            {next && <option value="advance">→ Sett som {shortStage(next)}</option>}
                            {previous && <option value="back">← Flytt tilbake til {shortStage(previous)}</option>}
                            <option value="edit">Rediger</option>
                            <option value="sjekk-cloud">Sjekk i Cloud</option>
                            <option value="history">Vis historikk</option>
                            {(r.status === "Kladd" || r.status === "Innmeldt" || r.status === "Klar for bestilling") && <option value="delete">Slett</option>}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "import" && (
          <section className="import-page">
            <div
              className={"upload-card drop-zone" + (dragTarget === "pdf" ? " dragging" : "")}
              onDragOver={(e) => { e.preventDefault(); setDragTarget("pdf"); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragTarget(null); }}
              onDrop={(e) => dropFile(e, "pdf")}
            >
              <span className="drop-zone-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V4M12 4 7 9M12 4l5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
              </span>
              <h2>Last opp signert PDF-avtale</h2>
              <p>Dra PDF-avtalen hit. Systemet leser kunde, org.nr, vilkår, oppstart og målepunkter. Du kontrollerer forslagene før de lagres i registeret.</p>
              <span className="drop-zone-or">eller</span>
              <label className="upload-btn">
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  disabled={parsing || importing}
                  onChange={(e) => parsePdf(e.target.files?.[0])}
                />
                {parsing ? "Leser avtalen …" : "Velg PDF-avtale"}
              </label>
            </div>

            {parsed && (
              <div className="import-review">
                <div className="panel import-summary">
                  <div className="hd"><h2>Kontroller avtalen</h2><span className="sub">{importName}</span></div>
                  <div className="summary-grid">
                    <Summary k="Kunde" v={parsed.kunde || "Ikke funnet"} />
                    <Summary k="Org.nr" v={parsed.org_nr || "Ikke funnet"} mono />
                    <Summary k="Oppstart" v={parsed.avtalt_oppstart || "Ikke funnet"} mono />
                    <Summary k="Signatur" v={parsed.avtale_signert ? "Fullført i PandaDoc" : "Ikke bekreftet"} good={parsed.avtale_signert} bad={!parsed.avtale_signert} />
                  </div>
                  <div className="import-org">
                    <label>Kunde/organisasjon for strømregistreringen</label>
                    <input list="cloud-org-list" value={importCloudOrg} onChange={(e) => setImportCloudOrg(e.target.value)} />
                    <datalist id="cloud-org-list">{CLOUD_ORGS.map((o) => <option key={o} value={o} />)}</datalist>
                    <span>Kontroller hvilken kundeorganisasjon bygget tilhører.</span>
                  </div>
                  <div className="import-org">
                    <label>Selger for kunden</label>
                    <input value={importSeller} onChange={(e) => setImportSeller(e.target.value)} placeholder="Navn på ansvarlig selger" />
                    <span>Lagres på kunden og brukes på alle målepunktene i denne avtalen.</span>
                  </div>
                  {parsed.note && <div className="banner" style={{ margin: "0 18px 18px" }}>{parsed.note}</div>}
                  {parsed.kommentar_forslag && (
                    <div className="banner" style={{ margin: "0 18px 18px", color: "var(--sf-accent)", background: "var(--sf-accent-soft)" }}>
                      <b>Verdt å vite:</b> {parsed.kommentar_forslag}
                    </div>
                  )}
                  {!parsed.avtale_signert && <div className="banner" style={{ margin: "0 18px 18px" }}>Avtalen ser ikke ferdig signert ut. Du kan kontrollere funnene, men ikke lagre dem ennå.</div>}
                </div>

                <div className="toolbar">
                  <strong>{parsed.rows.length} målepunkt funnet</strong>
                  <span className="muted">Gyldige, nye rader er valgt automatisk. Dubletter med et Kladd-utkast fra før kan flyttes til Klar til innmelding i stedet.</span>
                  <span className="grow" />
                  <button className="btn" disabled={updatingExisting || !parsed.avtale_signert || !Object.values(updateRows).some(Boolean)} onClick={updateExistingFromAvtale}>
                    {updatingExisting ? "Flytter …" : `Flytt ${Object.values(updateRows).filter(Boolean).length} til Klar til innmelding`}
                  </button>
                  <button className="btn primary" disabled={importing || !parsed.avtale_signert || !Object.values(selectedRows).some(Boolean)} onClick={importParsedRows}>
                    {importing ? "Legger inn …" : `Legg ${Object.values(selectedRows).filter(Boolean).length} i registeret`}
                  </button>
                </div>

                <div className="tablewrap">
                  <table>
                    <thead><tr><th /><th>Adresse / bygg</th><th>Målenummer</th><th>MålepunktID</th><th>Netteier</th><th>Prisomr.</th><th className="num">Årsforbruk</th><th>AT-kode</th><th>Kontroll</th></tr></thead>
                    <tbody>{parsed.rows.map((r, i) => {
                      const existing = rows.find((row) => row.maalepunkt_id === r.maalepunkt_id);
                      const duplicate = !!existing;
                      const updatable = !!existing && existing.status === "Kladd";
                      const blocked = !r.gyldig || (duplicate && !updatable);
                      return <tr key={`${r.maalepunkt_id}-${i}`}>
                        <td>
                          {updatable
                            ? <input type="checkbox" checked={!!updateRows[i]} onChange={(e) => setUpdateRows((s) => ({ ...s, [i]: e.target.checked }))} title="Fyll inn oppstart fra avtalen og flytt raden fra Kladd til Innmeldt - tilbudet er akseptert" />
                            : <input type="checkbox" checked={!!selectedRows[i]} disabled={blocked} onChange={(e) => setSelectedRows((s) => ({ ...s, [i]: e.target.checked }))} />}
                        </td>
                        <td>{r.adresse}</td><td className="num">{r.maalenummer}</td><td className="num">{r.maalepunkt_id}</td><td>{r.netteier}</td><td>{r.prisomrade}</td><td className="num">{fmt(r.aarsforbruk_kwh)}</td>
                        <td><input className="num compact-input" placeholder="kan fylles senere" value={rowAtCodes[i] || ""} disabled={blocked} onChange={(e) => setRowAtCodes((s) => ({ ...s, [i]: e.target.value }))} /></td>
                        <td>{updatable ? <span className="pill s-klar">Kladd - flyttes til Innmeldt</span> : duplicate ? <span className="pill s-kladd">Finnes allerede</span> : r.gyldig ? <span className="pill s-aktiv">Klar</span> : <span className="pill" style={{ color: "var(--sf-crit)", background: "var(--sf-crit-soft)" }}>{r.problem || "Mangler data"}</span>}</td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "excel" && (
          <section className="import-page">
            <div
              className={"upload-card drop-zone" + (dragTarget === "excel" ? " dragging" : "")}
              onDragOver={(e) => { e.preventDefault(); setDragTarget("excel"); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragTarget(null); }}
              onDrop={(e) => dropFile(e, "excel")}
            >
              <span className="drop-zone-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V4M12 4 7 9M12 4l5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
              </span>
              <h2>Importer målepunktliste fra Excel</h2>
              <p>Dra Excel-filen hit. Systemet finner faner og kolonner automatisk, kontrollerer radene og foreslår hva som kan legges i registeret.</p>
              <span className="drop-zone-or">eller</span>
              <label className="upload-btn">
                <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={excelParsing || excelImporting} onChange={(e) => parseExcel(e.target.files?.[0])} />
                {excelParsing ? "Leser arbeidsboken …" : "Velg Excel-fil"}
              </label>
            </div>

            {excelData && excelSheet && (
              <div className="import-review">
                <div className="panel import-summary">
                  <div className="hd"><h2>Kontroller Excel-importen</h2><span className="sub">{excelName}</span></div>
                  <div className="excel-sheet-picker">
                    <label>Fane</label>
                    <select value={excelSheetName} onChange={(e) => {
                      const next = excelData.sheets.find((s) => s.name === e.target.value);
                      if (next) setupExcelSheet(next);
                    }}>
                      {excelData.sheets.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.rows.length} rader</option>)}
                    </select>
                    <span>Overskrifter funnet i rad {excelSheet.header_row}. «Bestilt»-faner foreslås som sendt til Entelios.</span>
                  </div>
                </div>

                <div className="panel">
                  <div className="hd"><h2>Avtaleinformasjon per referanse</h2><span className="sub">Fyll bare det Excel-filen ikke inneholder</span></div>
                  <div className="tablewrap mapping-table">
                    <table>
                      <thead><tr><th>Referanse / kunde</th><th>Org.nr</th><th>Selger</th><th>Strøm-org</th><th>Avtaletype</th><th>Signert</th><th>Kontroll</th></tr></thead>
                      <tbody>{excelGroupKeys.map((key) => {
                        const m = excelMappings[key];
                        if (!m) return null;
                        return <tr key={key}>
                          <td><div className="muted num">{key}</div><input value={m.kunde} onChange={(e) => setExcelMapping(key, { kunde: e.target.value })} /></td>
                          <td>
                            <input className="num compact-input" maxLength={9} placeholder="9 siffer" value={m.org_nr} onChange={(e) => setExcelMapping(key, { org_nr: e.target.value.replace(/\D/g, "") })} />
                            {!/^\d{9}$/.test(m.org_nr) && excelOrgSokMsg[key] && <div className="muted" style={{ fontSize: 11 }}>{excelOrgSokMsg[key]}</div>}
                            {!/^\d{9}$/.test(m.org_nr) && excelOrgSokTreff[key]?.map((tr) => (
                              <button key={tr.organisasjonsnummer} type="button" className="btn sm" style={{ display: "block", marginTop: 4 }} onClick={() => { setExcelMapping(key, { org_nr: tr.organisasjonsnummer }); setExcelOrgSokMsg((m2) => ({ ...m2, [key]: "" })); }}>
                                {tr.navn} · {tr.organisasjonsnummer}
                              </button>
                            ))}
                          </td>
                          <td><input className="compact-input" placeholder="ansvarlig selger" value={m.selger} onChange={(e) => setExcelMapping(key, { selger: e.target.value })} /></td>
                          <td><input list="excel-cloud-orgs" value={m.cloud_org} onChange={(e) => setExcelMapping(key, { cloud_org: e.target.value })} /><datalist id="excel-cloud-orgs">{CLOUD_ORGS.map((o) => <option key={o} value={o} />)}</datalist></td>
                          <td><select value={m.avtaletype} onChange={(e) => setExcelMapping(key, { avtaletype: e.target.value as ExcelGroupConfig["avtaletype"] })}><option value="">velg</option><option value="Spotavtale">Spotavtale</option><option value="Eierskifte">Eierskifte</option></select></td>
                          <td><label className="checkline"><input type="checkbox" checked={m.signert} onChange={(e) => setExcelMapping(key, { signert: e.target.checked })} /> Ja</label></td>
                          <td>
                            {excelMappingValid(m) ? <span className="pill s-aktiv">Klar</span> : <span className="pill s-klar">Mangler felt</span>}
                            {excelMappingValid(m) && (
                              <button type="button" className="btn sm" style={{ marginLeft: 8 }} onClick={() => kopierMappingTilSammeKunde(key)} title={`Kopier org.nr/selger/strøm-org/avtaletype/signert til alle andre referanser med kundenavn «${m.kunde}»`}>
                                Bruk på alle «{m.kunde}»
                              </button>
                            )}
                          </td>
                        </tr>;
                      })}</tbody>
                    </table>
                  </div>
                </div>

                <div className="toolbar">
                  <strong>{excelSheet.rows.length} rader funnet</strong>
                  <span className="muted">Bare gyldige, nye rader med komplett avtaleinformasjon importeres.</span>
                  <span className="grow" />
                  <button className="btn primary" disabled={excelImporting || excelReadyCount === 0} onClick={importExcelRows}>{excelImporting ? "Importerer …" : `Importer ${excelReadyCount} rader`}</button>
                </div>

                <div className="tablewrap">
                  <table>
                    <thead><tr><th /><th>Rad</th><th>Referanse</th><th>Bygg/kunde</th><th>Adresse</th><th>Målenummer</th><th>MålepunktID</th><th>Prisomr.</th><th>Netteier</th><th className="num">Årsforbruk</th><th>Oppstart</th><th>Status</th><th>Kontroll</th></tr></thead>
                    <tbody>{excelSheet.rows.map((r) => {
                      const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
                      const mappingOk = excelMappingValid(excelMappings[excelGroupKey(r)]);
                      const problemer = excelRowProblemer(r);
                      const gyldig = problemer.length === 0;
                      const blocked = !gyldig || duplicate;
                      return <tr key={r.source_row}>
                        <td><input type="checkbox" checked={!!excelSelected[r.source_row]} disabled={blocked} onChange={(e) => setExcelSelected((s) => ({ ...s, [r.source_row]: e.target.checked }))} /></td>
                        <td className="num">{r.source_row}</td><td className="num">{r.referansekode || "-"}</td><td>{r.selskapsnavn || r.kunde_hint || r.bygg || "-"}</td><td>{r.adresse}</td><td className="num">{r.maalenummer || "-"}</td><td className="num">{r.maalepunkt_id || "-"}</td>
                        <td>
                          <input className="compact-input" style={{ width: 60 }} placeholder="NO1-NO5" value={excelRowPrisomrade[r.source_row] ?? r.prisomrade} onChange={(e) => setExcelRowPrisomrade((p) => ({ ...p, [r.source_row]: e.target.value }))} />
                        </td>
                        <td>
                          <input className="compact-input" value={excelRowNetteier[r.source_row] ?? r.netteier} onChange={(e) => setExcelRowNetteier((n) => ({ ...n, [r.source_row]: e.target.value }))} />
                          {excelRowLookupMsg[r.source_row] && <div className="muted" style={{ fontSize: 11 }}>{excelRowLookupMsg[r.source_row]}</div>}
                        </td>
                        <td className="num">{r.aarsforbruk_kwh != null ? fmt(r.aarsforbruk_kwh) : <input className="num compact-input" style={{ width: 80 }} placeholder="kWh" value={excelRowAarsforbruk[r.source_row] ?? ""} onChange={(e) => setExcelRowAarsforbruk((a) => ({ ...a, [r.source_row]: e.target.value }))} />}</td><td className="num">{r.oppstartdato || "-"}</td><td><span className={"pill " + (r.status_suggestion === "Sendt Entelios" ? "s-sendt" : "s-innmeldt")}>{displayStatus(r.status_suggestion)}</span></td>
                        <td>{duplicate ? <span className="pill s-kladd">Finnes allerede</span> : !gyldig ? <span className="pill" title={problemer.join(", ")} style={{ color: "var(--sf-crit)", background: "var(--sf-crit-soft)" }}>{problemer[0]}</span> : mappingOk ? <span className="pill s-aktiv">Klar</span> : <span className="pill s-klar">Avtaleinfo mangler</span>}</td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "faktura" && (
          <section className="import-page">
            {renderFakturaOpplasting()}
          </section>
        )}

        {tab === "form" && (
          <form className="intake" onSubmit={submit} noValidate>
            {editingId && <div className="edit-banner"><b>Redigerer eksisterende målepunkt</b><span>Endringene blir lagret i historikken.</span></div>}
            <fieldset>
              <legend>Kunde</legend>
              <Field label="Selskapsnavn" req err={errFor("kunde")}>
                <input value={form.kunde ?? ""} onChange={(e) => set("kunde", e.target.value)} />
              </Field>
              <Field label="Org.nr" req err={errFor("org_nr")}>
                <input className="num" inputMode="numeric" maxLength={9} placeholder="9 siffer" value={form.org_nr ?? ""} onChange={(e) => setCustomerOrgNr(e.target.value)} />
              </Field>
              <Field label="Selger" hint="Gjelder hele kunden. Endring oppdaterer alle kundens målepunkter.">
                <input value={form.selger ?? ""} onChange={(e) => set("selger", e.target.value)} placeholder="Navn på ansvarlig selger" />
              </Field>
              <Field label="Kontaktperson hos kunde (valgfritt)" hint="Sendes med i innmeldingen til Entelios, slik at driftsmeldinger (elkontroll o.l.) går direkte dit i stedet for kun til Adaptic sentralt. Gjelder hele kunden.">
                <input value={form.kontaktperson_navn ?? ""} onChange={(e) => set("kontaktperson_navn", e.target.value)} placeholder="Navn" />
              </Field>
              <Field label="Kontaktperson e-post (valgfritt)">
                <input type="email" value={form.kontaktperson_epost ?? ""} onChange={(e) => set("kontaktperson_epost", e.target.value)} placeholder="navn@kunde.no" />
              </Field>
              <Field label="Kunde/organisasjon for strømregistreringen" req err={errFor("cloud_org")} hint={'Er kunden satt opp som egen strømkunde i Cloud ("i drift"): bruk "SK <kundenavn>". Er den ikke det ennå: bruk kundens vanlige orgnavn (f.eks. "Bergensgruppen AS").'}>
                <input list="cloud-org-list-form" value={form.cloud_org ?? ""} onChange={(e) => set("cloud_org", e.target.value)} placeholder="SK <kundenavn> eller kundens orgnavn" />
                <datalist id="cloud-org-list-form">{CLOUD_ORGS.map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
            </fieldset>

            <fieldset>
              <legend>Anlegg</legend>
              <Field label="Bygg" req err={errFor("bygg")}><input value={form.bygg ?? ""} onChange={(e) => set("bygg", e.target.value)} /></Field>
              <div className="field">
                <label>Adresse <span className="req">*</span></label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={{ flex: 1 }}
                    value={form.adresse ?? ""}
                    onChange={(e) => set("adresse", e.target.value)}
                    onBlur={(e) => lookupAddress(e.target.value)}
                    placeholder="Gate, postnr sted"
                  />
                  <button type="button" className="btn sm" disabled={lookup.loading} onClick={() => lookupAddress(form.adresse || "")}>
                    {lookup.loading ? "Henter…" : "Hent"}
                  </button>
                </div>
                <div className="hint">Fyller netteier og prisområde automatisk fra adressen.</div>
                {lookup.msg && <div className="hint" style={{ color: "var(--sf-accent)" }}>{lookup.msg}</div>}
                {errFor("adresse") && <div className="err">{errFor("adresse")}</div>}
              </div>
              <div className="grid2">
                <Field label="Målenummer" req err={errFor("maalenummer")}><input className="num" value={form.maalenummer ?? ""} onChange={(e) => set("maalenummer", e.target.value)} /></Field>
                <Field label="Årsforbruk (kWh)" req err={errFor("aarsforbruk_kwh")}>
                  <input className="num" inputMode="numeric" value={form.aarsforbruk_kwh ?? ""} onChange={(e) => set("aarsforbruk_kwh", (e.target.value === "" ? null : Number(e.target.value)) as any)} />
                </Field>
              </div>
              <Field label="MålepunktID (ELhub)" req err={errFor("maalepunkt_id")}>
                <input className="num" inputMode="numeric" maxLength={18} placeholder="18 siffer" value={form.maalepunkt_id ?? ""} onChange={(e) => set("maalepunkt_id", e.target.value)} />
              </Field>
              <div className="grid2">
                <Field label="Netteier" req err={errFor("netteier")} hint="Fylles fra adressen (NVE).">
                  <input list="netteier-list" value={form.netteier ?? ""} onChange={(e) => set("netteier", e.target.value)} placeholder="fylles fra adresse" />
                  <datalist id="netteier-list">{NETTEIERE.map((n) => <option key={n} value={n} />)}</datalist>
                </Field>
                <Field label="Prisområde" req err={errFor("prisomrade")}>
                  <select value={form.prisomrade ?? ""} onChange={(e) => set("prisomrade", e.target.value)}>
                    <option value="">velg</option>
                    {PRISOMRADER.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
              </div>
            </fieldset>

            <fieldset className="wide">
              <legend>Overtakelse (valgfritt)</legend>
              <div className="radio-row">
                {(["Eierskifte", "Spotavtale"] as const).map((at) => (
                  <label key={at} className="radio-card" data-on={form.avtaletype === at} onClick={() => set("avtaletype", form.avtaletype === at ? "" : at)}>
                    <input type="radio" name="avtaletype" checked={form.avtaletype === at} readOnly />
                    <b>{at === "Eierskifte" ? "Eierskifte · eiers vilkår" : "Over på vår spotavtale"}</b>
                    <span>{at === "Eierskifte" ? "Overtar eksisterende leverandøravtale på samme vilkår som i dag." : "Kunden flyttes over på Adaptics egen spotavtale."}</span>
                  </label>
                ))}
              </div>
              {form.avtaletype === "Eierskifte" && (
                <div className="field" style={{ marginTop: 14 }}>
                  <label>Leverandøravtale (PDF, valgfritt)</label>
                  <input
                    type="file"
                    accept="application/pdf"
                    disabled={leverandoravtaleUploading}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLeverandoravtale(f); }}
                  />
                  {leverandoravtaleUploading && <span className="muted">Laster opp …</span>}
                  {!leverandoravtaleUploading && form.leverandoravtale_fil_sti && (
                    <span className="muted">
                      Lastet opp.{" "}
                      {leverandoravtaleUrl
                        ? <a href={leverandoravtaleUrl} target="_blank" rel="noreferrer">Åpne leverandøravtale</a>
                        : "Henter lenke …"}
                    </span>
                  )}
                </div>
              )}
            </fieldset>

            <fieldset className="wide">
              <legend>Avtale</legend>
              <div className="grid2">
                <Field label="AT-kode (valgfritt - fylles inn når den er klar)" err={errFor("at_kode")}><input className="num" placeholder="f.eks. AT40001.001" value={form.at_kode ?? ""} onChange={(e) => set("at_kode", e.target.value)} /></Field>
                <Field label="Avtalt oppstart" req err={errFor("avtalt_oppstart")}><input type="date" className="num" value={form.avtalt_oppstart ?? ""} onChange={(e) => set("avtalt_oppstart", e.target.value)} /></Field>
              </div>
              <Field label="Kommentar"><textarea rows={2} value={form.kommentar ?? ""} onChange={(e) => set("kommentar", e.target.value)} /></Field>
              <div className="field">
                <label className="checkline"><input type="checkbox" checked={!!form.signert} onChange={(e) => set("signert", e.target.checked)} /> Avtalen er signert i PandaDoc</label>
                {errFor("signert") && <div className="err">{errFor("signert")}</div>}
              </div>
            </fieldset>

            <div className="formfoot">
              <button className="btn primary" type="submit" disabled={showAll && !isValid}>{editingId ? "Lagre endringer" : "Registrer målepunkt"}</button>
              {editingId && <button className="btn" type="button" onClick={() => { setEditingId(null); setForm({ ...emptyForm }); setTab("reg"); }}>Avbryt</button>}
              <span className="note">{showAll && !isValid ? "Noen felt mangler eller er ugyldige. Se rødt merkede felt." : "Alle påkrevde felt må fylles før innmelding."}</span>
            </div>
          </form>
        )}
      </main>
          </div>
        </div>
      </div>

      {batchOpen && (
        <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) setBatchOpen(false); }}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="hd">
              <h2>Merk som sendt til Entelios</h2>
              <span className="sub" style={{ color: "var(--sf-ink-3)", fontSize: 13 }}>{batchRows.length} målepunkt klare</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" disabled={!batchRows.length} onClick={copyBatch}>Kopier</button>
              <button className="btn sm" disabled={!batchRows.length} onClick={downloadEntelioBatchXlsx}>Last ned Excel</button>
              <button className="btn sm" disabled={!batchRows.length} onClick={openEntelioEmailDraft}>Åpne mailutkast</button>
              <button className="btn sm primary" disabled={!batchRows.length} onClick={sendBatch}>Marker som sendt</button>
              <button className="icon-btn" aria-label="Lukk" onClick={() => setBatchOpen(false)}>✕</button>
            </div>
            <div className="bd">
              {batchRows.length > 0 && (
                <div className="hint" style={{ marginBottom: 12, fontSize: 13, color: "var(--sf-ink-2)" }}>
                  E-postutkastet kan ikke få vedlegget automatisk lagt ved (teknisk begrensning i mailto-lenker) - gjør derfor i denne rekkefølgen:
                  {" "}<b>1)</b> «Last ned Excel», <b>2)</b> «Åpne mailutkast», <b>3)</b> dra den nedlastede filen inn i utkastet som vedlegg.
                </div>
              )}
              {batchRows.length === 0 ? (
                <div className="empty">Ingen målepunkt har status «Klar til Entelios». Sett en internt registrert post videre først.</div>
              ) : (
                <div className="tablewrap" style={{ boxShadow: "none" }}>
                  <table>
                    <thead><tr>{ENTELIOS_COLUMNS.map((c) => <th key={c.key as string}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {batchRows.map((r) => (
                        <tr key={r.id}>{ENTELIOS_COLUMNS.map((c) => <td key={c.key as string} className={typeof (r as any)[c.key] === "number" ? "num" : ""}>{String((r as any)[c.key] ?? "")}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {historyFor && (
        <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) setHistoryFor(null); }}>
          <div className="modal history-modal" role="dialog" aria-modal="true">
            <div className="hd">
              <div><h2>Historikk · {historyFor.bygg}</h2><span className="sub num">{historyFor.maalepunkt_id}</span></div>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" aria-label="Lukk" onClick={() => setHistoryFor(null)}>✕</button>
            </div>
            <div className="bd">
              {historyLoading && <div className="empty">Laster historikk …</div>}
              {!historyLoading && historyRows.length === 0 && <div className="empty">Ingen historikk funnet. Kjør sikkerhetsmigreringen for å aktivere logging.</div>}
              {!historyLoading && historyRows.map((h) => <div className="history-event" key={h.id}>
                <div className="history-dot" />
                <div><b>{h.action === "opprettet" ? "Opprettet" : h.action === "slettet" ? "Slettet" : h.from_status !== h.to_status ? `${displayStatus(h.from_status || "-")} → ${displayStatus(h.to_status || "-")}` : "Opplysninger endret"}</b>
                  <div className="muted">{h.changed_fields.filter((f) => !["opprettet", "slettet"].includes(f)).join(", ") || "Status registrert"}</div>
                  <small>{new Date(h.created_at).toLocaleString("nb-NO")} · {h.actor_email || "ukjent bruker"}</small>
                </div>
              </div>)}
            </div>
          </div>
        </div>
      )}

      <div className={"toast" + (toast ? " show" : "")}>
        {toast?.detalj ? (
          <>
            <span className="toast-dot" aria-hidden="true" />
            <span className="toast-tekst">
              <b>{toast.tittel}</b>
              <span>{toast.detalj}</span>
            </span>
          </>
        ) : (toast?.tittel ?? "")}
      </div>
    </div>
  );
}

function Tile({ k, v, sub, alert, bar }: { k: string; v: ReactNode; sub?: string; alert?: boolean; bar?: ReactNode }) {
  return (
    <div className={"tile" + (alert ? " alert" : "")}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub ? <small className="tile-sub">{sub}</small> : null}
      {bar}
    </div>
  );
}

function Field({ label, req, err, hint, children }: { label: string; req?: boolean; err?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label} {req && <span className="req">*</span>}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function Summary({ k, v, mono, good, bad }: { k: string; v: string; mono?: boolean; good?: boolean; bad?: boolean }) {
  return <div className="summary-item"><span>{k}</span><b className={mono ? "num" : ""} style={{ color: good ? "var(--sf-good)" : bad ? "var(--sf-crit)" : undefined }}>{v}</b></div>;
}

const CSS = `
.sf-root{--sf-navy:#10202e;--sf-ground:#f5f7f9;--sf-surface:#fff;--sf-surface-2:#eef3f4;--sf-border:#e5ebec;--sf-border-strong:#ccd6d8;--sf-ink:#14202b;--sf-ink-2:#566571;--sf-ink-3:#8896a0;--sf-accent:#009c91;--sf-accent-strong:#007e75;--sf-accent-ink:#fff;--sf-accent-soft:#e3f4f1;--sf-good:#009c91;--sf-good-soft:#e3f4f1;--sf-warn:#ef7f4d;--sf-warn-soft:#fff0e8;--sf-crit:#d14a42;--sf-crit-soft:#fbe8e6;--sf-shadow:0 1px 2px rgba(16,32,45,.05),0 3px 10px rgba(16,32,45,.05);--sf-shadow-md:0 2px 4px rgba(16,32,45,.05),0 12px 30px rgba(16,32,45,.09);--sf-mono:var(--font-geist-mono),ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sf-sans:var(--font-geist-sans),ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:var(--sf-ground);color:var(--sf-ink);font-family:var(--sf-sans);width:100%;max-width:100vw;min-height:100vh;overflow-x:hidden;font-size:15px;line-height:1.5}
@media (prefers-color-scheme:dark){.sf-root{--sf-navy:#0b1520;--sf-ground:#0e151d;--sf-surface:#17212d;--sf-surface-2:#202c38;--sf-border:#2b3946;--sf-border-strong:#3a4b58;--sf-ink:#edf2f2;--sf-ink-2:#aab8bd;--sf-ink-3:#788a91;--sf-accent:#42c2b7;--sf-accent-strong:#2ba69b;--sf-accent-ink:#0c201f;--sf-accent-soft:#173936;--sf-good:#42c2b7;--sf-good-soft:#173936;--sf-warn:#f39a70;--sf-warn-soft:#3a2922;--sf-crit:#ef746d;--sf-crit-soft:#392422;--sf-shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.35);--sf-shadow-md:0 2px 6px rgba(0,0,0,.35),0 16px 38px rgba(0,0,0,.5)}}
.sf-root *{box-sizing:border-box}
.sf-root .num{font-variant-numeric:tabular-nums;font-family:var(--sf-mono)}
.sf-root h1,.sf-root h2{margin:0;text-wrap:balance}
/* ---- Skall: mørk topplinje i full bredde + sidemeny ----
   Fanene lå vannrett i toppen og gikk tom for bredde. Sidemenyen har rom for
   antall pr. visning og frigjør toppen til det som gjelder hele appen: søk,
   "+ Ny" og profil — samme kromspråk som fakturakontroll-plattformen. */
.app-shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr}
.topbar{position:sticky;top:0;z-index:20;min-height:64px;background:var(--sf-navy);display:grid;grid-template-columns:260px minmax(0,1fr) auto;align-items:center;gap:16px;padding-right:16px;box-shadow:0 1px 0 rgba(0,0,0,.15),0 2px 14px rgba(16,32,45,.18)}
.brand-panel{color:#fff;display:flex;align-items:center;gap:10px;padding:0 22px;min-width:0}
.brand-panel h1{margin:0;font-size:16px;line-height:1.15;white-space:nowrap;font-weight:640}
.brand-panel p{margin:2px 0 0;color:#93a5ba;font-size:11px;letter-spacing:.06em;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spark{width:26px;height:26px;border-radius:7px;background:var(--sf-accent);display:grid;place-items:center;color:var(--sf-accent-ink);flex:none}
.globalsok{position:relative;justify-self:center;width:min(480px,100%)}
.globalsok-felt{display:flex;align-items:center;gap:9px;background:rgba(255,255,255,.09);border:1px solid transparent;border-radius:9px;padding:0 12px;height:38px}
.globalsok-felt:focus-within{border-color:var(--sf-accent)}
.globalsok-felt svg{flex:none;color:#93a5ba}
.globalsok-felt input{flex:1;min-width:0;height:36px;border:none;background:transparent;color:#fff;font-size:13.5px;padding:0}
.globalsok-felt input::placeholder{color:#7d8fa5}
.globalsok-felt input:focus{outline:none;box-shadow:none}
.globalsok-treff{position:absolute;top:46px;left:0;right:0;z-index:45;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:12px;box-shadow:0 14px 44px rgba(15,25,45,.22);padding:6px;max-height:60vh;overflow-y:auto}
.globalsok-treff>button{width:100%;border:1px solid transparent;background:transparent;text-align:left;color:var(--sf-ink);padding:8px 10px;height:auto;display:grid;gap:2px;border-radius:7px;cursor:pointer;font:inherit}
.globalsok-treff>button:hover{background:var(--sf-surface-2)}
.globalsok-tittel{font-weight:620;font-size:13.5px}
.globalsok-under{color:var(--sf-ink-3);font-size:12px;display:flex;gap:8px;flex-wrap:wrap}
.globalsok-tom{color:var(--sf-ink-3);font-size:13px;padding:10px}
.dropdown-backdrop{position:fixed;inset:0;z-index:40;background:transparent}
.top-actions{display:flex;align-items:center;gap:8px;justify-self:end}
.top-actions .icon-btn{background:transparent;border:1px solid transparent;color:#b9c7d6}
.top-actions .icon-btn:hover{background:rgba(255,255,255,.09);color:#fff}
.ny-meny{position:relative}
.ny-knapp{font:inherit;height:36px;padding:0 14px;border-radius:9px;font-weight:650;background:var(--sf-accent);color:var(--sf-accent-ink);border:1px solid transparent;white-space:nowrap;cursor:pointer}
.ny-knapp:hover{filter:brightness(1.06)}
.ny-knapp[aria-expanded=true]{box-shadow:0 0 0 3px color-mix(in srgb,var(--sf-accent) 28%,transparent)}
.ny-panel{position:absolute;top:46px;right:0;z-index:41;width:280px;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:12px;box-shadow:0 12px 40px rgba(15,25,45,.16);padding:8px;display:flex;flex-direction:column;gap:2px}
.ny-panel>button{font:inherit;border:1px solid transparent;background:transparent;text-align:left;color:var(--sf-ink);padding:9px 10px;display:grid;gap:1px;height:auto;border-radius:7px;cursor:pointer}
.ny-panel>button:hover{background:var(--sf-surface-2)}
.ny-tittel{font-weight:650}
.ny-hint{font-size:12px;color:var(--sf-ink-3);font-weight:400;line-height:1.35}
.topbar .profile-trigger{border-color:rgba(255,255,255,.16);background:transparent;color:#fff}
.topbar .profile-trigger:hover,.topbar .profile-trigger[aria-expanded=true]{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.3)}
.topbar .profile-chevron{color:#93a5ba}
.app-body{display:grid;grid-template-columns:240px minmax(0,1fr);align-items:start}
.sidenav{position:sticky;top:64px;align-self:start;min-height:calc(100vh - 64px);background:var(--sf-navy);border-right:1px solid rgba(255,255,255,.08);padding:16px 12px 24px;display:flex;flex-direction:column;gap:2px}
.sidenav-merke{color:#93a5ba;font-size:10.5px;font-weight:700;letter-spacing:.09em;padding:10px 10px 6px}
.sidenav button{font:inherit;border:1px solid transparent;background:transparent;color:#cdd7e2;height:38px;padding:0 10px;justify-content:flex-start;display:flex;align-items:center;gap:8px;width:100%;font-weight:550;border-radius:8px;cursor:pointer}
/* Fast høyde (38px) på knappene betyr at en lang etikett som brekker over to
   linjer flyter utenfor knappen og ser ut som et underpunkt av raden over -
   sett i praksis med "Bekreftet · klar for Cloud". Ett-linjes tekst med
   avkorting løser det uansett hvor lang etiketten senere blir. */
.sidenav button span:not(.sidenav-tall){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;text-align:left}
.sidenav-ikon{flex:none;color:#93a5ba}
.sidenav button.active .sidenav-ikon{color:var(--sf-accent)}
.sidenav button:hover{background:rgba(255,255,255,.08);color:#fff}
.sidenav button.active{background:var(--sf-accent-soft);color:var(--sf-accent);font-weight:680}
.sidenav-tall{margin-left:auto;font-size:11.5px;font-weight:700;background:rgba(255,255,255,.12);color:#dbe4ec;border-radius:999px;padding:1px 7px;min-width:22px;text-align:center}
.sidenav button.active .sidenav-tall{background:var(--sf-accent);color:var(--sf-accent-ink)}
.sidenav-tall.varsel{background:var(--sf-warn-soft);color:var(--sf-warn)}
.sidenav-fot{margin-top:auto;display:flex;align-items:center;gap:8px;color:#93a5ba;font-size:11.5px;font-weight:550;padding:12px 10px;border-top:1px solid rgba(255,255,255,.1)}
.sidenav-status-dot{width:7px;height:7px;border-radius:50%;background:var(--sf-good);flex:none;animation:toast-puls 1.8s ease-in-out infinite}
.content-shell{width:100%;min-width:0;padding:26px 28px 80px}
.profile-menu-wrap{position:relative}.profile-trigger{font:inherit;display:flex;align-items:center;gap:8px;padding:4px 9px 4px 5px;border:1px solid var(--sf-border-strong);border-radius:9px;background:var(--sf-surface);color:var(--sf-ink);font-size:13px;font-weight:570;cursor:pointer}.profile-trigger:hover,.profile-trigger[aria-expanded=true]{border-color:var(--sf-accent);background:var(--sf-accent-soft)}.profile-avatar{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;background:var(--sf-accent);color:var(--sf-accent-ink);font-size:12px;font-weight:700}.profile-chevron{color:var(--sf-ink-3);font-size:14px}.profile-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:30;width:240px;padding:7px;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:11px;box-shadow:0 14px 40px rgba(15,25,45,.14)}.profile-identity{padding:9px 10px 12px;border-bottom:1px solid var(--sf-border);margin-bottom:5px}.profile-identity span,.profile-identity small{display:block;color:var(--sf-ink-3);font-size:11.5px}.profile-identity b{display:block;margin:2px 0 1px;font-size:14px}.profile-menu>button{font:inherit;width:100%;padding:9px 10px;border:0;border-radius:7px;background:transparent;color:var(--sf-ink);text-align:left;font-size:13px;cursor:pointer}.profile-menu>button:hover{background:var(--sf-surface-2)}.profile-menu>button.profile-logout{color:var(--sf-crit)}
main{width:100%;max-width:none;margin:0;padding:26px clamp(16px,2vw,40px) 80px}
.auth-root{display:grid;place-items:center;padding:24px}.login-card{width:min(430px,100%);background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:14px;padding:28px;box-shadow:0 18px 60px rgba(15,25,45,.1);display:flex;flex-direction:column;gap:14px}.login-card h1{font-size:23px}.login-card p{color:var(--sf-ink-2);margin:4px 0 0}.login-card .field{margin-top:0}.login-card .banner{margin:0}
.banner{background:var(--sf-crit-soft);color:var(--sf-crit);border:1px solid var(--sf-crit);border-radius:10px;padding:12px 16px;margin-bottom:18px;font-size:14px}
.import-page{width:100%;max-width:none}
.kladd-opplasting{margin-bottom:22px}
.page-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:20px}.page-heading h1{font-size:24px;letter-spacing:-.02em}.page-heading span{display:block;margin-top:2px;color:var(--sf-ink-3);font-size:13px}
.page-heading-hoyre{display:flex;align-items:center;gap:12px}
.sist-oppdatert{color:var(--sf-ink-3);font-size:12.5px;white-space:nowrap}
.overview-section-heading{display:flex;align-items:flex-end;justify-content:space-between;margin:4px 0 12px}.overview-section-heading h2{font-size:16px}.overview-section-heading span{display:block;margin-top:2px;color:var(--sf-ink-3);font-size:13px}
.link-btn{font:inherit;background:none;border:0;color:var(--sf-accent);font-weight:610;cursor:pointer;padding:2px}.link-btn:hover{text-decoration:underline}
.overview-queues{display:grid;grid-template-columns:repeat(5,minmax(170px,1fr));gap:12px}.overview-queues button{font:inherit;text-align:left;display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:16px;border:1px solid var(--sf-border);border-radius:10px;background:var(--sf-surface);color:var(--sf-ink-2);cursor:pointer}.overview-queues button:hover{border-color:var(--sf-accent);box-shadow:0 4px 18px rgba(26,34,48,.06)}.overview-queues button span{font-weight:580}.overview-queues button b{grid-row:1/3;grid-column:2;font-size:24px;color:var(--sf-ink)}.overview-queues button small{font-size:12px;color:var(--sf-accent)}
.upload-card{background:var(--sf-surface);border-radius:12px;padding:22px 24px;margin-bottom:20px}
.upload-card h2{font-size:19px;text-align:center}.upload-card p{margin:5px 0 0;color:var(--sf-ink-2);max-width:560px;text-align:center}
.drop-zone{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;border:2px dashed var(--sf-border-strong);background:var(--sf-surface-2);border-radius:14px;padding:30px 24px;transition:border-color .15s,background .15s,box-shadow .15s}
.drop-zone.dragging{border-color:var(--sf-accent);background:var(--sf-accent-soft);box-shadow:0 0 0 4px color-mix(in srgb,var(--sf-accent) 12%,transparent)}
.drop-zone-icon{width:44px;height:44px;border-radius:999px;background:var(--sf-accent-soft);color:var(--sf-accent);display:grid;place-items:center;margin-bottom:6px}
.drop-zone-or{color:var(--sf-ink-3);font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;margin:6px 0}
.upload-btn{display:inline-flex;align-items:center;justify-content:center;background:var(--sf-accent);color:var(--sf-accent-ink);padding:10px 16px;border-radius:8px;font-weight:620;cursor:pointer;white-space:nowrap}.upload-btn input{position:absolute;opacity:0;pointer-events:none}.upload-btn:has(input:disabled){opacity:.55;cursor:not-allowed}
.upload-btn.sm{padding:5px 10px;font-size:13px;border-radius:7px}
.ny-avtale-edit{display:flex;flex-direction:column;gap:4px;padding:6px 0}
.sf-root .ny-avtale-edit input{font:inherit;border:1px solid transparent;background:transparent;border-radius:6px;padding:3px 6px;width:100%}
.sf-root .ny-avtale-edit input:hover:not(:disabled){border-color:var(--sf-border)}
.sf-root .ny-avtale-edit input:focus{border-color:var(--sf-accent);background:var(--sf-surface);outline:none}
.sf-root .ny-avtale-edit input:disabled{color:inherit;cursor:default}
.sf-root .ny-avtale-belop{font:inherit;border:1px solid transparent;background:transparent;border-radius:6px;padding:3px 6px}
.sf-root .ny-avtale-belop:hover:not(:disabled){border-color:var(--sf-border)}
.sf-root .ny-avtale-belop:focus{border-color:var(--sf-accent);background:var(--sf-surface);outline:none}
.ny-avtale-navn{font-weight:700;font-size:14.5px}
.ny-avtale-rad2{display:flex;align-items:center;gap:4px}
.ny-avtale-rad2 input{font-size:12.5px;color:var(--sf-ink-3);width:auto}
.ny-avtale-kunde{flex:1;min-width:0}
.ny-avtale-at{flex:none;width:90px!important}
.ny-avtale-sep{color:var(--sf-ink-3);font-size:12.5px}
.ny-avtale-edit>input[placeholder="Kommentar"]{font-size:12.5px;color:var(--sf-ink-3)}
.ny-avtale-belop{text-align:right;width:100%}
.sf-root .ny-avtale-dato{font:inherit;font-family:var(--sf-mono);border:1px solid transparent;background:transparent;border-radius:6px;padding:3px 6px;width:100%;color-scheme:light}
.sf-root .ny-avtale-dato:hover:not(:disabled){border-color:var(--sf-border)}
.sf-root .ny-avtale-dato:focus{border-color:var(--sf-accent);background:var(--sf-surface);outline:none}
.ny-avtale-dato-visning{font:inherit;font-family:var(--sf-mono);border:1px solid transparent;background:transparent;border-radius:6px;padding:3px 6px;color:inherit;cursor:pointer;text-align:right}
.ny-avtale-dato-visning:hover:not(:disabled){border-color:var(--sf-border)}
.ny-avtale-dato-visning:disabled{cursor:default;color:inherit}
.sf-root .ny-avtale-lenke{font:inherit;font-size:12.5px;border:1px solid transparent;background:transparent;border-radius:6px;padding:3px 6px;width:100%;color:var(--sf-ink-2)}
.sf-root .ny-avtale-lenke:hover:not(:disabled){border-color:var(--sf-border)}
.sf-root .ny-avtale-lenke:focus{border-color:var(--sf-accent);background:var(--sf-surface);outline:none;color:var(--sf-ink)}
tr.ny-avtale-drag-over{outline:2px dashed var(--sf-accent);outline-offset:-2px;background:var(--sf-accent-soft)}
.import-summary{overflow:hidden}.summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--sf-border);border-bottom:1px solid var(--sf-border)}
.summary-item{background:var(--sf-surface);padding:14px 18px}.summary-item span{display:block;color:var(--sf-ink-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}.summary-item b{display:block;margin-top:3px;font-size:15px}
.import-org{display:grid;grid-template-columns:220px minmax(260px,420px) 1fr;align-items:center;gap:12px;padding:16px 18px}.import-org label{font-size:13px;font-weight:620}.import-org span{font-size:12px;color:var(--sf-ink-3)}
.excel-sheet-picker{display:grid;grid-template-columns:80px minmax(280px,480px) 1fr;align-items:center;gap:12px;padding:16px 18px}.excel-sheet-picker label{font-size:13px;font-weight:620}.excel-sheet-picker span{font-size:12px;color:var(--sf-ink-3)}
.mapping-table{border:0;border-radius:0}.mapping-table td{vertical-align:middle}.mapping-table input,.mapping-table select{max-width:220px}
.tiles{display:grid;grid-template-columns:repeat(5,1fr);margin-bottom:20px;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:10px;overflow:hidden}
.tile{padding:14px 16px;border-left:1px solid var(--sf-border)}
.tile:first-child{border-left:0}
.tile .k{font-size:12px;color:var(--sf-ink-3);letter-spacing:.03em;text-transform:uppercase}
.tile .v{font-size:27px;font-weight:680;letter-spacing:-.02em;margin-top:3px}
.tile-v-num{font-size:1em}
.tile-v-unit{font-size:.42em;font-weight:600;color:var(--sf-ink-3);letter-spacing:0}
.tile-v-sep{font-size:.6em;color:var(--sf-ink-3);padding:0 1px}
.tile-sub{display:block;font-size:12.5px;font-weight:500;color:var(--sf-ink-3);margin-top:4px;line-height:1.4}
.tile.alert .v{color:var(--sf-warn)}
.tile-bar{display:flex;height:5px;border-radius:999px;overflow:hidden;background:var(--sf-surface-2);margin-top:10px}
.tile-bar .seg-1{display:block;height:100%;background:var(--sf-accent)}
.tile-bar .seg-2{display:block;height:100%;background:var(--sf-accent-soft)}
.overview-2col{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;margin-bottom:20px;align-items:stretch}
.volum-chart .hd{align-items:flex-start;justify-content:space-between}.volum-chart .hd select{margin-left:12px}
.volum-chart-valg{display:flex;align-items:center;gap:10px}
.venter-varsel{display:inline-flex;align-items:center;gap:6px;color:var(--sf-warn);font-size:12.5px;font-weight:610;margin-bottom:8px}
.ny-avtale-knapper{display:flex;flex-direction:column;gap:6px;align-items:stretch;min-width:140px}
.ny-avtale-knapper .btn{position:relative;justify-content:center;display:inline-flex;align-items:center;gap:6px}
.ny-avtale-hent input{position:absolute;inset:0;opacity:0;cursor:pointer}
.nye-faner{display:flex;gap:4px;border-bottom:1px solid var(--sf-border);margin-bottom:16px}
.nye-faner button{font:inherit;font-size:14px;font-weight:600;padding:9px 4px 11px;margin-right:20px;border:0;border-bottom:2px solid transparent;background:none;color:var(--sf-ink-3);cursor:pointer}
.nye-faner button.active{color:var(--sf-ink);border-bottom-color:var(--sf-accent)}
.nye-faner-tall{display:inline-block;margin-left:4px;font-size:12px;font-weight:700;background:var(--sf-surface-2);color:var(--sf-ink-2);border-radius:999px;padding:1px 8px}
.nye-faner button.active .nye-faner-tall{background:var(--sf-accent-soft);color:var(--sf-accent)}
.seg-toggle{display:flex;border:1px solid var(--sf-border-strong);border-radius:8px;overflow:hidden}
.seg-toggle button{font:inherit;font-size:12.5px;font-weight:560;padding:6px 10px;border:0;background:var(--sf-surface);color:var(--sf-ink-2);cursor:pointer}
.seg-toggle button+button{border-left:1px solid var(--sf-border-strong)}
.seg-toggle button.active{background:var(--sf-accent);color:var(--sf-accent-ink)}
.volum-bars{display:flex;align-items:flex-end;gap:8px;padding:20px 16px 14px;height:160px}
.volum-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;min-width:0}
.volum-bar-track{flex:1;display:flex;align-items:flex-end;width:100%;max-width:32px}
.volum-bar{width:100%;background:var(--sf-accent-soft);border-radius:4px 4px 0 0;min-height:2px;transition:height .2s}
.volum-bar.naa{background:var(--sf-accent)}
.volum-bar-val{font-size:11px;color:var(--sf-ink-3);margin-top:6px;height:14px}
.volum-bar-label{font-size:12px;color:var(--sf-ink-2);margin-top:2px}
.livslop .hd h2{display:flex;align-items:center;gap:8px}
.livslop-puls{color:var(--sf-accent)}
.livslop-soyler{display:flex;align-items:flex-end;gap:10px;padding:22px 18px 16px;height:190px}
.livslop-soyle-col{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;min-width:0}
.livslop-soyle-val{font-size:13px;font-weight:700;margin-bottom:6px}
.livslop-soyle-track{flex:1;display:flex;align-items:flex-end;width:100%;max-width:44px}
.livslop-soyle{width:100%;background:var(--sf-accent-soft);border-radius:5px 5px 0 0;min-height:3px;transition:height .2s}
.livslop-soyle.naa{background:var(--sf-accent)}
.livslop-soyle-label{font-size:11.5px;color:var(--sf-ink-3);margin-top:8px;text-align:center;line-height:1.25}
.livslop-revisjon{font:inherit;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--sf-border);color:var(--sf-ink-2);font-size:12.5px;padding:11px 18px;cursor:pointer}
.livslop-revisjon:hover{color:var(--sf-accent);background:var(--sf-accent-soft)}
.livslop-revisjon b{color:var(--sf-ink);font-weight:700}
.neste-handling{margin-bottom:20px}
.neste-handling-rader{display:flex;flex-direction:column}
.neste-rad{font:inherit;display:flex;align-items:center;gap:14px;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--sf-border);padding:14px 18px;cursor:pointer}
.neste-rad:first-child{border-top:0}
.neste-rad:hover{background:var(--sf-surface-2)}
.neste-ikon{flex-shrink:0;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--sf-accent-soft);color:var(--sf-accent)}
.neste-tekst{flex:1;min-width:0;display:flex;flex-direction:column}
.neste-tekst b{font-size:14px;font-weight:650;color:var(--sf-ink)}
.neste-tekst span{font-size:12.5px;color:var(--sf-ink-3);margin-top:1px}
.neste-pil{color:var(--sf-ink-3);font-size:16px}
.priokort-mer{font:inherit;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--sf-border);color:var(--sf-ink-3);font-size:12.5px;padding:9px 0 0;margin-top:2px;cursor:pointer}
.priokort-mer:hover{color:var(--sf-accent)}
.panel{background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:10px;margin-bottom:20px}
.panel>.hd{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--sf-border)}
.panel>.hd h2{font-size:15px;font-weight:620}
.panel>.hd .sub{color:var(--sf-ink-3);font-size:13px}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px}
.toolbar .grow{flex:1}
.worklist-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:2px 0 12px}.worklist-heading h1{font-size:20px;letter-spacing:-.015em}.worklist-heading span{display:block;margin-top:1px;color:var(--sf-ink-3);font-size:12.5px}.work-toolbar{padding:12px;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:10px}
.bulk-bar{display:flex;align-items:center;gap:12px;margin:-2px 0 14px;padding:10px 12px;border:1px solid var(--sf-accent);border-radius:9px;background:var(--sf-accent-soft);color:var(--sf-accent)}.bulk-bar span{font-size:13px;color:var(--sf-ink-2)}.bulk-bar .grow{flex:1}
.work-search{flex:1 1 300px;min-width:240px;max-width:520px}
.work-queues{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:8px;margin-bottom:18px;overflow-x:auto}.work-queues button{font:inherit;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:140px;padding:10px 12px;border:1px solid var(--sf-border);border-radius:9px;background:var(--sf-surface);color:var(--sf-ink-2);cursor:pointer}.work-queues button:hover{border-color:var(--sf-border-strong);color:var(--sf-ink)}.work-queues button.active{border-color:var(--sf-accent);background:var(--sf-accent-soft);color:var(--sf-accent)}.work-queues b{font-size:17px;color:inherit}
.sf-root select,.sf-root input,.sf-root textarea{font:inherit;color:var(--sf-ink);background:var(--sf-surface);border:1px solid var(--sf-border-strong);border-radius:7px;padding:8px 10px}
.sf-root select:focus,.sf-root input:focus,.sf-root textarea:focus{outline:2px solid var(--sf-accent);outline-offset:1px;border-color:var(--sf-accent)}
label.flt{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--sf-ink-2)}
.btn{font:inherit;font-weight:560;cursor:pointer;border-radius:8px;padding:9px 15px;border:1px solid var(--sf-border-strong);background:var(--sf-surface);color:var(--sf-ink)}
.btn:hover{border-color:var(--sf-ink-3)}
.btn.primary{background:var(--sf-accent);border-color:var(--sf-accent);color:var(--sf-accent-ink)}
.btn.primary:hover{filter:brightness(1.06)}
.btn.danger{color:var(--sf-crit);border-color:color-mix(in srgb,var(--sf-crit) 45%,var(--sf-border))}.btn.danger:hover{background:var(--sf-crit-soft);border-color:var(--sf-crit)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.sm{padding:5px 10px;font-size:13px}
.icon-btn{font:inherit;cursor:pointer;background:var(--sf-surface);border:1px solid var(--sf-border);color:var(--sf-ink-2);width:34px;height:34px;border-radius:8px;display:grid;place-items:center}
.tablewrap{width:100%;max-width:100%;overflow-x:auto;border:1px solid var(--sf-border);border-radius:10px;background:var(--sf-surface)}
.action-select{min-width:125px;padding:6px 30px 6px 10px!important;font-size:13px!important;font-weight:560}.compact-input{min-width:150px;padding:5px 7px!important;font-size:12.5px!important}
.sf-root table{border-collapse:collapse;width:100%;font-size:13.5px}
.sf-root th,.sf-root td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--sf-border);white-space:nowrap}
.sf-root th.select-cell,.sf-root td.select-cell{width:42px;padding-left:14px;padding-right:6px}.select-cell input{width:16px;height:16px;cursor:pointer}
.sf-root th{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--sf-ink-3);font-weight:620;background:var(--sf-surface-2);position:sticky;top:0}
.sf-root tbody tr:hover{background:var(--sf-surface-2)}
.sf-root tbody tr:last-child td{border-bottom:none}
td .muted{color:var(--sf-ink-3)}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:560;padding:3px 9px;border-radius:999px}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.s-kladd{color:var(--sf-ink-2);background:var(--sf-surface-2)}
.pill.s-innmeldt,.pill.s-sendt{color:var(--sf-accent);background:var(--sf-accent-soft)}
.pill.s-klar{color:var(--sf-warn);background:var(--sf-warn-soft)}
.pill.s-bekreftet,.pill.s-cloud,.pill.s-aktiv{color:var(--sf-good);background:var(--sf-good-soft)}
.intake{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:1040px}
.edit-banner{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid var(--sf-accent);background:var(--sf-accent-soft);color:var(--sf-accent);border-radius:9px}.edit-banner span{font-size:13px;color:var(--sf-ink-2)}
.sf-root fieldset{grid-column:span 1;border:1px solid var(--sf-border);border-radius:10px;background:var(--sf-surface);padding:16px 18px 18px;margin:0}
.sf-root fieldset.wide{grid-column:1/-1}
.sf-root legend{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--sf-accent);font-weight:640;padding:0 6px}
.field{display:flex;flex-direction:column;gap:5px;margin-top:12px}
.field:first-of-type{margin-top:6px}
.field label{font-size:13px;font-weight:550;color:var(--sf-ink-2)}
.field label .req{color:var(--sf-crit)}
.field .hint{font-size:12px;color:var(--sf-ink-3)}
.field .err{font-size:12px;color:var(--sf-crit)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.radio-row{display:flex;gap:10px;margin-top:6px}
.radio-card{flex:1;border:1px solid var(--sf-border-strong);border-radius:8px;padding:10px 12px;cursor:pointer;position:relative}
.radio-card[data-on=true]{border-color:var(--sf-accent);background:var(--sf-accent-soft)}
.radio-card b{display:block;font-size:13.5px}
.radio-card span{font-size:12px;color:var(--sf-ink-2)}
.radio-card input{position:absolute;opacity:0}
.formfoot{grid-column:1/-1;display:flex;align-items:center;gap:12px}
.formfoot .note{font-size:13px;color:var(--sf-ink-3)}
.checkline{display:inline-flex;align-items:center;gap:8px;font-size:14px}
.empty{padding:40px 20px;text-align:center;color:var(--sf-ink-3)}
.modal-bg{position:fixed;inset:0;background:rgba(10,15,25,.5);display:grid;place-items:center;padding:24px;z-index:40}
.modal{background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:12px;max-width:900px;width:100%;max-height:86vh;overflow:auto}
.modal .hd{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--sf-border);position:sticky;top:0;background:var(--sf-surface)}
.modal .hd h2{font-size:16px}
.modal .bd{padding:18px 20px}
.history-modal{max-width:680px}.history-event{display:grid;grid-template-columns:14px 1fr;gap:10px;padding:12px 0;border-bottom:1px solid var(--sf-border)}.history-event:last-child{border-bottom:0}.history-dot{width:9px;height:9px;border-radius:50%;background:var(--sf-accent);margin-top:7px}.history-event b{font-size:14px}.history-event small{display:block;color:var(--sf-ink-3);margin-top:3px}.history-event .muted{font-size:13px;color:var(--sf-ink-2)}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--sf-navy);color:#fff;padding:10px 18px;border-radius:14px;font-size:14px;font-weight:550;opacity:0;transition:opacity .2s,transform .2s;z-index:60;pointer-events:none;max-width:520px;white-space:normal;text-align:center;line-height:1.4;display:flex;align-items:center;justify-content:center;gap:9px;box-shadow:0 12px 30px rgba(10,20,35,.35)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast-dot{width:8px;height:8px;border-radius:50%;background:var(--sf-good);flex:none;animation:toast-puls 1.4s ease-in-out infinite}
.toast-tekst{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:1px}
.toast-tekst b{font-weight:650;font-size:14px}
.toast-tekst span{font-size:12px;color:#93a5ba;font-weight:500}
@keyframes toast-puls{0%,100%{opacity:1}50%{opacity:.35}}
@media (max-width:1100px){.overview-queues{grid-template-columns:repeat(3,minmax(170px,1fr))}.brand-panel p{display:none}.topbar{grid-template-columns:auto minmax(0,1fr) auto}}
@media (max-width:900px){
  .app-body{grid-template-columns:1fr}
  .sidenav{position:static;min-height:auto;flex-direction:row;overflow-x:auto;border-right:none;border-bottom:1px solid rgba(255,255,255,.1);padding:10px 12px}
  .sidenav-merke,.sidenav-fot{display:none}
  .sidenav button{width:auto;white-space:nowrap}
}
@media (max-width:780px){.tiles{grid-template-columns:repeat(2,1fr)}.tile:nth-child(odd){border-left:0}.tile:nth-child(n+3){border-top:1px solid var(--sf-border)}.overview-queues{grid-template-columns:1fr 1fr}.overview-2col{grid-template-columns:1fr}.priokoer{grid-template-columns:1fr}.page-heading,.worklist-heading{align-items:flex-start}.topbar{grid-template-columns:1fr auto;grid-template-rows:auto auto;padding:10px 12px;gap:8px}.globalsok{grid-column:1/-1;order:3;justify-self:stretch;width:100%}.brand-panel{padding:0}.intake{grid-template-columns:1fr}.sf-root fieldset{grid-column:1/-1}.summary-grid{grid-template-columns:1fr 1fr}.import-org,.excel-sheet-picker{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.toast{transition:none}}
/* premium polish */
.topbar{box-shadow:0 1px 0 rgba(0,0,0,.15),0 2px 14px rgba(16,32,45,.18);z-index:30}
.brand-panel{background:linear-gradient(155deg,#1a3a53,var(--sf-navy));margin:-1px 0;align-self:stretch}
.tiles{border-radius:13px;box-shadow:var(--sf-shadow)}
.tile{padding:19px 21px}
.tile .v{font-size:33px;letter-spacing:-.03em;margin-top:5px}
.panel,.work-toolbar,.tablewrap,.upload-card,.import-summary{border-radius:13px;box-shadow:var(--sf-shadow)}
.overview-queues button,.work-queues button{border-radius:12px;box-shadow:var(--sf-shadow);transition:border-color .15s,box-shadow .18s,transform .18s}
.overview-queues button:hover,.work-queues button:hover{transform:translateY(-1px);box-shadow:var(--sf-shadow-md)}
.btn{transition:border-color .15s,background .15s,box-shadow .15s,transform .05s}
.btn:active{transform:translateY(1px)}
.btn.primary{background:linear-gradient(180deg,var(--sf-accent),var(--sf-accent-strong));border-color:var(--sf-accent-strong);box-shadow:0 1px 2px rgba(0,60,55,.25),0 6px 16px color-mix(in srgb,var(--sf-accent) 28%,transparent)}
.btn.primary:hover{filter:none;box-shadow:0 2px 5px rgba(0,60,55,.3),0 10px 24px color-mix(in srgb,var(--sf-accent) 36%,transparent)}
.sf-root th{background:var(--sf-surface);border-bottom:1px solid var(--sf-border-strong)}
.sf-root td{padding-top:10px;padding-bottom:10px}
.sf-root th:first-child,.sf-root td:first-child{padding-left:18px}
.sf-root th:last-child,.sf-root td:last-child{padding-right:18px}
.sf-root tbody tr{transition:background .12s}
.pill{padding:4px 10px;border:1px solid color-mix(in srgb,currentColor 20%,transparent)}
.login-card{box-shadow:var(--sf-shadow-md),0 40px 90px rgba(16,32,45,.1)}
.modal{box-shadow:0 30px 80px rgba(10,18,30,.4)}
.action-select{font-weight:500;color:var(--sf-ink-2);border-color:var(--sf-border)}
.action-select:hover{border-color:var(--sf-border-strong);color:var(--sf-ink)}
.empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:48px 20px}
.empty b{font-size:15px;color:var(--sf-ink);font-weight:600}
.empty span{font-size:13px;color:var(--sf-ink-3)}
`;

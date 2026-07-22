"use client";

// Strømflyt: innmelding + register, koblet mot Supabase-tabellen strombestillinger.
// Drop-in for App Router: app/stromflyt/page.tsx. Krever @supabase/supabase-js
// og env-variablene NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.

import { useEffect, useMemo, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import {
  STAGES,
  CLOUD_ORGS,
  NETTEIERE,
  PRISOMRADER,
  validateMalepunkt,
  kommersielt,
  nextStatus,
  previousStatus,
  fmt,
  ENTELIOS_COLUMNS,
  type Malepunkt,
  type Status,
  type Rute,
} from "../../lib/stromflyt-config";
import {
  listMalepunkt,
  insertMalepunkt,
  insertMalepunktWithStatus,
  updateStatus,
  updateStatuses,
  updateMalepunktDetails,
  updateCustomerSeller,
  deleteMalepunkt,
  listHistory,
  markBatchSent,
  type HistoryEvent,
} from "../../lib/stromflyt-api";
import type { ParsedAvtale } from "../../lib/avtale-parser";
import type { ParsedExcelWorkbook, ParsedExcelRow, ParsedExcelSheet } from "../../lib/excel-parser";
import { supabase } from "../../lib/supabaseClient";

type ExcelGroupConfig = {
  kunde: string;
  org_nr: string;
  selger: string;
  cloud_org: string;
  rute: Rute | "";
  paslag_ore_kwh: string;
  fast_aarspris: string;
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
  s.replace("Innmeldt", "Registrert internt").replace("Klar for bestilling", "Klar").replace("Sendt Entelios", "Sendt").replace("Satt opp i Cloud", "Cloud");

const displayStatus = (s: string) => s === "Innmeldt" ? "Registrert internt" : s;

type WorkFilter = "" | "handling" | "venter" | "klar-cloud" | "cloud" | "drift";
type SortKey = "arbeidsrekkefolge" | "oppstart" | "kunde" | "status" | "nyeste";

const WORK_FILTERS: { key: WorkFilter; label: string; statuses: Status[] }[] = [
  { key: "", label: "Alle", statuses: [] },
  { key: "handling", label: "Trenger behandling", statuses: ["Kladd", "Innmeldt", "Klar for bestilling"] },
  { key: "venter", label: "Venter på Entelios", statuses: ["Sendt Entelios"] },
  { key: "klar-cloud", label: "Bekreftet · klar for Cloud", statuses: ["Bekreftet"] },
  { key: "cloud", label: "Cloud-oppsett", statuses: ["Satt opp i Cloud"] },
  { key: "drift", label: "I drift", statuses: ["Aktiv"] },
];

const emptyForm: Partial<Malepunkt> = {
  kunde: "", org_nr: "", selger: "", cloud_org: "", bygg: "", adresse: "", maalenummer: "",
  maalepunkt_id: "", netteier: "", prisomrade: "", aarsforbruk_kwh: null,
  avtalt_oppstart: "", at_kode: "", rute: "", paslag_ore_kwh: null,
  fast_pr_maaler: null, fast_aarspris: null, signert: false, kommentar: "",
};

export default function StromflytPage() {
  const requireAuth = process.env.NEXT_PUBLIC_REQUIRE_AUTH === "true";
  const [tab, setTab] = useState<"reg" | "form" | "import" | "excel">("reg");
  const [rows, setRows] = useState<Malepunkt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fltRute, setFltRute] = useState("");
  const [fltStatus, setFltStatus] = useState("");
  const [workFilter, setWorkFilter] = useState<WorkFilter>("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("arbeidsrekkefolge");
  const [batchOpen, setBatchOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [form, setForm] = useState<Partial<Malepunkt>>({ ...emptyForm });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const [lookup, setLookup] = useState<{ loading: boolean; msg: string }>({ loading: false, msg: "" });
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [parsed, setParsed] = useState<ParsedAvtale | null>(null);
  const [selectedRows, setSelectedRows] = useState<Record<number, boolean>>({});
  const [rowAtCodes, setRowAtCodes] = useState<Record<number, string>>({});
  const [importCloudOrg, setImportCloudOrg] = useState("Strømkunder");
  const [importSeller, setImportSeller] = useState("");
  const [importName, setImportName] = useState("");
  const [excelParsing, setExcelParsing] = useState(false);
  const [excelImporting, setExcelImporting] = useState(false);
  const [excelData, setExcelData] = useState<ParsedExcelWorkbook | null>(null);
  const [excelSheetName, setExcelSheetName] = useState("");
  const [excelName, setExcelName] = useState("");
  const [excelSelected, setExcelSelected] = useState<Record<number, boolean>>({});
  const [excelMappings, setExcelMappings] = useState<Record<string, ExcelGroupConfig>>({});
  const [dragTarget, setDragTarget] = useState<"pdf" | "excel" | null>(null);
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<Malepunkt | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    const authType = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("type");
    const pendingPassword = window.sessionStorage.getItem("stromflyt_pending_password");
    const isInvite = authType === "invite" || authType === "recovery" || pendingPassword === "invite" || pendingPassword === "recovery";
    if (isInvite) { setPasswordContext("invite"); setNeedsPassword(true); setAuthLoading(true); }
    if (!requireAuth && !isInvite) { refresh(); return; }
    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user.email || null);
      setAuthLoading(false);
      if (data.session) refresh();
    });
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
  }, [search, fltRute, fltStatus, workFilter]);

  async function refresh() {
    setLoading(true);
    try { setRows(await listMalepunkt()); setErr(null); }
    catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  }
  function flash(m: string) { setToast(m); window.setTimeout(() => setToast(""), 2400); }

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setLoginError("");
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail.trim(), password: loginPassword });
    if (error) { setLoginError("Feil e-post eller passord."); setAuthLoading(false); }
  }

  async function signOut() {
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

  const errors = useMemo(() => validateMalepunkt(form), [form]);
  const isValid = Object.keys(errors).length === 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const activeWork = WORK_FILTERS.find((f) => f.key === workFilter);
    const result = rows.filter((r) => {
      const text = [r.kunde, r.selger, r.bygg, r.adresse, r.maalepunkt_id, r.maalenummer, r.at_kode, r.netteier].join(" ").toLowerCase();
      return (!fltRute || r.rute === fltRute)
        && (!fltStatus || r.status === fltStatus)
        && (!activeWork?.statuses.length || activeWork.statuses.includes(r.status))
        && (!q || text.includes(q));
    });
    return [...result].sort((a, b) => {
      if (sortKey === "oppstart") return (a.avtalt_oppstart || "9999").localeCompare(b.avtalt_oppstart || "9999");
      if (sortKey === "kunde") return a.kunde.localeCompare(b.kunde, "nb");
      if (sortKey === "status") return STAGES.indexOf(a.status) - STAGES.indexOf(b.status);
      if (sortKey === "nyeste") return String(b.created_at || "").localeCompare(String(a.created_at || ""));
      // Operativ kø: først neste steg i prosessen, deretter nærmeste oppstart.
      const stage = STAGES.indexOf(a.status) - STAGES.indexOf(b.status);
      return stage || (a.avtalt_oppstart || "9999").localeCompare(b.avtalt_oppstart || "9999");
    });
  }, [rows, fltRute, fltStatus, workFilter, search, sortKey]);
  const batchRows = useMemo(() => rows.filter((r) => r.status === "Klar for bestilling"), [rows]);
  const selectedRowsForBulk = useMemo(() => rows.filter((r) => selectedIds.includes(r.id)), [rows, selectedIds]);
  const selectedRegisteredIds = useMemo(
    () => selectedRowsForBulk.filter((r) => r.status === "Innmeldt").map((r) => r.id),
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
    return excelSelected[r.source_row] && r.gyldig && !duplicate && excelMappingValid(excelMappings[excelGroupKey(r)]);
  }).length || 0, [excelSheet, excelSelected, excelMappings, rows]);

  const tiles = useMemo(() => {
    const a = rows.filter((r) => r.rute === "A").length;
    const b = rows.filter((r) => r.rute === "B").length;
    const arr = rows.filter((r) => r.rute === "A").reduce((s, r) => s + (Number(r.fast_aarspris) || 0), 0);
    const trenger = rows.filter((r) => r.status === "Innmeldt" || r.status === "Klar for bestilling").length;
    return { total: rows.length, a, b, arr, trenger };
  }, [rows]);

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

  async function parsePdf(file: File | undefined) {
    if (!file) return;
    setParsing(true);
    setParsed(null);
    setImportName(file.name);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/avtale/parse", { method: "POST", body });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Kunne ikke lese avtalen");
      const result = data as ParsedAvtale & { ok: true };
      setParsed(result);
      setImportCloudOrg(result.rute === "B" ? "Strømkunder" : result.kunde || "");
      setImportSeller(rows.find((r) => r.org_nr === result.org_nr)?.selger || "");
      const next: Record<number, boolean> = {};
      result.rows.forEach((r, i) => {
        const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
        next[i] = r.gyldig && !duplicate;
      });
      setSelectedRows(next);
      setRowAtCodes({});
    } catch (e: any) {
      flash("Kunne ikke lese avtalen: " + (e.message ?? e));
    } finally {
      setParsing(false);
    }
  }

  function dropFile(e: DragEvent<HTMLDivElement>, kind: "pdf" | "excel") {
    e.preventDefault();
    setDragTarget(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (kind === "pdf") {
      if (!file.name.toLowerCase().endsWith(".pdf")) { flash("Slipp en PDF-avtale her"); return; }
      parsePdf(file);
    } else {
      if (!file.name.toLowerCase().endsWith(".xlsx")) { flash("Slipp en .xlsx-fil her"); return; }
      parseExcel(file);
    }
  }

  function setupExcelSheet(sheet: ParsedExcelSheet) {
    setExcelSheetName(sheet.name);
    const selected: Record<number, boolean> = {};
    const mappings: Record<string, ExcelGroupConfig> = {};
    sheet.rows.forEach((r) => {
      const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
      selected[r.source_row] = r.gyldig && !duplicate;
      const key = excelGroupKey(r);
      if (!mappings[key]) {
        const inferredRoute: Rute | "" = r.paslag_ore_kwh != null || /^strømkunder$/i.test(r.cloud_org.trim()) ? "B" : "";
        const existingCustomer = rows.find((existing) => existing.org_nr === r.org_nr);
        mappings[key] = {
          kunde: r.selskapsnavn || r.kunde_hint || r.bygg || r.cloud_org || key,
          org_nr: /^\d{9}$/.test(r.org_nr) ? r.org_nr : "",
          selger: existingCustomer?.selger || "",
          cloud_org: r.cloud_org || (inferredRoute === "B" ? "Strømkunder" : ""),
          rute: inferredRoute,
          paslag_ore_kwh: r.paslag_ore_kwh != null ? String(r.paslag_ore_kwh) : "",
          fast_aarspris: "",
          signert: r.signert ?? r.status_suggestion === "Sendt Entelios",
        };
      }
    });
    setExcelSelected(selected);
    setExcelMappings(mappings);
  }

  async function parseExcel(file: File | undefined) {
    if (!file) return;
    setExcelParsing(true);
    setExcelData(null);
    setExcelName(file.name);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/excel/parse", { method: "POST", body });
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

  function excelMappingValid(m: ExcelGroupConfig | undefined) {
    if (!m || !m.kunde.trim() || !/^\d{9}$/.test(m.org_nr) || !m.cloud_org.trim() || !m.signert) return false;
    if (m.rute === "B") return /^\d+([.,]\d+)?$/.test(m.paslag_ore_kwh);
    if (m.rute === "A") return /^\d+$/.test(m.fast_aarspris);
    return false;
  }

  async function importExcelRows() {
    if (!excelSheet) return;
    const chosen = excelSheet.rows.filter((r) => {
      const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
      return excelSelected[r.source_row] && r.gyldig && !duplicate && excelMappingValid(excelMappings[excelGroupKey(r)]);
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
          netteier: r.netteier,
          prisomrade: r.prisomrade,
          aarsforbruk_kwh: r.aarsforbruk_kwh,
          avtalt_oppstart: r.oppstartdato,
          at_kode: r.referansekode,
          rute: mapping.rute,
          paslag_ore_kwh: mapping.rute === "B" ? Number(mapping.paslag_ore_kwh.replace(",", ".")) : null,
          fast_pr_maaler: null,
          fast_aarspris: mapping.rute === "A" ? Number(mapping.fast_aarspris) : null,
          signert: mapping.signert,
          kommentar: [r.kommentar, `Importert fra ${excelName} · ${excelSheet.name} rad ${r.source_row}`].filter(Boolean).join(" · "),
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
    if (!parsed || !parsed.rute || !parsed.kunde || !parsed.org_nr) return;
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
          cloud_org: importCloudOrg || (parsed.rute === "B" ? "Strømkunder" : parsed.kunde),
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
          rute: parsed.rute,
          paslag_ore_kwh: parsed.rute === "B" ? parsed.paslag_ore_kwh : null,
          fast_pr_maaler: parsed.fast_pr_maaler,
          fast_aarspris: parsed.rute === "A" ? parsed.fast_aarspris : null,
          signert: parsed.avtale_signert,
          kommentar: `Importert fra avtale-PDF: ${importName}${parsed.doc_ref ? ` · PandaDoc ${parsed.doc_ref}` : ""}`,
        });
        if (importSeller.trim()) await updateCustomerSeller(parsed.org_nr, importSeller);
        ok += 1;
      } catch (e: any) {
        failures.push(`${row.adresse}: ${e.message ?? e}`);
      }
    }
    setImporting(false);
    await refresh();
    if (ok) {
      setParsed(null);
      setTab("reg");
      flash(`${ok} målepunkt lagt i registeret${failures.length ? `, ${failures.length} hoppet over` : ""}`);
    } else {
      flash(failures[0] || "Ingen målepunkt ble lagt inn");
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
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function newManualEntry() {
    setEditingId(null);
    setForm({ ...emptyForm });
    setTouched({});
    setShowAll(false);
    setTab("form");
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
      const payload = {
        kunde: form.kunde!, org_nr: form.org_nr!, selger: form.selger?.trim() || "", cloud_org: form.cloud_org!,
        bygg: form.bygg!, adresse: form.adresse!, maalenummer: form.maalenummer!,
        maalepunkt_id: form.maalepunkt_id!, netteier: form.netteier!, prisomrade: form.prisomrade!,
        aarsforbruk_kwh: Number(form.aarsforbruk_kwh), avtalt_oppstart: form.avtalt_oppstart!,
        at_kode: form.at_kode!, rute: form.rute as Rute,
        paslag_ore_kwh: form.rute === "B" ? Number(form.paslag_ore_kwh) : null,
        fast_pr_maaler: form.fast_pr_maaler != null && form.fast_pr_maaler !== ("" as any) ? Number(form.fast_pr_maaler) : null,
        fast_aarspris: form.rute === "A" ? Number(form.fast_aarspris) : null,
        signert: !!form.signert, kommentar: form.kommentar ?? "",
      };
      if (editingId) {
        await updateMalepunktDetails(editingId, payload);
        await updateCustomerSeller(payload.org_nr, payload.selger);
      } else {
        await insertMalepunkt(payload);
        if (payload.selger) await updateCustomerSeller(payload.org_nr, payload.selger);
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
    if (!window.confirm(`Sette ${ids.length} valgte målepunkt som «Klar for bestilling»?`)) return;
    try {
      await updateStatuses(ids, "Klar for bestilling", "Innmeldt");
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      await refresh();
      flash(`${ids.length} målepunkt satt som klare for bestilling`);
    } catch (e: any) { flash("Feil: " + (e.message ?? e)); }
  }
  function copyBatch() {
    const header = ENTELIOS_COLUMNS.map((c) => c.label).join("\t");
    const lines = batchRows.map((r) => ENTELIOS_COLUMNS.map((c) => String((r as any)[c.key] ?? "")).join("\t"));
    const tsv = [header, ...lines].join("\n");
    navigator.clipboard?.writeText(tsv).then(() => flash("Bestilling kopiert (lim inn i regneark/mail)"), () => flash("Kunne ikke kopiere"));
  }

  function downloadWorklist() {
    const columns: { label: string; value: (r: Malepunkt) => string }[] = [
      { label: "Kunde", value: (r) => r.kunde },
      { label: "Selger", value: (r) => r.selger || "" },
      { label: "Bygg", value: (r) => r.bygg },
      { label: "Adresse", value: (r) => r.adresse },
      { label: "MålepunktID", value: (r) => r.maalepunkt_id },
      { label: "Referansekode", value: (r) => r.at_kode || "" },
      { label: "Rute", value: (r) => r.rute },
      { label: "Status", value: (r) => displayStatus(r.status) },
      { label: "Neste handling", value: (r) => nextStatus(r.status) ? displayStatus(nextStatus(r.status)!) : "Ferdig" },
      { label: "Oppstart", value: (r) => r.avtalt_oppstart || "" },
      { label: "Netteier", value: (r) => r.netteier },
      { label: "Årsforbruk (kWh)", value: (r) => String(r.aarsforbruk_kwh ?? "") },
      { label: "Kommentar", value: (r) => r.kommentar || "" },
    ];
    const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = [columns.map((c) => quote(c.label)).join(";"), ...filtered.map((r) => columns.map((c) => quote(c.value(r))).join(";"))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stromflyt-arbeidsliste-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    flash(`${filtered.length} rader lastet ned`);
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

  return (
    <div className="sf-root">
      <style>{CSS}</style>

      <header className="bar">
        <div className="brand">
          <span className="spark" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="currentColor" /></svg>
          </span>
          <div>Strømflyt<small>Adaptic · innmelding og register</small></div>
        </div>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "reg"} onClick={() => setTab("reg")}>Register</button>
          <button role="tab" aria-selected={tab === "form"} onClick={newManualEntry}>Ny registrering</button>
          <button role="tab" aria-selected={tab === "import"} onClick={() => setTab("import")}>Last opp avtale</button>
          <button role="tab" aria-selected={tab === "excel"} onClick={() => setTab("excel")}>Importer Excel</button>
        </nav>
        <div className="right">
          {requireAuth && <span className="user-email">{userEmail}</span>}
          <button className="btn sm" onClick={refresh}>Oppdater</button>
          {requireAuth && <button className="btn sm" onClick={() => { setPasswordContext("account"); setNewPassword(""); setConfirmPassword(""); setPasswordError(""); setNeedsPassword(true); }}>Sett passord</button>}
          {requireAuth && <button className="btn sm" onClick={signOut}>Logg ut</button>}
        </div>
      </header>

      <main>
        {err && <div className="banner">Kunne ikke laste registeret: {err}</div>}

        {tab === "reg" && (
          <section>
            <div className="tiles">
              <Tile k="Målepunkt totalt" v={String(tiles.total)} />
              <Tile k="Rute A / B" v={`${tiles.a} / ${tiles.b}`} sub="leietaker / strømsalg" />
              <Tile k="Fast årspris (ARR)" v={`${fmt(tiles.arr)} kr`} sub="rute A samlet" />
              <Tile k="Trenger handling" v={String(tiles.trenger)} sub="registrert + klar" alert={tiles.trenger > 0} />
            </div>

            <div className="panel">
              <div className="hd"><h2>Statuslinje</h2><span className="sub">antall målepunkt per steg</span></div>
              <div className="pipe">
                {STAGES.map((st) => (
                  <div className="pstage" key={st}>
                    <div className="pc num">{rows.filter((r) => r.status === st).length}</div>
                    <div className="pl">{displayStatus(st)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="work-queues" aria-label="Arbeidslister">
              {WORK_FILTERS.map((f) => {
                const count = f.statuses.length ? rows.filter((r) => f.statuses.includes(r.status)).length : rows.length;
                return <button key={f.key || "all"} className={workFilter === f.key ? "active" : ""} onClick={() => { setWorkFilter(f.key); setFltStatus(""); }}>
                  <span>{f.label}</span><b className="num">{count}</b>
                </button>;
              })}
            </div>

            <div className="toolbar">
              <strong style={{ fontSize: 15 }}>Arbeidsliste <span className="muted">({filtered.length})</span></strong>
              <input className="work-search" type="search" placeholder="Søk kunde, bygg, adresse, MålepunktID …" value={search} onChange={(e) => setSearch(e.target.value)} />
              <label className="flt">Rute
                <select value={fltRute} onChange={(e) => setFltRute(e.target.value)}>
                  <option value="">alle</option><option value="A">A · leietaker</option><option value="B">B · strømsalg</option>
                </select>
              </label>
              <label className="flt">Status
                <select value={fltStatus} onChange={(e) => { setFltStatus(e.target.value); setWorkFilter(""); }}>
                  <option value="">alle</option>
                  {STAGES.map((s) => <option key={s} value={s}>{displayStatus(s)}</option>)}
                </select>
              </label>
              <label className="flt">Sorter
                <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                  <option value="arbeidsrekkefolge">arbeidsrekkefølge</option>
                  <option value="oppstart">oppstartsdato</option>
                  <option value="kunde">kunde A–Å</option>
                  <option value="status">status</option>
                  <option value="nyeste">nyeste først</option>
                </select>
              </label>
              <button className="btn" disabled={!filtered.length} onClick={downloadWorklist}>Last ned arbeidsliste</button>
              <button className="btn primary" onClick={() => setBatchOpen(true)}>Lag Entelios-batch</button>
            </div>

            {selectedRowsForBulk.length > 0 && <div className="bulk-bar">
              <b>{selectedRowsForBulk.length} valgt</b>
              <span>{selectedRegisteredIds.length} kan settes som klare for bestilling</span>
              <span className="grow" />
              <button className="btn sm" onClick={() => setSelectedIds([])}>Fjern valg</button>
              <button className="btn sm primary" disabled={!selectedRegisteredIds.length} onClick={markSelectedReady}>
                Sett {selectedRegisteredIds.length || "valgte"} som klar
              </button>
            </div>}

            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th className="select-cell"><input type="checkbox" aria-label="Velg alle synlige" checked={allVisibleSelected} onChange={(e) => toggleAllVisible(e.target.checked)} /></th>
                  <th>Kunde</th><th>Selger</th><th>Bygg</th><th>MålepunktID</th><th>Netteier</th><th>Prisomr.</th>
                  <th className="num">Årsforbruk</th><th>Rute</th><th>Kommersielt</th><th>Status</th><th>Handling</th>
                </tr></thead>
                <tbody>
                  {loading && <tr><td colSpan={12}><div className="empty">Laster …</div></td></tr>}
                  {!loading && filtered.length === 0 && <tr><td colSpan={12}><div className="empty">Ingen målepunkt matcher filteret.</div></td></tr>}
                  {!loading && filtered.map((r) => {
                    const next = nextStatus(r.status);
                    const previous = previousStatus(r.status);
                    return (
                      <tr key={r.id}>
                        <td className="select-cell"><input type="checkbox" aria-label={`Velg ${r.bygg}`} checked={selectedIds.includes(r.id)} onChange={(e) => toggleSelected(r.id, e.target.checked)} /></td>
                        <td>{r.kunde}</td>
                        <td>{r.selger || <span className="muted">Ikke satt</span>}</td>
                        <td>{r.bygg}<div className="muted">{r.adresse}</div></td>
                        <td className="num">{r.maalepunkt_id}</td>
                        <td>{r.netteier}</td>
                        <td>{r.prisomrade}</td>
                        <td className="num">{fmt(r.aarsforbruk_kwh)}</td>
                        <td><span className={"rute " + r.rute}>{r.rute}</span></td>
                        <td>{kommersielt(r)}</td>
                        <td><span className={"pill " + STATUS_CLASS[r.status]}>{displayStatus(r.status)}</span></td>
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
              <div>
                <h2>Last opp signert avtale</h2>
                <p><b>Dra PDF-avtalen hit</b>, eller velg den fra filer. Systemet leser kunde, org.nr, vilkår, oppstart og alle målepunkt. Du kontrollerer funnene før de lagres.</p>
              </div>
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
                    <Summary k="Rute" v={parsed.rute === "B" ? "B · strømsalg" : parsed.rute === "A" ? "A · leietaker" : "Ikke funnet"} />
                    <Summary k="Vilkår" v={parsed.rute === "B" ? `${parsed.paslag_ore_kwh ?? "?"} øre/kWh${parsed.fast_pr_maaler != null ? ` + ${fmt(parsed.fast_pr_maaler)} kr/måler/mnd` : ""}` : `${fmt(parsed.fast_aarspris)} kr/år`} />
                    <Summary k="Oppstart" v={parsed.avtalt_oppstart || "Ikke funnet"} mono />
                    <Summary k="Signatur" v={parsed.avtale_signert ? "Fullført i PandaDoc" : "Ikke bekreftet"} good={parsed.avtale_signert} bad={!parsed.avtale_signert} />
                  </div>
                  <div className="import-org">
                    <label>Organisasjon i Adaptic Cloud</label>
                    <input list="cloud-org-list" value={importCloudOrg} onChange={(e) => setImportCloudOrg(e.target.value)} />
                    <datalist id="cloud-org-list">{CLOUD_ORGS.map((o) => <option key={o} value={o} />)}</datalist>
                    <span>{parsed.rute === "B" ? "Rene strømsalg legges normalt i Strømkunder." : "Kontroller hvilken kundeorganisasjon bygget tilhører."}</span>
                  </div>
                  <div className="import-org">
                    <label>Selger for kunden</label>
                    <input value={importSeller} onChange={(e) => setImportSeller(e.target.value)} placeholder="Navn på ansvarlig selger" />
                    <span>Lagres på kunden og brukes på alle målepunktene i denne avtalen.</span>
                  </div>
                  {parsed.note && <div className="banner" style={{ margin: "0 18px 18px" }}>{parsed.note}</div>}
                  {!parsed.avtale_signert && <div className="banner" style={{ margin: "0 18px 18px" }}>Avtalen ser ikke ferdig signert ut. Du kan kontrollere funnene, men ikke lagre dem ennå.</div>}
                </div>

                <div className="toolbar">
                  <strong>{parsed.rows.length} målepunkt funnet</strong>
                  <span className="muted">Gyldige, nye rader er valgt automatisk. TBA og dubletter holdes utenfor.</span>
                  <span className="grow" />
                  <button className="btn primary" disabled={importing || !parsed.avtale_signert || !Object.values(selectedRows).some(Boolean)} onClick={importParsedRows}>
                    {importing ? "Legger inn …" : `Legg ${Object.values(selectedRows).filter(Boolean).length} i registeret`}
                  </button>
                </div>

                <div className="tablewrap">
                  <table>
                    <thead><tr><th /><th>Adresse / bygg</th><th>Målenummer</th><th>MålepunktID</th><th>Netteier</th><th>Prisomr.</th><th className="num">Årsforbruk</th><th>AT-kode</th><th>Kontroll</th></tr></thead>
                    <tbody>{parsed.rows.map((r, i) => {
                      const duplicate = rows.some((existing) => existing.maalepunkt_id === r.maalepunkt_id);
                      const blocked = !r.gyldig || duplicate;
                      return <tr key={`${r.maalepunkt_id}-${i}`}>
                        <td><input type="checkbox" checked={!!selectedRows[i]} disabled={blocked} onChange={(e) => setSelectedRows((s) => ({ ...s, [i]: e.target.checked }))} /></td>
                        <td>{r.adresse}</td><td className="num">{r.maalenummer}</td><td className="num">{r.maalepunkt_id}</td><td>{r.netteier}</td><td>{r.prisomrade}</td><td className="num">{fmt(r.aarsforbruk_kwh)}</td>
                        <td><input className="num compact-input" placeholder="kan fylles senere" value={rowAtCodes[i] || ""} disabled={blocked} onChange={(e) => setRowAtCodes((s) => ({ ...s, [i]: e.target.value }))} /></td>
                        <td>{duplicate ? <span className="pill s-kladd">Finnes allerede</span> : r.gyldig ? <span className="pill s-aktiv">Klar</span> : <span className="pill" style={{ color: "var(--sf-crit)", background: "var(--sf-crit-soft)" }}>{r.problem || "Mangler data"}</span>}</td>
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
              <div>
                <h2>Importer målerliste fra Excel</h2>
                <p><b>Dra Excel-filen hit</b>, eller velg den fra filer. Systemet finner faner og kolonner automatisk, kontrollerer radene og foreslår status ut fra om fanen er «Bestilt».</p>
              </div>
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
                      <thead><tr><th>Referanse / kunde</th><th>Org.nr</th><th>Selger</th><th>Cloud-org</th><th>Rute</th><th>Kommersielt</th><th>Signert</th><th>Kontroll</th></tr></thead>
                      <tbody>{excelGroupKeys.map((key) => {
                        const m = excelMappings[key];
                        if (!m) return null;
                        return <tr key={key}>
                          <td><div className="muted num">{key}</div><input value={m.kunde} onChange={(e) => setExcelMapping(key, { kunde: e.target.value })} /></td>
                          <td><input className="num compact-input" maxLength={9} placeholder="9 siffer" value={m.org_nr} onChange={(e) => setExcelMapping(key, { org_nr: e.target.value.replace(/\D/g, "") })} /></td>
                          <td><input className="compact-input" placeholder="ansvarlig selger" value={m.selger} onChange={(e) => setExcelMapping(key, { selger: e.target.value })} /></td>
                          <td><input list="excel-cloud-orgs" value={m.cloud_org} onChange={(e) => setExcelMapping(key, { cloud_org: e.target.value })} /><datalist id="excel-cloud-orgs">{CLOUD_ORGS.map((o) => <option key={o} value={o} />)}</datalist></td>
                          <td><select value={m.rute} onChange={(e) => setExcelMapping(key, { rute: e.target.value as Rute | "", cloud_org: e.target.value === "B" && !m.cloud_org ? "Strømkunder" : m.cloud_org })}><option value="">velg</option><option value="A">A · leietaker</option><option value="B">B · strømsalg</option></select></td>
                          <td>{m.rute === "A" ? <input className="num compact-input" placeholder="årspris kr" value={m.fast_aarspris} onChange={(e) => setExcelMapping(key, { fast_aarspris: e.target.value })} /> : <input className="num compact-input" placeholder="påslag øre/kWh" value={m.paslag_ore_kwh} onChange={(e) => setExcelMapping(key, { paslag_ore_kwh: e.target.value })} />}</td>
                          <td><label className="checkline"><input type="checkbox" checked={m.signert} onChange={(e) => setExcelMapping(key, { signert: e.target.checked })} /> Ja</label></td>
                          <td>{excelMappingValid(m) ? <span className="pill s-aktiv">Klar</span> : <span className="pill s-klar">Mangler felt</span>}</td>
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
                      const blocked = !r.gyldig || duplicate;
                      return <tr key={r.source_row}>
                        <td><input type="checkbox" checked={!!excelSelected[r.source_row]} disabled={blocked} onChange={(e) => setExcelSelected((s) => ({ ...s, [r.source_row]: e.target.checked }))} /></td>
                        <td className="num">{r.source_row}</td><td className="num">{r.referansekode || "-"}</td><td>{r.selskapsnavn || r.kunde_hint || r.bygg || "-"}</td><td>{r.adresse}</td><td className="num">{r.maalenummer || "-"}</td><td className="num">{r.maalepunkt_id || "-"}</td><td>{r.prisomrade || "-"}</td><td>{r.netteier || "-"}</td><td className="num">{fmt(r.aarsforbruk_kwh)}</td><td className="num">{r.oppstartdato || "-"}</td><td><span className={"pill " + (r.status_suggestion === "Sendt Entelios" ? "s-sendt" : "s-innmeldt")}>{displayStatus(r.status_suggestion)}</span></td>
                        <td>{duplicate ? <span className="pill s-kladd">Finnes allerede</span> : !r.gyldig ? <span className="pill" title={r.problemer.join(", ")} style={{ color: "var(--sf-crit)", background: "var(--sf-crit-soft)" }}>{r.problemer[0]}</span> : mappingOk ? <span className="pill s-aktiv">Klar</span> : <span className="pill s-klar">Avtaleinfo mangler</span>}</td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>
            )}
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
              <Field label="Organisasjon i Adaptic Cloud" req err={errFor("cloud_org")} hint="Hentes fra Cloud så navnet matcher eksakt.">
                <select value={form.cloud_org ?? ""} onChange={(e) => set("cloud_org", e.target.value)}>
                  <option value="">velg org</option>
                  {CLOUD_ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
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
              <legend>Rute og kommersielt</legend>
              <div className="radio-row">
                {(["B", "A"] as Rute[]).map((rt) => (
                  <label key={rt} className="radio-card" data-on={form.rute === rt} onClick={() => set("rute", rt)}>
                    <input type="radio" name="rute" checked={form.rute === rt} readOnly />
                    <b>{rt === "B" ? "Rute B · rent strømsalg" : "Rute A · leietakerfakturering"}</b>
                    <span>{rt === "B" ? "Kunden er sluttbruker. Påslag øre/kWh." : "Adaptic fakturerer kundens leietakere. Fast årspris (ARR)."}</span>
                  </label>
                ))}
              </div>
              {errFor("rute") && <div className="err" style={{ marginTop: 8 }}>{errFor("rute")}</div>}
              <div className="grid2" style={{ marginTop: 14 }}>
                {form.rute === "B" && (
                  <Field label="Påslag (øre/kWh)" req err={errFor("paslag_ore_kwh")}>
                    <input className="num" inputMode="decimal" value={form.paslag_ore_kwh ?? ""} onChange={(e) => set("paslag_ore_kwh", (e.target.value === "" ? null : Number(e.target.value)) as any)} />
                  </Field>
                )}
                {form.rute === "B" && (
                  <Field label="Fast pr. måler / mnd (valgfritt)">
                    <input className="num" inputMode="numeric" value={form.fast_pr_maaler ?? ""} onChange={(e) => set("fast_pr_maaler", (e.target.value === "" ? null : Number(e.target.value)) as any)} />
                  </Field>
                )}
                {form.rute === "A" && (
                  <Field label="Fast årspris leietakerfakturering (kr)" req err={errFor("fast_aarspris")}>
                    <input className="num" inputMode="numeric" value={form.fast_aarspris ?? ""} onChange={(e) => set("fast_aarspris", (e.target.value === "" ? null : Number(e.target.value)) as any)} />
                  </Field>
                )}
              </div>
            </fieldset>

            <fieldset className="wide">
              <legend>Avtale</legend>
              <div className="grid2">
                <Field label="AT-kode" req err={errFor("at_kode")}><input className="num" placeholder="f.eks. AT40001.001" value={form.at_kode ?? ""} onChange={(e) => set("at_kode", e.target.value)} /></Field>
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

      {batchOpen && (
        <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) setBatchOpen(false); }}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="hd">
              <h2>Entelios-bestilling</h2>
              <span className="sub" style={{ color: "var(--sf-ink-3)", fontSize: 13 }}>{batchRows.length} målepunkt klare</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" disabled={!batchRows.length} onClick={copyBatch}>Kopier</button>
              <button className="btn sm" disabled={!batchRows.length} onClick={sendBatch}>Marker som sendt</button>
              <button className="icon-btn" aria-label="Lukk" onClick={() => setBatchOpen(false)}>✕</button>
            </div>
            <div className="bd">
              {batchRows.length === 0 ? (
                <div className="empty">Ingen målepunkt har status «Klar for bestilling». Sett en internt registrert post videre først.</div>
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

      <div className={"toast" + (toast ? " show" : "")}>{toast}</div>
    </div>
  );
}

function Tile({ k, v, sub, alert }: { k: string; v: string; sub?: string; alert?: boolean }) {
  return (
    <div className={"tile" + (alert ? " alert" : "")}>
      <div className="k">{k}</div>
      <div className="v">{v}{sub ? <small> {sub}</small> : null}</div>
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
.sf-root{--sf-ground:#f7f8fa;--sf-surface:#fff;--sf-surface-2:#f0f2f6;--sf-border:#e2e7ee;--sf-border-strong:#cbd3df;--sf-ink:#1a2230;--sf-ink-2:#55617a;--sf-ink-3:#8a94a8;--sf-accent:#2d5be3;--sf-accent-ink:#fff;--sf-accent-soft:#e7edfd;--sf-good:#1f9d6b;--sf-good-soft:#e2f4ec;--sf-warn:#b9770f;--sf-warn-soft:#f8efdc;--sf-crit:#d14343;--sf-crit-soft:#fbe6e6;--sf-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sf-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:var(--sf-ground);color:var(--sf-ink);font-family:var(--sf-sans);width:100%;max-width:100vw;min-height:100vh;overflow-x:hidden;font-size:15px;line-height:1.5}
@media (prefers-color-scheme:dark){.sf-root{--sf-ground:#0e1420;--sf-surface:#161e2c;--sf-surface-2:#1d2736;--sf-border:#273143;--sf-border-strong:#37455c;--sf-ink:#e7ecf3;--sf-ink-2:#a2adc0;--sf-ink-3:#6f7c93;--sf-accent:#5b85f5;--sf-accent-ink:#0b1220;--sf-accent-soft:#1c2a45;--sf-good:#47c08c;--sf-good-soft:#14312a;--sf-warn:#e0a949;--sf-warn-soft:#322817;--sf-crit:#ef6b6b;--sf-crit-soft:#35201f}}
.sf-root *{box-sizing:border-box}
.sf-root .num{font-variant-numeric:tabular-nums;font-family:var(--sf-mono)}
.sf-root h1,.sf-root h2{margin:0;text-wrap:balance}
.bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:12px 22px;background:var(--sf-surface);border-bottom:1px solid var(--sf-border)}
.brand{display:flex;align-items:center;gap:10px;font-weight:640}
.brand small{display:block;font-weight:480;color:var(--sf-ink-3);font-size:11.5px;letter-spacing:.04em;text-transform:uppercase}
.spark{width:26px;height:26px;border-radius:7px;background:var(--sf-accent);display:grid;place-items:center;color:var(--sf-accent-ink);flex:none}
.tabs{display:flex;gap:4px;margin-left:8px}
.tabs button{font:inherit;font-size:14px;font-weight:550;color:var(--sf-ink-2);background:transparent;border:1px solid transparent;padding:7px 14px;border-radius:8px;cursor:pointer}
.tabs button:hover{color:var(--sf-ink);background:var(--sf-surface-2)}
.tabs button[aria-selected=true]{color:var(--sf-accent);background:var(--sf-accent-soft)}
.bar .right{margin-left:auto;display:flex;gap:8px;align-items:center}
.user-email{font-size:12px;color:var(--sf-ink-3);max-width:220px;overflow:hidden;text-overflow:ellipsis}
main{width:100%;max-width:none;margin:0;padding:26px clamp(16px,2vw,40px) 80px}
.auth-root{display:grid;place-items:center;padding:24px}.login-card{width:min(430px,100%);background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:14px;padding:28px;box-shadow:0 18px 60px rgba(15,25,45,.1);display:flex;flex-direction:column;gap:14px}.login-card h1{font-size:23px}.login-card p{color:var(--sf-ink-2);margin:4px 0 0}.login-card .field{margin-top:0}.login-card .banner{margin:0}
.banner{background:var(--sf-crit-soft);color:var(--sf-crit);border:1px solid var(--sf-crit);border-radius:10px;padding:12px 16px;margin-bottom:18px;font-size:14px}
.import-page{width:100%;max-width:none}
.upload-card{display:flex;align-items:center;justify-content:space-between;gap:24px;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:12px;padding:22px 24px;margin-bottom:20px}
.upload-card h2{font-size:19px}.upload-card p{margin:5px 0 0;color:var(--sf-ink-2);max-width:720px}
.drop-zone{transition:border-color .15s,background .15s,box-shadow .15s}.drop-zone.dragging{border:2px dashed var(--sf-accent);background:var(--sf-accent-soft);box-shadow:0 0 0 4px color-mix(in srgb,var(--sf-accent) 12%,transparent)}
.upload-btn{display:inline-flex;align-items:center;justify-content:center;background:var(--sf-accent);color:var(--sf-accent-ink);padding:10px 16px;border-radius:8px;font-weight:620;cursor:pointer;white-space:nowrap}.upload-btn input{position:absolute;opacity:0;pointer-events:none}.upload-btn:has(input:disabled){opacity:.55;cursor:not-allowed}
.import-summary{overflow:hidden}.summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--sf-border);border-bottom:1px solid var(--sf-border)}
.summary-item{background:var(--sf-surface);padding:14px 18px}.summary-item span{display:block;color:var(--sf-ink-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}.summary-item b{display:block;margin-top:3px;font-size:15px}
.import-org{display:grid;grid-template-columns:220px minmax(260px,420px) 1fr;align-items:center;gap:12px;padding:16px 18px}.import-org label{font-size:13px;font-weight:620}.import-org span{font-size:12px;color:var(--sf-ink-3)}
.excel-sheet-picker{display:grid;grid-template-columns:80px minmax(280px,480px) 1fr;align-items:center;gap:12px;padding:16px 18px}.excel-sheet-picker label{font-size:13px;font-weight:620}.excel-sheet-picker span{font-size:12px;color:var(--sf-ink-3)}
.mapping-table{border:0;border-radius:0}.mapping-table td{vertical-align:middle}.mapping-table input,.mapping-table select{max-width:220px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.tile{background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:10px;padding:14px 16px}
.tile .k{font-size:12px;color:var(--sf-ink-3);letter-spacing:.03em;text-transform:uppercase}
.tile .v{font-size:27px;font-weight:680;letter-spacing:-.02em;margin-top:3px}
.tile .v small{font-size:14px;font-weight:500;color:var(--sf-ink-3)}
.tile.alert .v{color:var(--sf-warn)}
.panel{background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:10px;margin-bottom:20px}
.panel>.hd{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--sf-border)}
.panel>.hd h2{font-size:15px;font-weight:620}
.panel>.hd .sub{color:var(--sf-ink-3);font-size:13px}
.pipe{display:flex;gap:6px;padding:16px 18px;overflow-x:auto}
.pstage{flex:1 0 120px;min-width:120px;border:1px solid var(--sf-border);border-radius:8px;padding:10px 12px;background:var(--sf-surface-2);position:relative}
.pstage .pc{font-size:22px;font-weight:680;letter-spacing:-.02em}
.pstage .pl{font-size:12px;color:var(--sf-ink-2);margin-top:2px}
.pstage::after{content:"›";position:absolute;right:-8px;top:50%;transform:translateY(-50%);color:var(--sf-ink-3);font-size:18px;z-index:2}
.pstage:last-child::after{display:none}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px}
.toolbar .grow{flex:1}
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
.rute{font-family:var(--sf-mono);font-weight:640;font-size:12px;padding:2px 7px;border-radius:6px}
.rute.A{color:var(--sf-accent);background:var(--sf-accent-soft)}
.rute.B{color:var(--sf-good);background:var(--sf-good-soft)}
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
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--sf-ink);color:var(--sf-ground);padding:10px 18px;border-radius:999px;font-size:14px;font-weight:550;opacity:0;transition:opacity .2s,transform .2s;z-index:60;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media (max-width:780px){.tiles{grid-template-columns:repeat(2,1fr)}.intake{grid-template-columns:1fr}.sf-root fieldset{grid-column:1/-1}.upload-card{align-items:flex-start;flex-direction:column}.summary-grid{grid-template-columns:1fr 1fr}.import-org,.excel-sheet-picker{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.toast{transition:none}}
`;

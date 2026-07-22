// Dataaksess mot Supabase-tabellen strombestillinger.

import { supabase } from "./supabaseClient";
import type { Malepunkt, Status } from "./stromflyt-config";

const TABLE = "strombestillinger";

export async function listMalepunkt(): Promise<Malepunkt[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Malepunkt[];
}

// Innmelding: alt nytt starter på status "Innmeldt".
export async function insertMalepunkt(
  m: Omit<Malepunkt, "id" | "status" | "entelios_ref" | "created_at" | "updated_at">
): Promise<Malepunkt> {
  return insertMalepunktWithStatus(m, "Innmeldt");
}

export async function insertMalepunktWithStatus(
  m: Omit<Malepunkt, "id" | "status" | "entelios_ref" | "created_at" | "updated_at">,
  status: Status,
): Promise<Malepunkt> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert([{ ...m, status, entelios_ref: "" }])
    .select()
    .single();
  if (error) {
    // Vennligere melding for den vanligste feilen: duplikat målepunkt.
    if (error.code === "23505")
      throw new Error("Dette målepunktet ligger allerede i registeret.");
    throw error;
  }
  return data as Malepunkt;
}

export async function updateStatus(
  id: string,
  status: Status,
  extra: Partial<Malepunkt> = {}
): Promise<void> {
  const { error } = await supabase.from(TABLE).update({ status, ...extra }).eq("id", id);
  if (error) throw error;
}

export async function updateStatuses(ids: string[], status: Status, onlyFrom?: Status): Promise<void> {
  if (!ids.length) return;
  let query = supabase
    .from(TABLE)
    .update({ status })
    .in("id", ids);
  if (onlyFrom) query = query.eq("status", onlyFrom);
  const { error } = await query;
  if (error) throw error;
}

export async function updateMalepunktDetails(
  id: string,
  patch: Partial<Omit<Malepunkt, "id" | "created_at" | "updated_at">>,
): Promise<void> {
  const { error } = await supabase.from(TABLE).update(patch).eq("id", id);
  if (error) {
    if (error.code === "23505") throw new Error("Dette målepunktet ligger allerede i registeret.");
    throw error;
  }
}

// Selger tilhører kunden, ikke det enkelte målepunktet. Oppdater derfor
// alle poster med samme organisasjonsnummer samtidig.
export async function updateCustomerSeller(orgNr: string, selger: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ selger: selger.trim() })
    .eq("org_nr", orgNr);
  if (error) throw error;
}

export interface HistoryEvent {
  id: string;
  action: "opprettet" | "endret" | "slettet";
  from_status: string | null;
  to_status: string | null;
  changed_fields: string[];
  actor_email: string | null;
  created_at: string;
}

export async function listHistory(strombestillingId: string): Promise<HistoryEvent[]> {
  const { data, error } = await supabase
    .from("strombestilling_hendelser")
    .select("id,action,from_status,to_status,changed_fields,actor_email,created_at")
    .eq("strombestilling_id", strombestillingId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as HistoryEvent[];
}

// Feilopprettede poster kan slettes før de er sendt til Entelios.
// Etter innsending skal posten beholdes som historikk.
export async function deleteMalepunkt(id: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .in("status", ["Kladd", "Innmeldt", "Klar for bestilling"]);
  if (error) throw error;
}

// Send batch: alle "Klar for bestilling" -> "Sendt Entelios".
export async function markBatchSent(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase
    .from(TABLE)
    .update({ status: "Sendt Entelios" })
    .in("id", ids);
  if (error) throw error;
}

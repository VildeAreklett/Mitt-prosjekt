import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.NEXT_PUBLIC_STROMFLYT_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_STROMFLYT_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export type ApiAuthResult =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 500; error: string };

export async function requireStromflytAccess(req: Request): Promise<ApiAuthResult> {
  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, status: 500, error: "Mangler Supabase-oppsett" };
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return { ok: false, status: 401, error: "Du må være logget inn" };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const email = userData.user?.email?.trim().toLowerCase();
  if (userError || !email) {
    return { ok: false, status: 401, error: "Ugyldig innlogging" };
  }

  const { data, error } = await supabase
    .from("stromflyt_tilganger")
    .select("email")
    .eq("email", email)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 500, error: "Kunne ikke kontrollere tilgang" };
  }
  if (!data) {
    return { ok: false, status: 403, error: "Du har ikke tilgang til Strømflyt" };
  }

  return { ok: true, email };
}

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient as createSbClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // called from a Server Component — middleware refreshes the session
        }
      },
    },
  });
}

/** ワーカー用: 専用アカウントでサインインしたクライアント（RLS は通常どおり効く） */
export async function createWorkerClient() {
  const email = process.env.WORKER_EMAIL;
  const password = process.env.WORKER_PASSWORD;
  if (!email || !password) return null;
  const sb = createSbClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return null;
  return sb;
}

export type Profile = {
  id: string;
  tenant_id: string;
  full_name: string;
  role: string;
  sender_name: string;
  signature: string;
};

export async function getSessionProfile() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { sb, user: null, profile: null as Profile | null };
  const { data: profile } = await sb
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  return { sb, user, profile: (profile ?? null) as Profile | null };
}

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The one Supabase client. Created lazily so the auth service can read the
 * page URL (recovery and error links) before the client consumes it.
 *
 * Configuration comes only from VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
 */
const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

export type ConfigProblem = 'missing' | 'secret-key';

/** Refuses a service-role / secret key outright: it would bypass row level security for anyone. */
function keyProblem(key: string): ConfigProblem | undefined {
  if (!key) return 'missing';
  if (key.startsWith('sb_secret_')) return 'secret-key';
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
      if (payload.role === 'service_role') return 'secret-key';
    } catch {
      /* not a JWT-style key; the newer publishable keys are opaque */
    }
  }
  return undefined;
}

/** The ORCID button is only offered once the provider has been configured in Supabase. */
export const orcidEnabled = import.meta.env.VITE_ORCID_ENABLED === 'true';

/** Supabase Auth custom OIDC provider identifier for ORCID. */
export const ORCID_PROVIDER = 'custom:orcid';

export const configProblem: ConfigProblem | undefined = !url ? 'missing' : keyProblem(anonKey);

let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (configProblem) throw new Error(`Supabase is not configured (${configProblem})`);
  client ??= createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Implicit flow: confirmation and reset links work even when opened on
      // another device or browser than the one that asked for them.
      flowType: 'implicit',
    },
  });
  return client;
}

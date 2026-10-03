/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://abcd.supabase.co */
  readonly VITE_SUPABASE_URL?: string;
  /** Public anon / publishable key. Never the service-role key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** "true" once the ORCID provider is configured in Supabase (see scripts/setup-orcid-provider.mjs). */
  readonly VITE_ORCID_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

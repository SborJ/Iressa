#!/usr/bin/env node
/**
 * Registers (or updates) ORCID as a sign-in provider in Supabase Auth.
 *
 * Run once, on your own machine, after creating ORCID API credentials at
 * https://orcid.org/developer-tools with this redirect URI:
 *
 *   https://<project-ref>.supabase.co/auth/v1/callback
 *
 * Usage (values from the environment, never from the repo):
 *
 *   SUPABASE_URL=https://<project-ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   ORCID_CLIENT_ID=APP-... ORCID_CLIENT_SECRET=... \
 *   [ORCID_ENV=sandbox] \
 *   node scripts/setup-orcid-provider.mjs
 *
 * The service-role key is used here, server-side, and nowhere else. Then set
 * VITE_ORCID_ENABLED=true for the web app.
 */
import { createClient } from '@supabase/supabase-js';

const IDENTIFIER = 'custom:orcid';
const env = (k) => process.env[k]?.trim() ?? '';
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ORCID_CLIENT_ID', 'ORCID_CLIENT_SECRET'].filter((k) => !env(k));
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}. See the comment at the top of this file.`);
  process.exit(1);
}
if (!/^APP-[A-Z0-9]{16}$/.test(env('ORCID_CLIENT_ID'))) {
  console.error('ORCID_CLIENT_ID should look like APP-XXXXXXXXXXXXXXXX (from orcid.org/developer-tools).');
  process.exit(1);
}

const issuer = env('ORCID_ENV') === 'sandbox' ? 'https://sandbox.orcid.org' : 'https://orcid.org';
const settings = {
  name: 'ORCID',
  client_id: env('ORCID_CLIENT_ID'),
  client_secret: env('ORCID_CLIENT_SECRET'),
  issuer,
  discovery_url: `${issuer}/.well-known/openid-configuration`,
  // ORCID authenticates the person and returns their iD and name; it never shares an email.
  scopes: ['openid'],
  email_optional: true,
  enabled: true,
};

const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin.customProviders;

const existing = await admin.getProvider(IDENTIFIER);
const { data, error } = existing.data
  ? await admin.updateProvider(IDENTIFIER, settings)
  : await admin.createProvider({ provider_type: 'oidc', identifier: IDENTIFIER, ...settings });

if (error) {
  console.error(`Supabase rejected the provider: ${error.message}`);
  process.exit(1);
}
console.log(`${existing.data ? 'Updated' : 'Created'} ${data.identifier} (${data.name}) -> ${data.issuer ?? issuer}, enabled=${data.enabled}`);
console.log(`ORCID redirect URI to register: ${env('SUPABASE_URL').replace(/\/$/, '')}/auth/v1/callback`);
console.log('Next: set VITE_ORCID_ENABLED=true in .env.local and restart the dev server.');

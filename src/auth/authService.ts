import {
  isAuthError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
  type AuthChangeEvent,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import type { AuthChange, AuthIntent, AuthResult, AuthUser, SignUpOutcome } from './authTypes.js';
import { configProblem, getSupabase, ORCID_PROVIDER, orcidEnabled, type ConfigProblem } from './supabase.js';

/**
 * Everything the app knows about authentication goes through here; no other
 * module talks to Supabase auth. Results carry user-facing text only: raw
 * backend messages, passwords and tokens are never surfaced or logged.
 */

/** URL parameters this module owns. Everything else (e.g. ?source=…) is left alone. */
const AUTH_QUERY_KEYS = ['auth', 'error', 'error_code', 'error_description'];
const AUTH_HASH_KEYS = ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type',
  'provider_token', 'provider_refresh_token', 'error', 'error_code', 'error_description'];

/**
 * Read once at load, before the Supabase client consumes the URL: did the
 * visitor come back from a password-reset email, or from a broken link?
 */
function readIntent(): AuthIntent {
  const url = new URL(window.location.href);
  const q = url.searchParams;
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const auth = q.get('auth');
  const errorCode = q.get('error_code') ?? hash.get('error_code');
  const hasError = Boolean(errorCode || q.get('error') || hash.get('error'));
  const wantsRecovery = auth === 'recovery' || hash.get('type') === 'recovery';
  const orcid = auth === 'orcid';

  let linkError: string | undefined;
  if (hasError && orcid) {
    const error = q.get('error') ?? hash.get('error');
    linkError = error === 'access_denied'
      ? 'ORCID sign-in was cancelled.'
      : 'ORCID sign-in did not complete. Try again, or use email.';
  } else if (hasError) {
    linkError = errorCode === 'otp_expired'
      ? 'This email link has expired.'
      : 'This email link is invalid or has already been used.';
    linkError += wantsRecovery ? ' Request a new one below.' : ' Sign in, or request a new link.';
  }
  return {
    screen: auth === 'signin' || auth === 'register' ? auth : wantsRecovery && hasError ? 'forgot' : undefined,
    signedOut: auth === 'signedout',
    recovery: wantsRecovery && !hasError,
    linkError,
    orcid,
  };
}

const intent = readIntent();
let recoveryMode = intent.recovery;
const listeners = new Set<(change: AuthChange, user: AuthUser | null) => void>();
let client: SupabaseClient | undefined;

function mapEvent(event: AuthChangeEvent): AuthChange | undefined {
  if (event === 'SIGNED_IN') return 'signed-in';
  if (event === 'SIGNED_OUT') return 'signed-out';
  if (event === 'PASSWORD_RECOVERY') return 'password-recovery';
  return undefined;
}

/** The client, with the auth listener attached before it finishes reading the URL. */
function sb(): SupabaseClient {
  if (!client) {
    client = getSupabase();
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') recoveryMode = true;
      const change = mapEvent(event);
      if (!change) return;
      const user = session?.user ? toAuthUser(session.user) : null;
      // Supabase advises against doing more auth work inside this callback; defer it.
      setTimeout(() => listeners.forEach((l) => l(change, user)), 0);
    });
  }
  return client;
}

const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** The iD of an ORCID identity Supabase created, if this user has one. */
function orcidOf(user: User): string | undefined {
  const identity = user.identities?.find((i) => i.provider === ORCID_PROVIDER || i.provider === 'orcid');
  if (!identity) return undefined;
  const raw = String(identity.identity_data?.sub ?? identity.id ?? '').replace(/^https?:\/\/(sandbox\.)?orcid\.org\//, '');
  return ORCID_ID.test(raw) ? raw : undefined;
}

function toAuthUser(user: User): AuthUser {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const email = user.email ?? '';
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const given = [text(meta.given_name), text(meta.family_name)].filter(Boolean).join(' ');
  const displayName = text(meta.display_name) ?? text(meta.full_name) ?? text(meta.name) ?? text(given)
    ?? (email.split('@')[0] || 'Researcher');
  return { id: user.id, email, displayName, orcidId: orcidOf(user) };
}

/** The simulator's own address, for email links to come back to. */
function returnUrl(auth?: string): string {
  const url = new URL(window.location.pathname, window.location.origin);
  if (auth) url.searchParams.set('auth', auth);
  return url.toString();
}

type Action = 'signin' | 'signup' | 'reset' | 'update' | 'orcid';

/** Maps any failure to calm, specific text. Never echoes the backend's own message. */
function friendly(err: unknown, action: Action): string {
  const code = isAuthError(err) ? err.code : undefined;
  const status = isAuthError(err) ? err.status : undefined;
  console.warn(`[auth] ${action} failed (${code ?? status ?? 'network'})`);

  if (isAuthRetryableFetchError(err) || err instanceof TypeError || status === 0) {
    return 'Unable to connect. Try again.';
  }
  if (isAuthWeakPasswordError(err) || code === 'weak_password') {
    return 'This password is too weak. Use a longer password that you do not use elsewhere.';
  }
  if (isAuthSessionMissingError(err)) {
    return 'Your reset link is no longer valid. Request a new one.';
  }
  switch (code) {
    case 'invalid_credentials':
      return 'Invalid email or password.';
    case 'email_not_confirmed':
      return 'Please confirm your email before signing in.';
    case 'user_already_exists':
    case 'email_exists':
      return 'An account with this email already exists. Sign in instead.';
    case 'email_address_invalid':
      return 'Enter a valid email address.';
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'New registrations are currently closed.';
    case 'same_password':
      return 'Choose a password that is different from your current one.';
    case 'session_not_found':
    case 'session_expired':
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
      return action === 'update'
        ? 'Your reset link is no longer valid. Request a new one.'
        : 'Your session has expired. Sign in again.';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Too many attempts. Wait a minute, then try again.';
    case 'provider_disabled':
    case 'oauth_provider_not_supported':
      return action === 'orcid' ? 'ORCID sign-in is not available right now. Use email instead.' : 'This sign-in method is not available.';
    case 'user_banned':
      return 'This account cannot sign in. Contact the Iressa team.';
  }
  if (status === 429) return 'Too many attempts. Wait a minute, then try again.';
  if (action === 'signin' && status === 400) return 'Invalid email or password.';
  return 'Something went wrong. Try again.';
}

async function attempt<T>(action: Action, run: () => Promise<T>): Promise<AuthResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, message: friendly(err, action) };
  }
}

export const authService = {
  /** Why auth cannot run, if it cannot: missing settings, or a secret key where a public one belongs. */
  configProblem: configProblem as ConfigProblem | undefined,

  /** What the page URL asked for when it loaded. */
  intent,

  /** True while the visitor is back from a reset email and has not yet set a new password. */
  isRecovery(): boolean {
    return recoveryMode;
  },

  /** The current session's user, or null. Waits for any email-link sign-in in the URL to finish. */
  async getSession(): Promise<AuthUser | null> {
    try {
      const { data, error } = await sb().auth.getSession();
      if (error || !data.session) return null;
      return toAuthUser(data.session.user);
    } catch {
      return null;
    }
  },

  signIn(email: string, password: string): Promise<AuthResult<AuthUser>> {
    return attempt('signin', async () => {
      const { data, error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      return toAuthUser(data.user);
    });
  },

  signUp(fullName: string, email: string, password: string): Promise<AuthResult<SignUpOutcome>> {
    return attempt('signup', async () => {
      const name = fullName.trim();
      const { data, error } = await sb().auth.signUp({
        email: email.trim(),
        password,
        options: {
          // Read by the database trigger that creates the researcher profile.
          data: { full_name: name, display_name: name },
          emailRedirectTo: returnUrl(),
        },
      });
      if (error) throw error;
      // No session means the project requires email confirmation first.
      return data.session ? 'signed-in' : 'confirm-email';
    });
  },

  /** Whether "Sign in with ORCID" is offered. */
  orcidEnabled,

  /**
   * Hands the browser to ORCID. Supabase runs the OpenID Connect exchange,
   * verifies ORCID's signed ID token, creates the account on first use and
   * returns here with a session; a database trigger records the verified iD.
   */
  signInWithOrcid(): Promise<AuthResult> {
    return attempt('orcid', async () => {
      const { error } = await sb().auth.signInWithOAuth({
        provider: ORCID_PROVIDER,
        options: { redirectTo: returnUrl('orcid') },
      });
      if (error) throw error;
    });
  },

  /** Always resolves the same way whether or not the address has an account. */
  resetPassword(email: string): Promise<AuthResult> {
    return attempt('reset', async () => {
      const { error } = await sb().auth.resetPasswordForEmail(email.trim(), { redirectTo: returnUrl('recovery') });
      if (error) throw error;
    });
  },

  updatePassword(password: string): Promise<AuthResult<AuthUser>> {
    return attempt('update', async () => {
      const { data, error } = await sb().auth.updateUser({ password });
      if (error) throw error;
      recoveryMode = false;
      return toAuthUser(data.user);
    });
  },

  /** Ends the session. The local session is cleared even if the server cannot be reached. */
  async signOut(): Promise<void> {
    try {
      await sb().auth.signOut();
    } catch {
      /* auth-js removes the local session before reporting a network failure */
    }
  },

  subscribeToAuthChanges(listener: (change: AuthChange, user: AuthUser | null) => void): () => void {
    sb();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Removes auth-only parameters from the address bar, keeping everything else. */
  clearAuthParams(): void {
    const url = new URL(window.location.href);
    for (const k of AUTH_QUERY_KEYS) url.searchParams.delete(k);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (!url.hash || url.hash === '#' || AUTH_HASH_KEYS.some((k) => hash.has(k))) url.hash = '';
    const next = url.pathname + url.search;
    if (next + url.hash !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(window.history.state, '', next + url.hash);
    }
  },

  /** Where to land after signing out: the auth screen, with a short notice. */
  signedOutUrl(): string {
    const url = new URL(window.location.href);
    for (const k of AUTH_QUERY_KEYS) url.searchParams.delete(k);
    url.searchParams.set('auth', 'signedout');
    url.hash = '';
    return url.pathname + url.search;
  },
};

export type AuthService = typeof authService;

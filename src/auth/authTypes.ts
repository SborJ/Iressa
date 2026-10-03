/** The signed-in researcher, as the UI needs them. Nothing token-shaped lives here. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  /**
   * The ORCID iD Supabase verified through ORCID sign-in, for display only.
   * Authorisation decisions read the database (profiles.orcid_verified_at),
   * never this field.
   */
  orcidId?: string;
}

/** Every auth call resolves to this; user-facing text only, never a raw backend message. */
export type AuthResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

/** After sign-up: straight in, or wait for the confirmation email. */
export type SignUpOutcome = 'signed-in' | 'confirm-email';

/** The screens the auth view can show. */
export type AuthScreen = 'signin' | 'register' | 'forgot' | 'recovery';

/** Auth events the app reacts to, decoupled from Supabase's event names. */
export type AuthChange = 'signed-in' | 'signed-out' | 'password-recovery';

/**
 * What the page URL asked for when it loaded: an explicit screen
 * (?auth=signin from the landing page), a just-signed-out notice, a password
 * recovery return, or an expired / invalid email link.
 */
export interface AuthIntent {
  screen?: AuthScreen;
  signedOut: boolean;
  recovery: boolean;
  linkError?: string;
  /** Returning from ORCID sign-in. */
  orcid: boolean;
}

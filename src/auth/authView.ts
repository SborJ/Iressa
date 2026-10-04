import { el } from '../ui/dom.js';
import { hideLoader, showLoader } from '../ui/loader.js';
import type { AuthService } from './authService.js';
import type { AuthIntent, AuthScreen, AuthUser } from './authTypes.js';
import { orcidIcon } from './orcidIcon.js';
import type { ConfigProblem } from './supabase.js';

/**
 * The research-access screens: sign in, register, forgot password, set a new
 * password, plus the loading and "check your email" states.
 *
 * Plain DOM, built with textContent only: nothing a visitor types is ever
 * parsed as HTML. Native <form>s give enter-to-submit and password managers
 * the structure they expect.
 */

const MIN_PASSWORD = 8;
/** bcrypt, which Supabase uses, ignores everything past 72 bytes. */
const MAX_PASSWORD = 72;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Notice = { text: string; tone: 'info' | 'error' };
type State = AuthScreen | 'loading' | 'config' | 'confirm' | 'sent' | 'updated' | 'hidden';

export interface AuthViewHandlers {
  /** A session exists and the visitor chose (or needed no choice) to go in. */
  onAuthenticated(user: AuthUser): void;
}

interface Field {
  input: HTMLInputElement;
  row: HTMLElement;
}

export class AuthView {
  private state: State = 'hidden';
  private panel = el('div', { class: 'auth-panel' });

  constructor(
    private root: HTMLElement,
    private auth: AuthService,
    private handlers: AuthViewHandlers,
  ) {
    this.root.replaceChildren(
      el('div', { class: 'auth-shell' }, [
        this.panel,
        el('p', { class: 'auth-foot' }, [
          // The simulator lives at /simulation/; the overview is the site root.
          el('a', { href: '../', text: 'About Iressa' }),
        ]),
      ]),
    );
  }

  /** Whether a sign-in that happened elsewhere (another tab, an email link) may take this screen straight in. */
  acceptsExternalSignIn(): boolean {
    return this.state === 'signin' || this.state === 'register' || this.state === 'confirm';
  }

  hide(): void {
    this.state = 'hidden';
    this.root.hidden = true;
    this.panel.replaceChildren();
  }

  /** The page's loading cells, saying what is being waited for. */
  showLoading(text = 'Checking access…'): void {
    this.state = 'loading';
    this.root.hidden = true;
    showLoader(text);
  }

  showConfigProblem(problem: ConfigProblem): void {
    const text = problem === 'secret-key'
      ? 'The configured Supabase key is a secret (service-role) key. It must never be used in the browser. Replace VITE_SUPABASE_ANON_KEY with the project’s public anon key.'
      : 'Sign-in is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example), then restart the dev server.';
    this.mount('config', [
      this.heading('Research access'),
      el('p', { class: 'auth-msg error', role: 'alert', text }),
    ]);
  }

  /** The first screen for a signed-out visitor, honouring what the URL asked for. */
  showInitial(intent: AuthIntent): void {
    if (intent.linkError) {
      this.show(intent.screen ?? 'signin', { text: intent.linkError, tone: 'error' });
    } else if (intent.recovery) {
      // Back from a reset email, but the link no longer yields a session.
      this.show('forgot', { text: 'Your reset link is no longer valid. Request a new one below.', tone: 'error' });
    } else if (intent.signedOut) {
      this.show('signin', { text: 'You have signed out.', tone: 'info' });
    } else {
      this.show(intent.screen ?? 'signin');
    }
  }

  show(screen: AuthScreen, notice?: Notice): void {
    if (screen === 'signin') this.signIn(notice);
    else if (screen === 'register') this.register(notice);
    else if (screen === 'forgot') this.forgot(notice);
    else this.recovery(notice);
  }

  /* ── screens ───────────────────────────────────────────────────────────── */

  private signIn(notice?: Notice, email = ''): void {
    const emailF = this.field('auth-email', 'Email', 'email', 'email', email);
    const passF = this.field('auth-password', 'Password', 'password', 'current-password');
    const forgot = this.link('Forgot password', () => this.forgot(undefined, emailF.input.value));
    const form = this.form('Sign in', 'Signing in…', [emailF.row, passF.row], async (fail) => {
      const address = emailF.input.value.trim();
      if (!EMAIL.test(address)) return fail('Enter a valid email address.', emailF);
      if (!passF.input.value) return fail('Enter your password.', passF);
      const res = await this.auth.signIn(address, passF.input.value);
      if (!res.ok) {
        passF.input.value = '';
        return fail(res.message, passF);
      }
      this.handlers.onAuthenticated(res.value);
    }, notice);
    form.querySelector('.auth-submit')!.after(el('div', { class: 'auth-aside' }, [forgot]));

    this.mount('signin', [
      this.heading('Research access'),
      form,
      ...this.orcidOption('Sign in with ORCID'),
      el('p', { class: 'auth-switch' }, [
        document.createTextNode('No account? '),
        this.link('Create account', () => this.register(undefined, emailF.input.value)),
      ]),
    ], emailF.input.value ? passF.input : emailF.input);
  }

  private register(notice?: Notice, email = ''): void {
    const nameF = this.field('auth-name', 'Full name', 'text', 'name');
    const emailF = this.field('auth-email', 'Email', 'email', 'email', email);
    const passF = this.field('auth-password', 'Password', 'password', 'new-password', '',
      `At least ${MIN_PASSWORD} characters.`);
    const confirmF = this.field('auth-confirm', 'Confirm password', 'password', 'new-password');
    passF.input.minLength = MIN_PASSWORD;
    passF.input.maxLength = MAX_PASSWORD;

    const form = this.form('Create account', 'Creating account…', [nameF.row, emailF.row, passF.row, confirmF.row], async (fail) => {
      const name = nameF.input.value.trim();
      const address = emailF.input.value.trim();
      if (!name) return fail('Enter your full name.', nameF);
      if (name.length > 120) return fail('Use at most 120 characters for your name.', nameF);
      if (!EMAIL.test(address)) return fail('Enter a valid email address.', emailF);
      const pw = this.checkNewPassword(passF, confirmF);
      if (pw) return fail(pw.message, pw.field);

      const res = await this.auth.signUp(name, address, passF.input.value);
      if (!res.ok) return fail(res.message, res.message.includes('password') ? passF : emailF);
      if (res.value === 'signed-in') {
        const user = await this.auth.getSession();
        if (user) return this.handlers.onAuthenticated(user);
      }
      this.confirm(address);
    }, notice);

    this.mount('register', [
      this.heading('Create account'),
      form,
      ...this.orcidOption('Continue with ORCID'),
      el('p', { class: 'auth-switch' }, [
        document.createTextNode('Already registered? '),
        this.link('Sign in', () => this.signIn(undefined, emailF.input.value)),
      ]),
    ], nameF.input);
  }

  private forgot(notice?: Notice, email = ''): void {
    const emailF = this.field('auth-email', 'Email', 'email', 'email', email);
    const form = this.form('Send reset link', 'Sending…', [emailF.row], async (fail) => {
      const address = emailF.input.value.trim();
      if (!EMAIL.test(address)) return fail('Enter a valid email address.', emailF);
      const res = await this.auth.resetPassword(address);
      if (!res.ok) return fail(res.message, emailF);
      this.mount('sent', [
        this.heading('Reset password'),
        el('p', { class: 'auth-msg info', role: 'status', text: 'If an account exists for this email, a reset link has been sent.' }),
        el('p', { class: 'auth-note', text: 'The link opens Iressa and asks for a new password. Check your spam folder if it does not arrive within a few minutes.' }),
        el('p', { class: 'auth-switch' }, [this.link('Back to sign in', () => this.signIn(undefined, address))]),
      ]);
    }, notice);

    this.mount('forgot', [
      this.heading('Reset password'),
      el('p', { class: 'auth-note', text: 'Enter the email you registered with and we will send a link to set a new password.' }),
      form,
      el('p', { class: 'auth-switch' }, [this.link('Back to sign in', () => this.signIn(undefined, emailF.input.value))]),
    ], emailF.input);
  }

  private recovery(notice?: Notice): void {
    const passF = this.field('auth-password', 'New password', 'password', 'new-password', '',
      `At least ${MIN_PASSWORD} characters.`);
    const confirmF = this.field('auth-confirm', 'Confirm password', 'password', 'new-password');
    passF.input.minLength = MIN_PASSWORD;
    passF.input.maxLength = MAX_PASSWORD;

    const form = this.form('Update password', 'Updating…', [passF.row, confirmF.row], async (fail) => {
      const pw = this.checkNewPassword(passF, confirmF);
      if (pw) return fail(pw.message, pw.field);
      const res = await this.auth.updatePassword(passF.input.value);
      if (!res.ok) return fail(res.message, passF);
      const user = res.value;
      const go = el('button', { type: 'button', class: 'auth-submit', text: 'Continue to simulator' });
      go.addEventListener('click', () => this.handlers.onAuthenticated(user));
      this.mount('updated', [
        this.heading('Set new password'),
        el('p', { class: 'auth-msg info', role: 'status', text: 'Password updated successfully.' }),
        go,
      ], go);
    }, notice);

    this.mount('recovery', [
      this.heading('Set new password'),
      form,
    ], passF.input);
  }

  private confirm(email: string): void {
    const note = el('p', { class: 'auth-note' }, [
      document.createTextNode('We sent a confirmation link to '),
      el('strong', { text: email }),
      document.createTextNode('. Open it to activate your account; it brings you straight into the simulator.'),
    ]);
    this.mount('confirm', [
      this.heading('Create account'),
      el('p', { class: 'auth-msg info', role: 'status', text: 'Check your email to confirm your account.' }),
      note,
      el('p', { class: 'auth-switch' }, [this.link('Back to sign in', () => this.signIn(undefined, email))]),
    ]);
  }

  /* ── building blocks ───────────────────────────────────────────────────── */

  /**
   * "Sign in with ORCID", offered only once the provider is configured.
   * The same button registers a first-time researcher: ORCID proves who they are.
   */
  private orcidOption(text: string): HTMLElement[] {
    if (!this.auth.orcidEnabled) return [];
    const label = el('span', { text });
    const button = el('button', { type: 'button', class: 'auth-orcid' }, [orcidIcon(18), label]);
    const msg = el('p', { class: 'auth-msg', 'aria-live': 'polite' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      label.textContent = 'Redirecting to ORCID…';
      msg.textContent = '';
      showLoader('Redirecting to ORCID…');
      const res = await this.auth.signInWithOrcid();
      // On success the browser is already leaving for ORCID.
      if (!res.ok) {
        hideLoader();
        button.disabled = false;
        label.textContent = text;
        msg.textContent = res.message;
        msg.className = 'auth-msg error';
        msg.setAttribute('role', 'alert');
      }
    });
    return [el('div', { class: 'auth-or', 'aria-hidden': 'true' }, [el('span', { text: 'or' })]), button, msg];
  }

  private checkNewPassword(passF: Field, confirmF: Field): { message: string; field: Field } | undefined {
    const pw = passF.input.value;
    if (pw.length < MIN_PASSWORD) return { message: `Use at least ${MIN_PASSWORD} characters for your password.`, field: passF };
    if (new TextEncoder().encode(pw).length > MAX_PASSWORD) return { message: `Use at most ${MAX_PASSWORD} characters for your password.`, field: passF };
    if (pw !== confirmF.input.value) return { message: 'Passwords do not match.', field: confirmF };
    return undefined;
  }

  private mount(state: State, children: Node[], focus?: HTMLElement): void {
    this.state = state;
    this.root.hidden = false;
    this.panel.replaceChildren(el('div', { class: 'auth-brand', text: 'Iressa' }), ...children);
    this.panel.dataset.screen = state;
    hideLoader();
    focus?.focus();
  }

  private heading(text: string): HTMLElement {
    return el('h1', { class: 'auth-title', text });
  }

  private link(text: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', { type: 'button', class: 'auth-link', text });
    b.addEventListener('click', onClick);
    return b;
  }

  private field(id: string, label: string, type: string, autocomplete: string, value = '', hint?: string): Field {
    const input = el('input', { id, name: id, type, autocomplete, required: '', spellcheck: 'false' }) as HTMLInputElement;
    if (type === 'email') {
      input.setAttribute('autocapitalize', 'none');
      input.inputMode = 'email';
    }
    input.value = value;
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    const row = el('div', { class: 'auth-field' }, [el('label', { for: id, text: label }), input]);
    if (hint) {
      const hintEl = el('p', { class: 'auth-hint', id: `${id}-hint`, text: hint });
      input.setAttribute('aria-describedby', hintEl.id);
      row.append(hintEl);
    }
    return { input, row };
  }

  /**
   * A form with one submit button and one message line. While the request is
   * in flight the fields are locked and the button says what is happening.
   */
  private form(
    submitText: string,
    busyText: string,
    rows: HTMLElement[],
    onSubmit: (fail: (message: string, field?: Field) => void) => Promise<void>,
    notice?: Notice,
  ): HTMLFormElement {
    const msg = el('p', { class: 'auth-msg', 'aria-live': 'polite', id: `auth-msg-${Math.random().toString(36).slice(2, 8)}` });
    const submit = el('button', { type: 'submit', class: 'auth-submit', text: submitText });
    const fields = el('fieldset', { class: 'auth-fields' }, rows);
    const form = el('form', { class: 'auth-form', novalidate: '' }, [fields, msg, submit]);

    const say = (n?: Notice) => {
      msg.textContent = n?.text ?? '';
      msg.className = `auth-msg${n ? ` ${n.tone}` : ''}`;
      msg.setAttribute('role', n?.tone === 'error' ? 'alert' : 'status');
    };
    say(notice);

    let busy = false;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (busy) return;
      busy = true;
      say();
      fields.disabled = true;
      submit.disabled = true;
      submit.textContent = busyText;
      form.setAttribute('aria-busy', 'true');

      let failed: Field | undefined;
      const fail = (message: string, field?: Field) => {
        say({ text: message, tone: 'error' });
        failed = field;
        if (field) {
          field.input.setAttribute('aria-invalid', 'true');
          field.input.setAttribute('aria-errormessage', msg.id);
        }
      };
      onSubmit(fail)
        .catch(() => fail('Something went wrong. Try again.'))
        .finally(() => {
          busy = false;
          if (!form.isConnected) return;
          fields.disabled = false;
          submit.disabled = false;
          submit.textContent = submitText;
          form.removeAttribute('aria-busy');
          failed?.input.focus();
        });
    });
    return form;
  }
}

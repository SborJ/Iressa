import { el } from '../ui/dom.js';
import type { AuthUser } from './authTypes.js';
import { orcidIcon } from './orcidIcon.js';

/**
 * The account slot in the simulator's top bar: who is signed in, and a way
 * out. Deliberately quiet: the top bar belongs to the science.
 */
export function mountAccount(host: HTMLElement, user: AuthUser, onSignOut: () => Promise<void>): void {
  const label = user.email || user.displayName;
  const who = el('span', { class: 'acct-who', text: label, title: [user.displayName, user.email].filter(Boolean).join(' · ') });
  const out = el('button', { type: 'button', class: 'btn ghost acct-out', text: 'Sign out' });
  const parts: HTMLElement[] = [];
  if (user.orcidId) {
    // Verified through ORCID sign-in; links to the public record, as ORCID recommends.
    parts.push(el('a', {
      class: 'acct-orcid', href: `https://orcid.org/${user.orcidId}`, target: '_blank', rel: 'noopener noreferrer',
      title: `Verified ORCID iD ${user.orcidId}`, 'aria-label': `Verified ORCID iD ${user.orcidId}`,
    }, [orcidIcon(14), el('span', { text: user.orcidId })]));
  }
  out.addEventListener('click', () => {
    out.disabled = true;
    out.textContent = 'Signing out…';
    void onSignOut();
  });
  host.replaceChildren(...parts, who, out);
  host.hidden = false;
}

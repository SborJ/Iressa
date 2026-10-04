import { el } from './dom.js';

/**
 * The loading screen: a dividing cell, drawn in simulation/index.html so it is
 * on screen before any script arrives. Everything that makes the visitor wait
 * (checking the session, leaving for ORCID, loading the run and building the
 * scene) keeps it up and says what it is doing; anything that is ready to be
 * looked at takes it down.
 */

function loader(): HTMLElement | null {
  return document.getElementById('loader');
}

/** Shows the loading screen, or changes what it says if it is already up. */
export function showLoader(text: string): void {
  const root = loader();
  if (!root) return;
  const label = root.querySelector('.loader-text');
  if (label) label.textContent = text;
  root.classList.remove('off');
}

/** Fades the loading screen out. */
export function hideLoader(): void {
  loader()?.classList.add('off');
}

/**
 * The same cells over one element only, for waits inside the running
 * simulator (opening another run). Appears only if the wait is noticeable.
 * Returns the function that removes it.
 */
export function overlayLoader(host: HTMLElement, text: string): () => void {
  const cells = loader()?.querySelector('svg.cells')?.cloneNode(true) as SVGElement | undefined;
  // The goo filter stays defined once, in the page loader, so ids never repeat.
  cells?.querySelector('defs')?.remove();
  const overlay = el('div', { class: 'stage-loader', role: 'status', 'aria-live': 'polite' },
    [...(cells ? [cells] : []), el('p', { class: 'loader-text', text })]);
  host.append(overlay);
  return () => overlay.remove();
}

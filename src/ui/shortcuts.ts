import type { Controls } from './controls.js';

/**
 * The keys for the controls reached most often. Every one is also printed in
 * its control, so the interface teaches them rather than hiding them.
 */
export function bindShortcuts(
  controls: Controls,
  actions: { onFrame(): void; onReset(): void },
): () => void {
  const handler = (ev: KeyboardEvent) => {
    const target = ev.target as HTMLElement | null;
    // Never steal a key from a control the user is operating.
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        controls.togglePlay();
        return;
      case '.':
        ev.preventDefault();
        controls.step();
        return;
      case 'f':
      case 'F':
        actions.onFrame();
        return;
      case 'r':
      case 'R':
        actions.onReset();
        return;
      default:
        break;
    }
    const n = Number(ev.key);
    if (Number.isInteger(n) && n >= 1 && n <= controls.viewNames.length) {
      controls.setView(controls.viewNames[n - 1]);
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

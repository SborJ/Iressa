import { animate } from 'motion/mini';

/**
 * The project's motion language, in one place.
 *
 * Two rules keep it from becoming noise: everything that moves uses one of
 * these durations, and nothing moves that a person did not ask to move. The
 * numbers update five times a second - animating those would be a flicker, not
 * an animation - so motion is spent on structure instead: a panel opening, a
 * view changing, a chart redrawing.
 */

/** Entering elements decelerate; it reads as arriving rather than being placed. */
export const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

export const MICRO = 0.14;      /* hover, press - below this nothing registers */
export const SHIFT = 0.22;      /* a fold, a switch, a redraw */
export const ENTER = 0.32;      /* something arriving on screen */

export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Keyframes = Record<string, string | number | (string | number)[]>;

/** animate(), with reduced-motion honoured and the final state always applied. */
export function move(
  target: Element | Element[],
  to: Keyframes,
  duration = SHIFT,
  opts: { delay?: number; ease?: readonly number[] } = {},
): void {
  if (reducedMotion()) {
    for (const node of Array.isArray(target) ? target : [target]) {
      for (const [k, v] of Object.entries(to)) {
        const last = Array.isArray(v) ? v[v.length - 1] : v;
        (node as HTMLElement).style.setProperty(k, String(last));
      }
    }
    return;
  }
  animate(target as Element, to as never, {
    duration,
    delay: opts.delay ?? 0,
    ease: (opts.ease ?? EASE_OUT) as never,
  });
}

/** A short rise into place, used once when the interface first appears. */
export function enter(nodes: Element[], stagger = 0.045): void {
  if (reducedMotion()) return;
  nodes.forEach((node, i) => {
    animate(
      node,
      { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0px)'] } as never,
      { duration: ENTER, delay: i * stagger, ease: EASE_OUT as never },
    );
  });
}

/**
 * Opens and closes a <details> at its own height.
 *
 * The element has no animatable height of its own, so it is measured, animated
 * between 0 and that measurement, and released back to auto - otherwise the
 * content cannot reflow afterwards.
 */
export function foldTo(body: HTMLElement, open: boolean): void {
  if (reducedMotion()) return;
  const height = body.scrollHeight;
  body.style.overflow = 'hidden';
  const from = open ? 0 : height;
  const to = open ? height : 0;
  animate(
    body,
    { height: [`${from}px`, `${to}px`], opacity: open ? [0, 1] : [1, 0] } as never,
    { duration: SHIFT, ease: EASE_OUT as never },
  ).finished.then(() => {
    body.style.overflow = '';
    body.style.height = open ? '' : '0px';
    if (open) body.style.opacity = '';
  });
}

/**
 * Crossfades text in place when the words change.
 *
 * Guarded against overlap: a second swap arriving mid-fade would leave the
 * first animation's `finished` to reject when it is cancelled, and the element
 * stranded at zero opacity with no text visible at all. While a fade is in
 * flight the next change is applied outright.
 */
const fading = new WeakSet<HTMLElement>();

export function swapText(node: HTMLElement, text: string): void {
  if (node.textContent === text) return;
  if (reducedMotion() || fading.has(node)) {
    node.textContent = text;
    node.style.opacity = '';
    return;
  }
  fading.add(node);
  const settle = () => {
    fading.delete(node);
    node.style.opacity = '';
  };
  animate(node, { opacity: [1, 0] } as never, { duration: MICRO / 2, ease: EASE_OUT as never })
    .finished.then(() => {
      node.textContent = text;
      return animate(node, { opacity: [0, 1] } as never, {
        duration: MICRO,
        ease: EASE_OUT as never,
      }).finished;
    })
    .then(settle, () => {
      // Cancelled by a newer swap: show the latest text rather than nothing.
      node.textContent = text;
      settle();
    });
}

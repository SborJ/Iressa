export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** A square swatch. Data identity is a square here, never a pill or a dot. */
export function swatch(color: string): HTMLElement {
  const s = el('span', { class: 'sw' });
  s.style.background = color;
  return s;
}

/** An engraved section of a rail. */
export function section(title: string, children: (Node | string)[] = [], cls = ''): HTMLElement {
  return el('section', { class: `section ${cls}`.trim() }, [el('h2', { text: title }), ...children]);
}

/**
 * One field: label on the left, monospace value on the right.
 * `unit` and `delta` are muted so the magnitude reads first.
 */
export function row(
  label: string,
  value: string,
  opts: { unit?: string; delta?: string; spark?: Node } = {},
): HTMLElement {
  const v = el('span', { class: 'v' }, [document.createTextNode(value)]);
  if (opts.unit) v.append(el('span', { class: 'u', text: ` ${opts.unit}` }));
  if (opts.delta) v.append(el('span', { class: 'd', text: opts.delta }));
  const kids: Node[] = [el('span', { class: 'k', text: label })];
  if (opts.spark) kids.push(opts.spark);
  kids.push(v);
  return el('div', { class: 'row' }, kids);
}

/* ------------------------------------------------------------------ *
 * Number formatting.
 *
 * Fixed decimals per quantity, tabular figures and an explicit unit, so a
 * value never changes width as it updates and is never a bare number.
 * ------------------------------------------------------------------ */

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

export function fixed(n: number, places: number): string {
  return n.toFixed(places);
}

/** Signed, for a change over time: +412, -1,204, 0. */
export function signed(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

export function percent(fraction: number, places = 0): string {
  return `${(fraction * 100).toFixed(places)}`;
}

/** Simulated time as a day and an hour, which is how the schedule is written. */
export function clockOf(hours: number): string {
  const day = Math.floor(hours / 24);
  const hour = Math.floor(hours % 24);
  return `${day}d ${String(hour).padStart(2, '0')}h`;
}

/** A round, even axis bound at or above v. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** A short stable hash, for showing which parameter file produced a run. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

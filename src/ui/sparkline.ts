import { svg } from './dom.js';

const W = 48;
const H = 14;

/**
 * A hairline trace of where a number has been.
 *
 * No axes, no fill, no colour: it carries shape only, which is the one thing a
 * single number cannot tell you.
 */
export class Sparkline {
  readonly node: SVGElement;
  private path = svg('path', {
    fill: 'none',
    stroke: 'var(--ink-2)',
    'stroke-width': 1,
    'vector-effect': 'non-scaling-stroke',
  });
  private head = svg('rect', { width: 2, height: 2, fill: 'var(--ink-0)' });

  constructor() {
    this.node = svg('svg', {
      class: 'spark',
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      'aria-hidden': 'true',
    });
    this.node.append(this.path, this.head);
  }

  update(values: number[]): void {
    if (values.length < 2) {
      this.path.setAttribute('d', '');
      this.head.setAttribute('width', '0');
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // A flat trace should sit on the centre line rather than at an edge.
    const span = hi - lo < 1e-9 ? 1 : hi - lo;
    const base = hi - lo < 1e-9 ? lo - 0.5 : lo;
    const n = values.length;
    let d = '';
    let lastX = 0;
    let lastY = 0;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (W - 1) + 0.5;
      const y = H - 1.5 - ((values[i] - base) / span) * (H - 3);
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      lastX = x;
      lastY = y;
    }
    this.path.setAttribute('d', d);
    this.head.setAttribute('width', '2');
    this.head.setAttribute('x', String(lastX - 1));
    this.head.setAttribute('y', String(lastY - 1));
  }
}

import type { ResolvedRules } from '../sim/rules.js';
import { el, svg } from './dom.js';
import type { History } from './history.js';
import type { Narrative } from './narrative.js';
import { TONE } from './tone.js';

export interface TimelineHandlers {
  onTogglePlay(): void;
}

/**
 * Where you are in the experiment.
 *
 * The run is a story with phases - growth, treatment, whatever follows - and
 * the schedule that defines them is already in rules.json. Drawing them named
 * and in order turns "tick 820 of 2880" into a position in something with a
 * beginning and an end.
 */
export class Timeline {
  private svgRoot = svg('svg') as SVGSVGElement;
  private clock = el('div', { class: 'clock' });
  private playBtn = el('button', { class: 'btn icon play', type: 'button', 'aria-label': 'Play or pause' });
  private track = el('div', { class: 'track' });
  private phases: ReturnType<Narrative['phases']>;

  constructor(
    root: HTMLElement,
    private rules: ResolvedRules,
    narrative: Narrative,
    handlers: TimelineHandlers,
  ) {
    this.phases = narrative.phases();
    this.track.append(this.svgRoot);
    this.playBtn.addEventListener('click', () => handlers.onTogglePlay());
    root.append(this.playBtn, this.track, this.clock);
  }

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? '❚❚' : '▶';
    this.playBtn.style.fontSize = '11px';
  }

  update(tick: number, history: History): void {
    const w = this.track.clientWidth || 600;
    const h = this.track.clientHeight || 58;
    const maxHours = this.rules.maxTicks * this.rules.hoursPerTick;
    const x = (hours: number) => (Math.min(hours, maxHours) / maxHours) * w;
    const hours = tick * this.rules.hoursPerTick;

    this.svgRoot.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svgRoot.replaceChildren();

    const laneY = h - 22;
    const laneH = 8;

    /* ---- named phases ---- */
    for (const p of this.phases) {
      const x0 = x(p.from);
      const x1 = x(p.to);
      this.svgRoot.append(
        svg('rect', {
          x: x0, y: laneY, width: Math.max(1, x1 - x0 - 1), height: laneH,
          rx: 3, fill: TONE[p.tone], 'fill-opacity': 0.42,
        }),
      );
      if (x1 - x0 > 56) {
        const t = svg('text', {
          x: x0 + 5, y: laneY + laneH + 12, fill: TONE[p.tone], 'font-size': 10.5,
          'fill-opacity': 0.95,
        });
        t.textContent = p.label;
        this.svgRoot.append(t);
      }
    }

    /* ---- radiation fractions ---- */
    for (const r of this.rules.raw.treatment?.radiation ?? []) {
      const rx = x(r.hour);
      this.svgRoot.append(
        svg('line', {
          x1: rx, x2: rx, y1: laneY - 3, y2: laneY + laneH + 3,
          stroke: TONE.danger, 'stroke-width': 1.5,
        }),
      );
    }

    /* ---- the population so far, above the lane ---- */
    const living = history.values('living');
    const ticks = history.tickValues();
    if (living.length > 2 && ticks.length === living.length) {
      let hi = 1;
      for (const v of living) if (v > hi) hi = v;
      const top = 10;
      const bottom = laneY - 6;
      let d = '';
      for (let i = 0; i < living.length; i++) {
        const px = x(ticks[i] * this.rules.hoursPerTick);
        const py = bottom - (living[i] / hi) * (bottom - top);
        d += `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
      }
      this.svgRoot.append(
        svg('path', {
          d: `${d}L${x(ticks[ticks.length - 1] * this.rules.hoursPerTick).toFixed(1)},${bottom}L${x(ticks[0] * this.rules.hoursPerTick).toFixed(1)},${bottom}Z`,
          fill: 'var(--accent)', 'fill-opacity': 0.1,
        }),
        svg('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.5 }),
      );
    }

    /* ---- now ---- */
    const cx = x(hours);
    this.svgRoot.append(
      svg('line', { x1: cx, x2: cx, y1: 8, y2: laneY + laneH + 4, stroke: 'var(--fg)', 'stroke-width': 1 }),
      svg('circle', { cx, cy: 8, r: 3, fill: 'var(--fg)' }),
    );

    const day = hours / 24;
    this.clock.replaceChildren(
      document.createTextNode(`Day ${day.toFixed(1)}`),
      el('span', { text: ` of ${(maxHours / 24).toFixed(0)}` }),
    );
  }
}

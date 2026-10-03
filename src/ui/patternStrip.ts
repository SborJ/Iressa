import type { ResolvedRules } from '../sim/rules.js';
import type { Visuals } from '../render/visuals.js';
import { el, svg } from './dom.js';
import type { MetricsRow, RunMetrics } from './runMetrics.js';

/**
 * The treatment pattern: one row per drug, one cell per day, filled in the
 * drug's colour at its exposure level. Days where the treatment changed carry
 * a tick and, on hover, the plain-word label for the change. It reads like a
 * score: what was given, how much, when it switched.
 *
 * Fed by a run's readings (recorded or live). For recordings without readings
 * it falls back to the schedule in rules.json.
 */
export class PatternStrip {
  readonly node = el('div', { class: 'pattern over' });
  private svgRoot = svg('svg') as SVGSVGElement;
  private tip = el('div', { class: 'pattern-tip' });
  private rows: MetricsRow[] = [];
  private drugs: { id: number; name: string; label: string }[];
  private maxDays: number;
  private lastKey = '';

  constructor(
    host: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
  ) {
    this.drugs = (rules.raw.drugs ?? []).map((d) => ({ id: d.id, name: d.name, label: d.displayName ?? d.name }));
    this.maxDays = Math.max(1, (rules.maxTicks * rules.hoursPerTick) / 24);
    this.node.append(
      el('div', { class: 'pattern-head' }, [el('span', { class: 'label', text: 'Treatment pattern' }), el('span', { class: 'muted pattern-note', text: 'hover a change' })]),
      this.svgRoot,
      this.tip,
    );
    this.node.hidden = this.drugs.length === 0;
    host.append(this.node);
    this.svgRoot.addEventListener('pointerleave', () => { this.tip.hidden = true; });
  }

  /** Readings for the whole run (recorded) or so far (live). */
  setMetrics(metrics: RunMetrics | undefined): void {
    this.rows = metrics?.rows ?? [];
    if (!this.rows.length) this.rows = this.rowsFromSchedule();
    this.lastKey = '';
  }

  /** One more day of a live session. */
  append(row: MetricsRow): void {
    this.rows.push(row);
    this.lastKey = '';
  }

  private rowsFromSchedule(): MetricsRow[] {
    const schedule = this.rules.raw.treatment?.schedule ?? [];
    if (!schedule.length) return [];
    const days = Math.ceil(this.maxDays);
    const byName = new Map(this.drugs.map((d) => [d.id, d.name]));
    const rows: MetricsRow[] = [];
    for (let day = 0; day < days; day++) {
      const exposures: Record<string, number> = {};
      for (const s of schedule) {
        const start = s.startHour / 24;
        const end = start + (s.everyHours * s.doses) / 24;
        if (day >= start && day < end) exposures[byName.get(s.drug) ?? String(s.drug)] = s.amount;
      }
      rows.push({ day, eci: 0, exposures, clones: {} });
    }
    return rows;
  }

  update(currentDay: number): void {
    const w = this.node.clientWidth || 600;
    const rowH = 9;
    const top = 2;
    const h = top + this.drugs.length * rowH + 4;
    const key = `${w}|${this.rows.length}|${Math.floor(currentDay)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.svgRoot.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svgRoot.style.height = `${h}px`;
    this.svgRoot.replaceChildren();
    const x = (day: number) => (Math.min(day, this.maxDays) / this.maxDays) * w;
    const cellW = Math.max(1, x(1) - x(0));
    const dayRows = this.rows;
    this.drugs.forEach((drug, i) => {
      const y = top + i * rowH;
      this.svgRoot.append(svg('rect', { x: 0, y, width: w, height: rowH - 1, fill: 'var(--raised)', 'fill-opacity': 0.5 }));
      const colour = this.visuals.drugCss(drug.id);
      for (let k = 0; k < dayRows.length; k++) {
        const row = dayRows[k];
        const level = row.exposures[drug.name] ?? 0;
        if (level <= 0) continue;
        const next = dayRows[k + 1];
        const span = next ? Math.max(cellW, x(next.day) - x(row.day)) : cellW;
        this.svgRoot.append(svg('rect', { x: x(row.day), y, width: span, height: rowH - 1, fill: colour, 'fill-opacity': 0.25 + 0.75 * Math.min(1, level) }));
      }
    });
    // change markers
    for (let k = 0; k < dayRows.length; k++) {
      const row = dayRows[k];
      const prev = dayRows[k - 1];
      const changed = prev && JSON.stringify(prev.exposures) !== JSON.stringify(row.exposures);
      const label = (row as { label?: string }).label;
      if (!changed && !(k === 0 && Object.keys(row.exposures).length)) continue;
      const px = x(row.day);
      const mark = svg('rect', { x: px - 1, y: 0, width: 2, height: h, fill: 'var(--fg)', 'fill-opacity': 0.55 });
      const hit = svg('rect', { x: px - 5, y: 0, width: 10, height: h, fill: 'transparent' });
      const text = label ?? this.describe(prev?.exposures, row.exposures);
      hit.addEventListener('pointerenter', () => {
        this.tip.textContent = `Day ${Math.round(row.day)} — ${text}`;
        this.tip.hidden = false;
        this.tip.style.left = `${Math.min(Math.max(0, px - 80), Math.max(0, w - 260))}px`;
      });
      this.svgRoot.append(mark, hit);
    }
    // now
    const cx = x(currentDay);
    this.svgRoot.append(svg('line', { x1: cx, x2: cx, y1: 0, y2: h, stroke: 'var(--fg)', 'stroke-width': 1 }));
    // legend
    this.node.querySelector('.pattern-legend')?.remove();
    const legend = el('div', { class: 'pattern-legend' });
    for (const drug of this.drugs) {
      const sw = el('span', { class: 'sw' });
      sw.style.background = this.visuals.drugCss(drug.id);
      legend.append(el('span', { class: 'pattern-key' }, [sw, el('span', { text: drug.label.replace(/\s*\(.*\)\s*$/, '') })]));
    }
    this.node.append(legend);
  }

  /** A fallback label when a reading has none (schedule-derived rows). */
  private describe(prev: Record<string, number> | undefined, now: Record<string, number>): string {
    const names = (e: Record<string, number>) => Object.entries(e).filter(([, v]) => v > 0).map(([d, v]) => `${d} ${Math.round(v * 100)}%`).join(' + ');
    if (!prev || !Object.keys(prev).length) return `started ${names(now) || 'no treatment'}`;
    if (!Object.keys(now).length) return 'treatment stopped';
    return `changed to ${names(now)}`;
  }
}

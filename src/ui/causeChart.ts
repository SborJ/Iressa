import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { CauseStats } from '../world/causeStats.js';
import { chip, el, niceMax, svg } from './dom.js';
import { causeName } from './labels.js';

const PAD = { top: 10, right: 8, bottom: 18, left: 36 };

interface Marker {
  hours: number;
  label: string;
}

/**
 * Deaths by cause over time: a stacked area, one band per cause, coloured by
 * cause from visuals.json and ordered by the cause table in rules.json.
 *
 * The treatment markers are read from rules.json too, so the chart shows when
 * dosing started and when each radiation fraction landed without being told.
 */
export class CauseChart {
  private plot = el('div');
  private tableWrap = el('div', { class: 'table-wrap' });
  private legend = el('div', { class: 'chart-legend' });
  private toggle = el('button', { class: 'toggle', type: 'button' });
  private collapse = el('button', { class: 'toggle', type: 'button' });
  private content = el('div', { class: 'chart-content' });
  private svgRoot = svg('svg') as SVGSVGElement;
  private tip = el('div');
  private collapsed = true;
  private showTable = false;
  private width = 520;
  private height = 150;
  private causeIds: number[];
  private markers: Marker[];
  private latest: CauseStats | undefined;
  private hoverBucket = -1;

  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
  ) {
    this.causeIds = rules.raw.causes.filter((c) => c.kind === 'death').map((c) => c.id);
    this.markers = this.readMarkers();

    this.toggle.textContent = 'Table';
    this.toggle.addEventListener('click', () => {
      this.showTable = !this.showTable;
      this.toggle.textContent = this.showTable ? 'Chart' : 'Table';
      this.plot.hidden = this.showTable;
      this.tableWrap.hidden = !this.showTable;
      this.render();
    });
    this.collapse.textContent = 'Expand';
    this.collapse.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.syncCollapsed();
    });

    this.tip.style.cssText =
      'position:absolute;pointer-events:none;display:none;z-index:5;background:var(--surface-2);' +
      'border:1px solid var(--border);border-radius:6px;padding:7px 9px;font-size:11px;min-width:150px';

    this.plot.style.position = 'relative';
    this.plot.append(this.svgRoot, this.tip);
    this.tableWrap.hidden = true;

    this.content.append(this.plot, this.tableWrap, this.legend);
    this.root.replaceChildren(
      el('div', { class: 'chart-head' }, [
        el('h2', { text: 'Deaths by cause over time' }),
        el('div', { class: 'btnrow chart-actions' }, [this.toggle, this.collapse]),
      ]),
      this.content,
    );
    this.syncCollapsed();

    this.renderLegend();
    this.svgRoot.addEventListener('pointermove', (ev) => this.onMove(ev));
    this.svgRoot.addEventListener('pointerleave', () => {
      this.hoverBucket = -1;
      this.tip.style.display = 'none';
      this.render();
    });

    new ResizeObserver(() => {
      const w = this.plot.clientWidth;
      if (w > 0 && Math.abs(w - this.width) > 1) {
        this.width = w;
        this.render();
      }
    }).observe(this.plot);
  }

  private readMarkers(): Marker[] {
    const out: Marker[] = [];
    for (const s of this.rules.raw.treatment?.schedule ?? []) {
      const drug = this.rules.drugById.get(s.drug);
      out.push({ hours: s.startHour, label: `${drug?.name ?? `drug ${s.drug}`} start` });
    }
    const rad = this.rules.raw.treatment?.radiation ?? [];
    if (rad.length) {
      out.push({
        hours: rad[0].hour,
        label: rad.length > 1 ? `radiation ×${rad.length}` : 'radiation',
      });
    }
    return out;
  }

  private renderLegend(): void {
    const frag = document.createDocumentFragment();
    for (const id of this.causeIds) {
      frag.append(
        el('div', { class: 'legend-row' }, [
          chip(this.visuals.causeCss(id)),
          el('span', { class: 'name', text: causeName(this.rules, id) }),
        ]),
      );
    }
    this.legend.replaceChildren(frag);
  }

  update(stats: CauseStats): void {
    this.latest = stats;
    this.render();
  }

  private syncCollapsed(): void {
    this.root.classList.toggle('collapsed', this.collapsed);
    this.content.hidden = this.collapsed;
    this.toggle.hidden = this.collapsed;
    this.collapse.textContent = this.collapsed ? 'Expand' : 'Hide';
    if (!this.collapsed) this.render();
  }

  private xOf(tick: number, innerW: number): number {
    const span = Math.max(1, this.rules.maxTicks);
    return PAD.left + (Math.min(tick, span) / span) * innerW;
  }

  private render(): void {
    if (!this.latest) return;
    if (this.showTable) {
      this.renderTable(this.latest);
      return;
    }
    const stats = this.latest;
    const buckets = stats.buckets;
    const innerW = Math.max(60, this.width - PAD.left - PAD.right);
    const innerH = this.height - PAD.top - PAD.bottom;

    let peak = 0;
    for (const b of buckets) {
      let t = 0;
      for (const id of this.causeIds) t += b.deaths[id];
      if (t > peak) peak = t;
    }
    const yMax = niceMax(peak);
    const yOf = (v: number) => PAD.top + innerH - (v / yMax) * innerH;

    this.svgRoot.setAttribute('width', String(this.width));
    this.svgRoot.setAttribute('height', String(this.height));
    this.svgRoot.replaceChildren();

    /* --- recessive grid and axes --- */
    const axis = svg('g', { class: 'axis' });
    for (let k = 0; k <= 2; k++) {
      const v = (yMax / 2) * k;
      const y = yOf(v);
      axis.append(svg('line', { class: 'gridline', x1: PAD.left, x2: PAD.left + innerW, y1: y, y2: y }));
      const t = svg('text', { x: PAD.left - 6, y: y + 3, 'text-anchor': 'end' });
      t.textContent = v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
      axis.append(t);
    }
    const totalDays = Math.max(1, Math.round((this.rules.maxTicks * this.rules.hoursPerTick) / 24));
    const dayStep = totalDays <= 20 ? 5 : totalDays <= 70 ? 10 : 30;
    for (let d = 0; d <= totalDays; d += dayStep) {
      const x = this.xOf((d * 24) / this.rules.hoursPerTick, innerW);
      const t = svg('text', { x, y: this.height - 5, 'text-anchor': 'middle' });
      t.textContent = d === 0 ? 'day 0' : String(d);
      axis.append(t);
    }
    this.svgRoot.append(axis);

    /* --- stacked bands, drawn top of stack downwards --- */
    if (buckets.length > 1) {
      const cum = new Float64Array(buckets.length);
      const points: string[][] = [];
      for (const id of this.causeIds) {
        const upper: string[] = [];
        for (let i = 0; i < buckets.length; i++) {
          cum[i] += buckets[i].deaths[id];
          upper.push(`${this.xOf(buckets[i].tick, innerW).toFixed(1)},${yOf(cum[i]).toFixed(1)}`);
        }
        points.push(upper);
      }
      const baseline = buckets.map(
        (b) => `${this.xOf(b.tick, innerW).toFixed(1)},${yOf(0).toFixed(1)}`,
      );
      for (let s = this.causeIds.length - 1; s >= 0; s--) {
        const upper = points[s];
        const lower = s === 0 ? baseline : points[s - 1];
        const d = `M${upper.join('L')}L${[...lower].reverse().join('L')}Z`;
        this.svgRoot.append(
          svg('path', { d, fill: this.visuals.causeCss(this.causeIds[s]), 'fill-opacity': 0.92 }),
        );
      }
      // A 2px surface-coloured edge separates adjacent bands.
      for (let s = 0; s < this.causeIds.length; s++) {
        this.svgRoot.append(svg('path', { class: 'band-edge', d: `M${points[s].join('L')}` }));
      }
    }

    /* --- treatment markers, straight out of rules.json --- */
    for (const m of this.markers) {
      const x = this.xOf(m.hours / this.rules.hoursPerTick, innerW);
      if (x > PAD.left + innerW) continue;
      this.svgRoot.append(svg('line', { class: 'marker', x1: x, x2: x, y1: PAD.top, y2: PAD.top + innerH }));
      const t = svg('text', { class: 'marker-label', x: x + 3, y: PAD.top + 8 });
      t.textContent = m.label;
      this.svgRoot.append(t);
    }

    /* --- crosshair --- */
    if (this.hoverBucket >= 0 && this.hoverBucket < buckets.length) {
      const x = this.xOf(buckets[this.hoverBucket].tick, innerW);
      this.svgRoot.append(
        svg('line', { class: 'crosshair', x1: x, x2: x, y1: PAD.top, y2: PAD.top + innerH }),
      );
    }
  }

  private onMove(ev: PointerEvent): void {
    const stats = this.latest;
    if (!stats || !stats.buckets.length || this.showTable) return;
    const rect = this.svgRoot.getBoundingClientRect();
    const innerW = Math.max(60, this.width - PAD.left - PAD.right);
    const frac = (ev.clientX - rect.left - PAD.left) / innerW;
    const tick = frac * this.rules.maxTicks;

    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < stats.buckets.length; i++) {
      const d = Math.abs(stats.buckets[i].tick - tick);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.hoverBucket = best;
    this.render();

    const b = stats.buckets[best];
    const rows = this.causeIds
      .map((id) => ({ id, n: b.deaths[id] }))
      .filter((r) => r.n > 0)
      .sort((a, c) => c.n - a.n);
    const total = rows.reduce((a, r) => a + r.n, 0);

    const frag = document.createDocumentFragment();
    frag.append(
      el('div', {
        style: 'color:var(--text-muted);margin-bottom:4px',
        text: `day ${(b.hours / 24).toFixed(1)} · ${total.toLocaleString()} deaths`,
      }),
    );
    if (!rows.length) {
      frag.append(el('div', { class: 'empty', text: 'none' }));
    }
    for (const r of rows) {
      const row = el('div', { style: 'display:flex;align-items:center;gap:6px' }, [
        chip(this.visuals.causeCss(r.id)),
        el('span', { style: 'flex:1;color:var(--text-secondary)', text: causeName(this.rules, r.id) }),
        el('span', { style: 'font-family:var(--mono)', text: r.n.toLocaleString() }),
      ]);
      frag.append(row);
    }
    this.tip.replaceChildren(frag);
    this.tip.style.display = 'block';
    const tipW = this.tip.offsetWidth;
    const x = this.xOf(b.tick, innerW);
    this.tip.style.left = `${Math.max(0, Math.min(this.width - tipW, x + 10))}px`;
    this.tip.style.top = `${PAD.top}px`;
  }

  /** The table view, so the chart is never the only way to read the numbers. */
  private renderTable(stats: CauseStats): void {
    const perDay = new Map<number, Int32Array>();
    for (const b of stats.buckets) {
      const day = Math.floor(b.hours / 24);
      let row = perDay.get(day);
      if (!row) {
        row = new Int32Array(256);
        perDay.set(day, row);
      }
      for (const id of this.causeIds) row[id] += b.deaths[id];
    }

    const head = el('tr', {}, [el('th', { text: 'Day' })]);
    for (const id of this.causeIds) head.append(el('th', { text: causeName(this.rules, id) }));
    head.append(el('th', { text: 'Total' }));

    const body = el('tbody');
    for (const [day, row] of [...perDay.entries()].sort((a, b) => b[0] - a[0])) {
      let total = 0;
      const tr = el('tr', {}, [el('td', { text: String(day) })]);
      for (const id of this.causeIds) {
        total += row[id];
        tr.append(el('td', { text: row[id] ? row[id].toLocaleString() : '—' }));
      }
      tr.append(el('td', { text: total.toLocaleString() }));
      body.append(tr);
    }
    const table = el('table', { class: 'data' }, [el('thead', {}, [head]), body]);
    this.tableWrap.replaceChildren(table);
  }
}

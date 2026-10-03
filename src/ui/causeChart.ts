import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { CauseStats } from '../world/causeStats.js';
import { count, el, niceMax, svg } from './dom.js';
import { causeName } from './labels.js';

const PAD = { top: 12, right: 8, bottom: 20, left: 30 };
const HEIGHT = 118;

interface Marker {
  hours: number;
  label: string;
}

/**
 * Deaths by cause over the run.
 *
 * A stacked series, one band per cause, coloured and ordered by the cause table
 * in rules.json. The treatment markers come from the schedule in the same file,
 * so the chart shows when dosing began without being told. Bands are labelled
 * at their right-hand end where there is room, which is more direct than a
 * legend and costs no ink.
 */
export class CauseChart {
  private plot = el('div');
  private tableWrap = el('div', { class: 'table-wrap' });
  private toggle = el('button', { class: 'linkish', type: 'button' });
  private svgRoot = svg('svg') as SVGSVGElement;
  private showTable = false;
  private width = 640;
  private causeIds: number[];
  private markers: Marker[];
  private latest: CauseStats | undefined;
  private hoverBucket = -1;
  private highlighted = -1;
  private readout = el('div', { class: 'muted', style: 'min-height:16px;font-size:11.5px' });

  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
  ) {
    this.causeIds = rules.raw.causes.filter((c) => c.kind === 'death').map((c) => c.id);
    this.markers = this.readMarkers();

    this.toggle.className = 'btn ghost';
    this.toggle.style.cssText = 'padding:3px 8px;font-size:11.5px';
    this.toggle.textContent = 'Table';
    this.toggle.addEventListener('click', () => {
      this.showTable = !this.showTable;
      this.toggle.textContent = this.showTable ? 'Chart' : 'Table';
      this.plot.hidden = this.showTable;
      this.tableWrap.hidden = !this.showTable;
      this.render();
    });
    this.tableWrap.hidden = true;

    this.root.append(
      el('div', { style: 'display:flex;align-items:baseline;gap:10px;margin:14px 0 4px' }, [
        el('span', { class: 'muted', style: 'flex:1', text: 'Over the whole run' }),
        this.toggle,
      ]),
      this.readout,
      this.plot,
      this.tableWrap,
    );
    this.plot.append(this.svgRoot);

    this.svgRoot.addEventListener('pointermove', (ev) => this.onMove(ev));
    this.svgRoot.addEventListener('pointerleave', () => {
      this.hoverBucket = -1;
      this.readout.textContent = '';
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
      out.push({ hours: rad[0].hour, label: rad.length > 1 ? `radiation ×${rad.length}` : 'radiation' });
    }
    return out;
  }

  setHighlight(causeId: number): void {
    if (causeId === this.highlighted) return;
    this.highlighted = causeId;
    this.render();
  }

  update(stats: CauseStats): void {
    this.latest = stats;
    this.render();
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
    const buckets = this.latest.buckets;
    const innerW = Math.max(80, this.width - PAD.left - PAD.right);
    const innerH = HEIGHT - PAD.top - PAD.bottom;

    let peak = 0;
    for (const b of buckets) {
      let t = 0;
      for (const id of this.causeIds) t += b.deaths[id];
      if (t > peak) peak = t;
    }
    const yMax = niceMax(peak);
    const yOf = (v: number) => PAD.top + innerH - (v / yMax) * innerH;

    this.svgRoot.setAttribute('width', String(this.width));
    this.svgRoot.setAttribute('height', String(HEIGHT));
    this.svgRoot.replaceChildren();

    /* ---- axes: ticks outside, no gridlines ---- */
    const axis = svg('g', { class: 'axis' });
    axis.append(svg('line', { x1: PAD.left, x2: PAD.left, y1: PAD.top, y2: PAD.top + innerH }));
    axis.append(svg('line', {
      x1: PAD.left, x2: PAD.left + innerW, y1: PAD.top + innerH, y2: PAD.top + innerH,
    }));
    for (const v of [0, yMax / 2, yMax]) {
      const y = yOf(v);
      axis.append(svg('line', { x1: PAD.left - 3, x2: PAD.left, y1: y, y2: y }));
      const t = svg('text', { x: PAD.left - 6, y: y + 3, 'text-anchor': 'end' });
      t.textContent = v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
      axis.append(t);
    }
    const totalDays = Math.max(1, Math.round((this.rules.maxTicks * this.rules.hoursPerTick) / 24));
    const dayStep = totalDays <= 20 ? 5 : totalDays <= 70 ? 10 : 30;
    for (let d = 0; d <= totalDays; d += dayStep) {
      const x = this.xOf((d * 24) / this.rules.hoursPerTick, innerW);
      axis.append(svg('line', { x1: x, x2: x, y1: PAD.top + innerH, y2: PAD.top + innerH + 3 }));
      const t = svg('text', {
        x, y: HEIGHT - 7,
        'text-anchor': d === 0 ? 'start' : 'middle',
      });
      t.textContent = d === 0 ? 'day 0' : String(d);
      axis.append(t);
    }
    this.svgRoot.append(axis);

    /* ---- stacked bands ---- */
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
      const baseline = buckets.map((b) => `${this.xOf(b.tick, innerW).toFixed(1)},${yOf(0).toFixed(1)}`);

      for (let s = this.causeIds.length - 1; s >= 0; s--) {
        const id = this.causeIds[s];
        const upper = points[s];
        const lower = s === 0 ? baseline : points[s - 1];
        const d = `M${upper.join('L')}L${[...lower].reverse().join('L')}Z`;
        const dimmed = this.highlighted >= 0 && this.highlighted !== id;
        this.svgRoot.append(
          svg('path', {
            d,
            fill: this.visuals.causeCss(id),
            'fill-opacity': dimmed ? 0.12 : 0.95,
          }),
        );
      }
      // A hairline of the chart surface separates adjacent bands.
      for (let s = 0; s < this.causeIds.length; s++) {
        this.svgRoot.append(
          svg('path', {
            d: `M${points[s].join('L')}`,
            fill: 'none',
            stroke: 'var(--hull-0)',
            'stroke-width': 1,
          }),
        );
      }

      /* ---- direct labels at the right-hand end ---- */
      /* No direct labels at this width - the list above the chart already names
         every band, and a label here would cover the data it points at. */
      const unusedLabels = true;
      void unusedLabels;
      /*
      const lastIndex = buckets.length - 1;
      const dataX = this.xOf(buckets[lastIndex].tick, innerW);
      const atEdge = dataX > PAD.left + innerW - 4;
      const labelX = (atEdge ? PAD.left + innerW : dataX) + 5;
      const placed: number[] = [];
      for (let s = this.causeIds.length - 1; s >= 0; s--) {
        const id = this.causeIds[s];
        const top = Number(points[s][lastIndex].split(',')[1]);
        const bottom = s === 0 ? yOf(0) : Number(points[s - 1][lastIndex].split(',')[1]);
        if (bottom - top < 9) continue;
        const y = (top + bottom) / 2 + 3;
        if (placed.some((p) => Math.abs(p - y) < 10)) continue;
        placed.push(y);
        const label = svg('text', {
          class: 'series-label',
          x: labelX,
          y,
          fill: this.highlighted >= 0 && this.highlighted !== id ? 'var(--ink-2)' : this.visuals.causeCss(id),
        });
        label.textContent = causeName(this.rules, id);
        this.svgRoot.append(label);
      }
      */
    }

    /* ---- treatment markers, from the schedule in rules.json ---- */
    for (const m of this.markers) {
      const x = this.xOf(m.hours / this.rules.hoursPerTick, innerW);
      if (x > PAD.left + innerW) continue;
      this.svgRoot.append(svg('line', { class: 'marker', x1: x, x2: x, y1: PAD.top, y2: PAD.top + innerH }));
      const t = svg('text', { class: 'marker-label', x: x + 3, y: PAD.top + 8 });
      t.textContent = m.label;
      this.svgRoot.append(t);
    }

    if (this.hoverBucket >= 0 && this.hoverBucket < buckets.length) {
      const x = this.xOf(buckets[this.hoverBucket].tick, innerW);
      this.svgRoot.append(svg('line', { class: 'crosshair', x1: x, x2: x, y1: PAD.top, y2: PAD.top + innerH }));
    }
  }

  /** The per-bucket read-out goes in the header, not in a card over the data. */
  private onMove(ev: PointerEvent): void {
    const stats = this.latest;
    if (!stats || !stats.buckets.length || this.showTable) return;
    const rect = this.svgRoot.getBoundingClientRect();
    const innerW = Math.max(80, this.width - PAD.left - PAD.right);
    const tick = ((ev.clientX - rect.left - PAD.left) / innerW) * this.rules.maxTicks;

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
    const b = stats.buckets[best];
    const rows = this.causeIds
      .map((id) => ({ id, n: b.deaths[id] }))
      .filter((r) => r.n > 0)
      .sort((a, c) => c.n - a.n);
    const total = rows.reduce((a, r) => a + r.n, 0);
    this.readout.textContent = rows.length
      ? `day ${(b.hours / 24).toFixed(1)} · ${count(total)} deaths · ${rows
          .map((r) => `${causeName(this.rules, r.id)} ${count(r.n)}`)
          .join(' · ')}`
      : `day ${(b.hours / 24).toFixed(1)} · no deaths`;
    this.render();
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
        tr.append(el('td', { text: row[id] ? count(row[id]) : '—' }));
      }
      tr.append(el('td', { text: count(total) }));
      body.append(tr);
    }
    this.tableWrap.replaceChildren(
      el('table', { class: 'data' }, [el('thead', {}, [head]), body]),
    );
  }
}

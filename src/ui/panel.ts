import type { FrameStats } from '../render/viewer.js';
import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { SimulationSource } from '../source/types.js';
import type { CauseStats } from '../world/causeStats.js';
import { count, el, fixed, signed, svg } from './dom.js';
import type { WorldCounts } from './counts.js';
import type { History } from './history.js';
import { causeName, cloneName, stateLabel } from './labels.js';
import { TONE } from './tone.js';
import type { Narrative, Story } from './narrative.js';
import { foldTo } from './motion.js';
import { Sparkline } from './sparkline.js';

/** Jargon, explained where it is used rather than in a glossary nobody opens. */
const GLOSSARY: Record<string, string> = {
  arrested: 'Alive, but not dividing — held up by crowding, low oxygen, or the drug.',
  dying: 'Committed to dying. Still occupies space until it is cleared away.',
  necrosis: 'Death from lack of oxygen, in tissue too far from a vessel.',
  apoptosis: 'Orderly self-destruction — what a drug that works makes a cell do.',
  ic50: 'The concentration that halves a cell population. Higher means harder to kill.',
  clone: 'A lineage of cells sharing the same mutations.',
};

function term(text: string, key: keyof typeof GLOSSARY | string): HTMLElement {
  const t = el('span', { class: 'term', text });
  const explain = GLOSSARY[key.toLowerCase()];
  if (explain) t.title = explain;
  return t;
}

function chevron(): SVGElement {
  const s = svg('svg', { class: 'chev', viewBox: '0 0 12 12', fill: 'none' });
  s.append(
    svg('path', {
      d: 'M4.5 2.5 L8 6 L4.5 9.5',
      stroke: 'currentColor',
      'stroke-width': 1.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
  return s;
}

/** A collapsible group. The headline answer is in the summary, so it reads closed. */
class Fold {
  readonly node: HTMLDetailsElement;
  readonly body = el('div', { class: 'fold-body' });
  private summary = el('span', { class: 'sum' });

  constructor(title: string, open = false) {
    const head = el('summary', {}, [
      chevron(),
      el('span', { text: title }),
      this.summary,
    ]);
    this.node = el('details', { class: 'fold' }, [head, this.body]) as HTMLDetailsElement;
    this.node.open = open;

    /* <details> has no animatable height of its own, so the open is deferred
       until the body has been measured and the close waits for the animation
       before the element actually collapses. */
    head.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (this.node.open) {
        foldTo(this.body, false);
        window.setTimeout(() => {
          this.node.open = false;
          this.body.style.height = '';
        }, 220);
      } else {
        this.node.open = true;
        this.body.style.height = '';
        foldTo(this.body, true);
      }
    });
  }

  set(text: string): void {
    this.summary.textContent = text;
  }
}

export interface PanelHandlers {
  onHighlightCause(causeId: number): void;
  onCopyState(): void;
  onExportFrame(): void;
  onExportParameters(): void;
}

/**
 * The one panel.
 *
 * It answers the common question without being opened - how many cells, which
 * way is it going - and keeps everything else exactly one disclosure away.
 * The previous version put forty numbers on screen at the same weight, which
 * is the same as showing none of them.
 */
export class Panel {
  private heroValue = el('div', { class: 'value' });
  private heroTrend = el('span', { class: 'trend' });
  private heroNote = el('span', { class: 'muted' });

  private makeup = new Fold('What it is made of', true);
  private makeupStrip = el('div', { class: 'dots' });
  private makeupKey = el('div');
  private stateStrip = el('div', { class: 'dots' });
  private stateKey = el('div');

  private deaths = new Fold('Why cells are dying');
  private deathsBody = el('div');
  private arrestBody = el('div');

  private chemistry = new Fold('Drug in the blood');
  private chemistryBody = el('div');

  private about = new Fold('About this run');

  private cloneBars = new Map<number, HTMLElement>();
  private cloneRows = new Map<number, { row: HTMLElement; n: Text; tag: HTMLElement }>();
  private stateBars = new Map<number, HTMLElement>();
  private stateRows = new Map<number, { row: HTMLElement; n: Text }>();
  private causeRows = new Map<number, { row: HTMLElement; n: Text }>();
  private plasma = new Map<number, { row: HTMLElement; v: Text; spark: Sparkline }>();
  private livingSpark = new Sparkline();
  private highlighted = -1;
  private lastView = '';

  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
    private narrative: Narrative,
    private handlers: PanelHandlers,
  ) {
    /* ---- hero ---- */
    this.root.append(
      el('div', { class: 'block hero' }, [
        el('div', { class: 'label', text: 'Living cells' }),
        this.heroValue,
        el('div', { class: 'under' }, [this.heroTrend, this.livingSpark.node, this.heroNote]),
      ]),
    );

    /* ---- composition ---- */
    this.makeup.body.append(
      el('div', { class: 'muted', style: 'margin-bottom:2px', text: 'Lineages' }),
      this.makeupStrip,
      this.makeupKey,
      el('div', { class: 'muted', style: 'margin:14px 0 2px' }, [
        document.createTextNode('State — '),
        term('cycling, arrested, dying', 'arrested'),
      ]),
      this.stateStrip,
      this.stateKey,
    );

    for (const clone of this.rules.raw.clones) {
      const bar = el('i');
      bar.hidden = true;
      this.cloneBars.set(clone.id, bar);
      this.makeupStrip.append(bar);

      const n = document.createTextNode('0');
      const tag = el('span', { class: 'muted', style: 'font-size:11px' });
      const row = el('div', { class: 'keyline' }, [
        el('span', { class: 'sw' }),
        el('span', { class: 'n' }, [document.createTextNode(cloneName(this.rules, clone.id)), tag]),
        el('span', { class: 'c' }, [n]),
      ]);
      this.cloneRows.set(clone.id, { row, n, tag });
      this.makeupKey.append(row);
    }

    const shades = ['#e4e8ef', '#97a1b1', '#6d7686', '#4a5260'];
    this.rules.raw.states.forEach((state, i) => {
      const shade = shades[Math.min(i, shades.length - 1)];
      const bar = el('i');
      bar.style.background = shade;
      bar.hidden = true;
      this.stateBars.set(state.id, bar);
      this.stateStrip.append(bar);
      const sw = el('span', { class: 'sw' });
      sw.style.background = shade;
      const n = document.createTextNode('0');
      const row = el('div', { class: 'keyline' }, [
        sw,
        el('span', { class: 'n' }, [term(stateLabel(this.rules, state.id), state.name)]),
        el('span', { class: 'c' }, [n]),
      ]);
      this.stateRows.set(state.id, { row, n });
      this.stateKey.append(row);
    });

    /* ---- deaths ---- */
    this.deaths.body.append(
      el('div', { class: 'muted', style: 'margin-bottom:4px', text: 'Deaths in the last day' }),
      this.deathsBody,
      el('div', { class: 'muted', style: 'margin:14px 0 4px' }, [
        term('Not dividing', 'arrested'),
        document.createTextNode(' right now'),
      ]),
      this.arrestBody,
    );
    for (const cause of this.rules.raw.causes) {
      if (cause.kind !== 'death' && cause.kind !== 'arrest') continue;
      const n = document.createTextNode('0');
      const sw = el('span', { class: 'sw' });
      sw.style.background = this.visuals.causeCss(cause.id);
      const row = el('div', { class: 'keyline mut' }, [
        sw,
        el('span', { class: 'n' }, [term(causeName(this.rules, cause.id), cause.name)]),
        el('span', { class: 'c' }, [n]),
      ]);
      row.hidden = true;
      if (cause.kind === 'death') {
        row.addEventListener('pointerenter', () => this.handlers.onHighlightCause(cause.id));
        row.addEventListener('pointerleave', () => this.handlers.onHighlightCause(-1));
        this.deathsBody.append(row);
      } else {
        this.arrestBody.append(row);
      }
      this.causeRows.set(cause.id, { row, n });
    }

    /* ---- chemistry ---- */
    this.chemistry.body.append(this.chemistryBody);

    /* ---- about ---- */
    const g = this.rules.raw.grid;
    const line = (k: string, v: string) =>
      el('div', { class: 'r mono' }, [
        el('span', { class: 'k', text: k }),
        el('span', { class: 'v', text: v }),
      ]);
    const aboutRows: HTMLElement[] = [
      line('seed', String(this.rules.raw.seed)),
      line('grid', `${g.nx}×${g.ny}×${g.nz} @ ${g.voxelMicrons} µm`),
      line('tick', `${this.rules.raw.time.tickMinutes} min`),
    ];
    for (const s of this.rules.raw.treatment?.schedule ?? []) {
      const d = this.rules.drugById.get(s.drug);
      aboutRows.push(line('dose', `${d?.name ?? s.drug} q${s.everyHours}h from day ${Math.round(s.startHour / 24)}`));
    }
    const exportRow = el('div', { style: 'display:flex;gap:6px;margin-top:12px' });
    for (const [label, fn] of [
      ['Copy state', handlers.onCopyState],
      ['Save image', handlers.onExportFrame],
      ['Parameters', handlers.onExportParameters],
    ] as [string, () => void][]) {
      const b = el('button', { class: 'btn ghost', type: 'button', text: label });
      b.style.flex = '1';
      b.addEventListener('click', fn);
      exportRow.append(b);
    }
    this.about.body.append(
      ...aboutRows,
      exportRow,
      el('p', { class: 'note', style: 'margin-top:14px' }, [
        el('b', { text: 'Illustrative: ' }),
        document.createTextNode(
          'membrane outlines, the texture on the distant surface, and red blood cell motion. ' +
            'Everything else is one drawn cell per occupied voxel, with its own state.',
        ),
      ]),
    );

    this.root.append(this.makeup.node, this.deaths.node, this.chemistry.node, this.about.node);
  }

  /** The chart belongs inside the question it answers. */
  appendChart(node: HTMLElement): void {
    this.deaths.body.append(node);
  }

  setHighlight(causeId: number): void {
    this.highlighted = causeId;
    for (const [id, entry] of this.causeRows) {
      entry.row.classList.toggle('dim', causeId >= 0 && causeId !== id && !entry.row.hidden);
    }
  }

  update(
    source: SimulationSource,
    history: History,
    stats: CauseStats,
    frame: FrameStats | undefined,
    viewName: string,
    story: Story,
  ): void {
    const counts = history.latest;
    if (!counts) return;

    /* ---- hero ---- */
    this.heroValue.textContent = count(counts.living);
    const change = history.changePerDay('living');
    if (change === undefined) {
      this.heroTrend.textContent = '';
    } else {
      this.heroTrend.textContent = `${signed(change)} today`;
      /* The trend takes the headline's colour rather than a rule of its own.
         Green for "the tumour grew" would read as good news, which it is not;
         tying the two together means they can never disagree. */
      this.heroTrend.style.color = TONE[story.tone];
    }
    this.livingSpark.update(history.values('living'));
    this.heroNote.textContent = counts.dying ? `· ${count(counts.dying)} dying` : '';

    this.updateMakeup(counts, viewName);
    this.updateCauses(stats);
    this.updateChemistry(source, history);
    this.updateAbout(frame);
  }

  private updateMakeup(counts: WorldCounts, viewName: string): void {
    const living = Math.max(1, counts.living);
    const view = this.visuals.view(viewName);
    const viewChanged = viewName !== this.lastView;
    this.lastView = viewName;

    let lead = { id: -1, n: -1 };
    for (const [id, bar] of this.cloneBars) {
      const n = counts.byClone.get(id) ?? 0;
      if (n > lead.n) lead = { id, n };
      const color = view.cloneColors[String(id)] ?? this.visuals.cloneCss(id);
      bar.hidden = n <= 0;
      bar.style.width = `${(100 * n) / living}%`;
      bar.style.background = color;
      const entry = this.cloneRows.get(id)!;
      entry.n.nodeValue = count(n);
      entry.row.style.opacity = n > 0 ? '1' : '0.42';
      // Say which lineages the drug cannot touch; that is the whole plot.
      entry.tag.textContent = this.narrative.isResistant(id) ? '  resistant' : '';
      entry.tag.style.color = this.narrative.isResistant(id) ? 'var(--resist)' : '';
      if (viewChanged) {
        const sw = entry.row.firstElementChild as HTMLElement;
        sw.style.background = color;
      }
    }
    this.makeup.set(lead.id >= 0 && lead.n > 0 ? cloneName(this.rules, lead.id) : '—');

    const total = Math.max(1, counts.total);
    for (const [id, bar] of this.stateBars) {
      const n = counts.byState.get(id) ?? 0;
      bar.hidden = n <= 0;
      bar.style.width = `${(100 * n) / total}%`;
      bar.title = `${stateLabel(this.rules, id)} ${count(n)}`;
      const entry = this.stateRows.get(id);
      if (entry) {
        entry.n.nodeValue = count(n);
        entry.row.style.opacity = n > 0 ? '1' : '0.42';
      }
    }
  }

  private updateCauses(stats: CauseStats): void {
    let topDeath = { id: -1, n: 0 };
    let deathTotal = 0;
    for (const cause of this.rules.raw.causes) {
      const entry = this.causeRows.get(cause.id);
      if (!entry) continue;
      const n = cause.kind === 'death' ? stats.window[cause.id] : stats.stateChanges[cause.id];
      entry.row.hidden = n <= 0;
      if (n > 0) entry.n.nodeValue = count(n);
      if (cause.kind === 'death' && n > 0) {
        deathTotal += n;
        if (n > topDeath.n) topDeath = { id: cause.id, n };
      }
    }
    this.deaths.set(
      deathTotal ? `${count(deathTotal)} · ${causeName(this.rules, topDeath.id)}` : 'none today',
    );
    this.setHighlight(this.highlighted);
  }

  private updateChemistry(source: SimulationSource, history: History): void {
    const stats = source.stats?.();
    if (!stats || !stats.plasma.size) {
      this.chemistry.node.hidden = true;
      return;
    }
    this.chemistry.node.hidden = false;
    let summary = '';
    for (const [drugId, conc] of stats.plasma) {
      let entry = this.plasma.get(drugId);
      if (!entry) {
        const spark = new Sparkline();
        const v = document.createTextNode('');
        const drug = this.rules.drugById.get(drugId);
        const row = el('div', { class: 'r' }, [
          el('span', { class: 'k', text: drug?.displayName ?? drug?.name ?? `drug ${drugId}` }),
          spark.node,
          el('span', { class: 'v' }, [v, el('span', { class: 'u', text: ' × IC50' })]),
        ]);
        entry = { row, v, spark };
        this.plasma.set(drugId, entry);
        this.chemistryBody.append(row);
      }
      entry.spark.update(history.values(`plasma:${drugId}`));
      entry.v.nodeValue = fixed(conc, 2);
      if (!summary) summary = fixed(conc, 2);
    }
    this.chemistry.set(summary ? `${summary} × IC50` : '');
    this.chemistry.body.title = GLOSSARY.ic50;
  }

  private updateAbout(frame: FrameStats | undefined): void {
    if (!frame) return;
    this.about.set(`${Math.round(1000 / Math.max(1, frame.frameMs))} fps`);
  }
}

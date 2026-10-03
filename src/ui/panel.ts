import type { FrameStats } from '../render/viewer.js';
import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { SimulationSource } from '../source/types.js';
import type { ExperimentParams } from '../experimentParams.js';
import type { CauseStats } from '../world/causeStats.js';
import { count, el, fixed, signed, svg } from './dom.js';
import type { WorldCounts } from './counts.js';
import type { History } from './history.js';
import { causeName, cloneName, stateLabel } from './labels.js';
import { TONE } from './tone.js';
import type { Narrative, Story } from './narrative.js';
import { ExperimentPanel } from './experiment.js';
import { foldTo } from './motion.js';
import { Sparkline } from './sparkline.js';
import {
  evidenceLevel, readingAfter, readingAt,
  type CloneReading, type MetricsRow, type RunMetrics, type RunProvenance,
} from './runMetrics.js';

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
  readonly title: string;
  private summary = el('span', { class: 'sum' });

  constructor(title: string, open = false) {
    this.title = title;
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
  onRunExperiment(params: ExperimentParams): void;
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

  private setup = new Fold('Set up an experiment');
  private experiment: ExperimentPanel;
  private about = new Fold('About this run');

  /* evolutionary control: the resistance graph, the parameters' evidence, the controller */
  private graph = new Fold('Resistance graph');
  private graphBody = el('div', { class: 'tree' });
  private graphNodes = new Map<number, { count: Text; margin: HTMLElement; distance: Text; best: Text; row: HTMLElement }>();
  private evidence = new Fold('Parameters & evidence');
  private controller = new Fold('Controller');
  private controllerBody = el('div');
  private controllerNow = el('div', { class: 'ctl-now' });
  private metrics: RunMetrics | undefined;
  private provenance: RunProvenance = {};
  private lastReading: MetricsRow | undefined;

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
    /** Which groups were open before a rebuild, so the place is not lost. */
    openFolds: Record<string, boolean> = {},
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

    /* ---- the experiment: the only controls that change what is simulated ---- */
    this.experiment = new ExperimentPanel(rules, { onRun: handlers.onRunExperiment });
    this.setup.body.append(this.experiment.node);
    this.setup.set(this.experiment.summary());

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

    this.buildGraph();
    this.buildEvidence();
    this.controller.body.append(this.controllerBody, this.controllerNow);
    this.controller.node.hidden = true;

    this.root.append(
      this.makeup.node, this.graph.node, this.deaths.node, this.chemistry.node,
      this.controller.node, this.evidence.node, this.setup.node, this.about.node,
    );

    /* Running an experiment rebuilds this panel, and collapsing whatever the
       person had open would throw away their place in it. */
    for (const fold of this.folds()) {
      const wanted = openFolds[fold.title];
      if (wanted !== undefined) fold.node.open = wanted;
    }
  }

  private folds(): Fold[] {
    return [this.makeup, this.graph, this.deaths, this.chemistry, this.controller, this.evidence, this.setup, this.about];
  }

  /** Which groups are open, to carry across a rebuild. */
  foldState(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const fold of this.folds()) out[fold.title] = fold.node.open;
    return out;
  }

  dispose(): void {
  }

  /* ---- resistance graph (section 62): the clone tree with live abundance and the control metrics ---- */
  private buildGraph(): void {
    const clones = this.rules.raw.clones;
    const children = new Map<number | undefined, typeof clones>();
    for (const c of clones) {
      const parent = c.derivesFrom;
      const list = children.get(parent) ?? [];
      list.push(c);
      children.set(parent, list);
    }
    const walk = (parent: number | undefined, depth: number) => {
      for (const c of children.get(parent) ?? []) {
        const sw = el('span', { class: 'sw' });
        sw.style.background = this.visuals.cloneCss(c.id);
        const count = document.createTextNode('0');
        const margin = el('span', { class: 'm' });
        const distance = document.createTextNode('');
        const best = document.createTextNode('');
        const row = el('div', { class: 'node' }, [
          el('span', { class: 'branch', text: depth === 0 ? '' : '└─' }),
          sw,
          el('span', { class: 'n' }, [
            el('span', { class: 'name', text: cloneName(this.rules, c.id) }),
            el('span', { class: 'sub mono' }, [
              document.createTextNode('M '), margin,
              document.createTextNode('  D '), distance,
            ]),
            el('span', { class: 'sub' }, [el('span', { class: 'muted', text: 'best: ' }), best]),
          ]),
          el('span', { class: 'c' }, [count]),
        ]);
        row.style.paddingLeft = `${depth * 14}px`;
        this.graphNodes.set(c.id, { count, margin, distance, best, row });
        this.graphBody.append(row);
        walk(c.id, depth + 1);
      }
    };
    walk(undefined, 0);
    this.graph.body.append(
      this.graphBody,
      el('p', { class: 'note', style: 'margin-top:10px' }, [
        el('b', { text: 'M ' }),
        document.createTextNode('is the control margin: how fast the clone shrinks under the best represented treatment (positive = treatment-controllable, negative = treatment-exhausted under the modelled set). '),
        el('b', { text: 'D ' }),
        document.createTextNode('is the evolutionary distance to an exhausted clone under the treatment given that day; "∞" means no modelled route. Simulator quantities, not clinical ones.'),
      ]),
    );
    this.graph.node.hidden = true;
  }

  /* ---- parameters & evidence (section 63): every number with its source and confidence ---- */
  private buildEvidence(): void {
    const body = el('div');
    let shown = 0;
    const badge = (record: { evidence?: string; status?: string; source?: string } | undefined) => {
      const level = evidenceLevel(record);
      const b = el('span', { class: `ev ev-${level.toLowerCase() || 'none'}`, text: level || '—' });
      if (record?.source) b.title = String(record.source);
      return b;
    };
    const row = (label: string, value: string, record: { evidence?: string; status?: string; source?: string } | undefined) => {
      const r = el('div', { class: 'r ev-row' }, [
        el('span', { class: 'k', text: label }),
        el('span', { class: 'v mono', text: value }),
        badge(record),
      ]);
      if (record?.source) r.title = String(record.source);
      return r;
    };
    for (const clone of this.rules.raw.clones) {
      const prov = (clone as unknown as { provenance?: Record<string, any> }).provenance;
      if (!prov) continue;
      const head = el('div', { class: 'ev-clone' }, [
        (() => { const sw = el('span', { class: 'sw' }); sw.style.background = this.visuals.cloneCss(clone.id); return sw; })(),
        el('span', { text: cloneName(this.rules, clone.id) }),
      ]);
      body.append(head);
      const growth = prov.growth_rate_per_day;
      if (growth) { body.append(row('division rate', `${fixed(Number(growth.value), 3)} /day`, growth)); shown++; }
      const cost = prov.fitness_cost;
      if (cost && Number(cost.value) > 0) { body.append(row('fitness cost', fixed(Number(cost.value), 2), cost)); shown++; }
      const ic50s = prov.ic50_nM as Record<string, any> | undefined;
      for (const [drugName, record] of Object.entries(ic50s ?? {})) {
        const drug = [...this.rules.drugById.values()].find((d) => d.name === drugName);
        const unit = String(record.unit ?? 'nM');
        const value = Number(record.value);
        const text = unit.startsWith('normalized') ? `${fixed(value, 2)} (norm.)` : `${value >= 100 ? Math.round(value) : fixed(value, value < 1 ? 2 : 1)} ${unit}`;
        body.append(row(`${(drug?.displayName ?? drugName).replace(/\s*\(.*\)\s*$/, '')} IC50`, text, record));
        shown++;
        for (const [key, label] of [['growth_inhibition', 'growth inhibition'], ['max_death_rate_per_day', 'kill rate'], ['fitness_cost_relief', 'cost relief']] as const) {
          const extra = record[key];
          if (extra) { body.append(row(`  ${label}`, key === 'max_death_rate_per_day' ? `${fixed(Number(extra.value), 2)} /day` : fixed(Number(extra.value), 2), extra)); shown++; }
        }
      }
    }
    if (!shown) {
      this.evidence.node.hidden = true;
      return;
    }
    this.evidence.set(`${shown} values`);
    this.evidence.body.append(
      body,
      el('p', { class: 'note', style: 'margin-top:10px' }, [
        el('b', { text: 'DIRECT ' }), document.createTextNode('measured in a relevant system · '),
        el('b', { text: 'DERIVED ' }), document.createTextNode('combined from measurements · '),
        el('b', { text: 'INFERRED ' }), document.createTextNode('supported, not measured here · '),
        el('b', { text: 'ASSUMPTION ' }), document.createTextNode('a model choice to be randomised. Hover a row for the source.'),
      ]),
    );
  }

  /* ---- controller (section 64): which policy or strategy drove the run, and what it did today ---- */
  setRunMetrics(metrics: RunMetrics | undefined, provenance: RunProvenance | undefined): void {
    this.metrics = metrics;
    this.provenance = provenance ?? {};
    this.graph.node.hidden = !metrics && !this.provenance.controllability;
    const policy = this.provenance.policy;
    const strategy = this.provenance.strategy;
    const line = (k: string, v: string) =>
      el('div', { class: 'r' }, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })]);
    this.controllerBody.replaceChildren();
    if (policy) {
      this.controllerBody.append(
        line('Policy', policy.name),
        line('Training cancer', policy.training_cancer_name ?? policy.training_cancer),
        line('Training uncertainty', policy.training_uncertainty),
        line('Objective', policy.objective),
        line('Actions', policy.actions ? `${policy.actions} discrete exposure combinations` : '—'),
      );
      this.controller.set(policy.name);
    } else if (strategy) {
      this.controllerBody.append(
        line('Strategy', strategy.schedule),
        line('Kind', String((strategy.spec as { type?: string } | undefined)?.type ?? 'fixed schedule')),
        line('Declared in', (strategy.declared_in ?? 'the cancer model').split('/').pop() ?? ''),
      );
      this.controller.set(strategy.schedule);
    }
    this.controllerBody.append(
      el('p', { class: 'note', style: 'margin-top:10px' }, [
        el('b', { text: 'Note: ' }),
        document.createTextNode('this explains what the simulator policy did and the metrics it saw. It is not a clinical rationale.'),
      ]),
    );
    this.controller.node.hidden = !(policy || strategy);
    if (this.provenance.controllability) this.renderReading(this.provenance.controllability, undefined, undefined);
  }

  private updateEvolution(day: number | undefined, counts: WorldCounts): void {
    if (!this.metrics || day === undefined) {
      // no per-day readings: keep the initial-state values but show live counts
      for (const [id, node] of this.graphNodes) node.count.nodeValue = count(counts.byClone.get(id) ?? 0);
      return;
    }
    const reading = readingAt(this.metrics, day);
    if (!reading) return;
    const next = readingAfter(this.metrics, reading);
    if (reading !== this.lastReading) {
      this.lastReading = reading;
      this.renderReading(reading, next, day);
    }
    for (const [id, node] of this.graphNodes) node.count.nodeValue = count(counts.byClone.get(id) ?? 0);
  }

  private renderReading(reading: MetricsRow, next: MetricsRow | undefined, day: number | undefined): void {
    let exhausted = 0;
    for (const [id, node] of this.graphNodes) {
      const r: CloneReading | undefined = reading.clones[String(id)];
      if (!r) continue;
      node.margin.textContent = `${r.margin >= 0 ? '+' : ''}${fixed(r.margin, 3)}`;
      node.margin.className = `m ${r.margin > 0.01 ? 'm-pos' : r.margin < -0.01 ? 'm-neg' : 'm-zero'}`;
      node.margin.title = r.margin > 0.01 ? 'treatment-controllable' : r.margin < -0.01 ? 'treatment-exhausted under the modelled set' : 'at the controllability boundary';
      node.distance.nodeValue = r.escape_distance === null ? '∞' : fixed(r.escape_distance, 1);
      node.best.nodeValue = r.best_action;
      if (r.exhausted) exhausted++;
    }
    this.graph.set(`ECI ${fixed(reading.eci, 2)}${exhausted ? ` · ${exhausted} exhausted` : ''}`);

    if (this.controller.node.hidden) return;
    const action = reading.action ?? Object.entries(reading.exposures).map(([d, x]) => `${d} ${Math.round(x * 100)}%`).join(' + ');
    const esr1 = reading.resistant_fraction;
    const parts: (Node | string)[] = [];
    parts.push(el('div', { class: 'label', text: day === undefined ? 'At the start' : `Day ${Math.floor(reading.day)}` }));
    parts.push(el('div', { class: 'act', text: action || 'no treatment' }));
    const eciText = next ? `ECI ${fixed(reading.eci, 2)} → ${fixed(next.eci, 2)}` : `ECI ${fixed(reading.eci, 2)}`;
    parts.push(el('div', { class: 'mono muted', text: eciText + (esr1 !== undefined ? ` · resistant ${(100 * esr1).toFixed(1)}%` : '') }));
    this.controllerNow.replaceChildren(...parts);
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
    day?: number,
  ): void {
    const counts = history.latest;
    if (!counts) return;
    this.updateEvolution(day, counts);

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
    this.updateSetup();
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

  private updateSetup(): void {
    this.setup.set(this.experiment.summary());
  }

  private updateAbout(frame: FrameStats | undefined): void {
    if (!frame) return;
    this.about.set(`${Math.round(1000 / Math.max(1, frame.frameMs))} fps`);
  }
}

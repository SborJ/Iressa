/**
 * The AI add-on: a REINFORCE agent learning a treatment pattern, shown on the
 * bio world while it learns.
 *
 * The agent practises in Python (scripts/train_reinforce.py, via /api/ai on the
 * dev server). After each update it records one practice run on a 3D tumour,
 * and this overlay plays the newest one in the world view, so the tumour on
 * screen is always the agent's latest attempt: random at first, then settling
 * into a pattern. Beside it, its "brain" (the linear policy's weights), what it
 * now prefers, and the learning curve update as it goes. At the end it plays the
 * learned pattern on a tumour it never practised on and compares it with the
 * model's fixed strategies.
 */
import { el, svg } from './dom.js';

interface Update {
  update: number; episodes: number; seconds: number; mean_return: number; best_return: number;
  entropy: number; probs_start: number[]; probs_middle: number[]; weights: number[][];
}
interface Decision { day: number; regimen: string; action: number; text: string }
interface Showcase {
  kind: 'practice' | 'final'; update: number; episodes: number; viewer_url: string;
  decisions: Decision[]; choices: number[]; final_ratio: number; final_resistant: number;
}
interface Row { policy: string; burden_auc_median: number; control_days_median: number; final_resistant_median: number }
interface Evaluation { verdict: string; pattern: string[]; summary: Row[]; seeds: number[] }
interface Status {
  state: 'idle' | 'running' | 'completed' | 'stopped' | 'failed';
  message: string;
  seconds?: number;
  startedAt?: number;
  start?: { regimens: string[]; features: string[]; decision_days: number; days: number };
  updates: Update[];
  showcases: Showcase[];
  evaluation?: Evaluation;
}

export interface AiHandlers {
  /** The cancer on screen, which the agent trains on. */
  cancer(): string;
  /** Load a recorded run into the 3D world and play it at `speed` ticks per second. */
  play(url: string, speed: number): Promise<void>;
  /** Back to the cancer's demo run. */
  home(): void;
}

const COLORS = ['#828b9a', '#46b6c6', '#8b93f2', '#e8a33d', '#c77dd8', '#5bbdad', '#e5705f', '#9ccf6a'];
/** What the policy looks at, grouped for the drawing. */
const GROUPS: [string, (feature: string) => boolean][] = [
  ['Tumour size', (f) => f === 'size_change' || f === 'log_size'],
  ['Resistance', (f) => f === 'resistant_share' || f.startsWith('share_')],
  ['Time', (f) => f === 'time'],
  ['Last drug', (f) => f.startsWith('previous_')],
];
const BUDGETS = [15, 30, 45, 60];

export class AiAgent {
  private button = el('button', { type: 'button', class: 'ai-button', title: 'Watch a REINFORCE agent learn a treatment pattern' });
  private hud = el('aside', { class: 'ai-hud', 'aria-label': 'AI agent' });
  private banner = el('div', { class: 'ai-banner' });
  private stateChip = el('span', { class: 'ai-chip' });
  private message = el('div', { class: 'ai-message' });
  private setup = el('div', { class: 'ai-setup' });
  private live = el('div', { class: 'ai-live' });
  private result = el('div', { class: 'ai-result' });
  private brain = svg('svg', { class: 'ai-brain', viewBox: '0 0 280 150' }) as SVGSVGElement;
  private bars = el('div', { class: 'ai-bars' });
  private curve = svg('svg', { class: 'ai-curve', viewBox: '0 0 280 64', preserveAspectRatio: 'none' }) as SVGSVGElement;
  private stats = el('div', { class: 'ai-stats' });
  private progress = el('div', { class: 'ai-progress' }, [el('i')]);
  private playing = el('div', { class: 'ai-playing' });
  private budget = 45;
  private status?: Status;
  private poll?: number;
  private edges: SVGLineElement[][] = [];
  private outputs: SVGCircleElement[] = [];
  private builtFor = '';
  /** What the world is showing, and whether it has played to the end. */
  private shown?: Showcase;
  private ended = true;
  private loading = false;
  private finalPlayed = false;
  /** The training session this page started or watched; an older session's runs are not auto-played. */
  private session?: number;

  constructor(host: HTMLElement, stage: HTMLElement, private handlers: AiHandlers) {
    this.button.append(orb(), el('span', { text: 'AI agent' }));
    host.append(this.button);
    this.button.addEventListener('click', () => this.toggle());

    const close = el('button', { type: 'button', class: 'ai-close', title: 'Hide', text: '×' });
    close.addEventListener('click', () => this.toggle(false));
    this.hud.append(
      el('div', { class: 'ai-head' }, [orb(), el('div', { class: 'ai-title' }, [
        el('strong', { text: 'REINFORCE agent' }), el('span', { text: 'learning a treatment pattern by trial and error' }),
      ]), this.stateChip, close]),
      this.message, this.setup, this.live, this.result,
    );
    this.hud.hidden = true;
    this.banner.hidden = true;
    stage.append(this.hud, this.banner);
    this.buildSetup();
  }

  /** The world finished playing the run it was given. */
  runEnded(): void {
    this.ended = true;
    this.next();
  }

  private toggle(open = this.hud.hidden): void {
    this.hud.hidden = !open;
    this.button.setAttribute('aria-pressed', String(open));
    if (open) void this.refresh();
  }

  private buildSetup(): void {
    const seg = el('div', { class: 'seg ai-budget', role: 'group', 'aria-label': 'Training time' });
    for (const s of BUDGETS) {
      const b = el('button', { type: 'button', text: `${s} s` });
      b.setAttribute('aria-pressed', String(s === this.budget));
      b.addEventListener('click', () => {
        this.budget = s;
        for (const other of seg.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === b));
      });
      seg.append(b);
    }
    const start = el('button', { type: 'button', class: 'btn primary', text: 'Start learning' });
    start.addEventListener('click', () => void this.start());
    this.setup.append(
      el('p', { class: 'ai-note', text:
        'The agent practises on hundreds of simulated tumours, choosing a regimen every 10 days and ' +
        'scoring each run on how small the tumour stays and how little resistance it breeds. ' +
        'The world view plays its latest attempt as it learns.' }),
      el('div', { class: 'ai-row' }, [seg, start]),
    );
  }

  private async start(): Promise<void> {
    this.finalPlayed = false;
    this.shown = undefined;
    this.ended = true;
    this.builtFor = '';
    this.result.replaceChildren();
    try {
      const response = await fetch('/api/ai/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancer: this.handlers.cancer(), seconds: this.budget }),
      });
      const data = await response.json() as Status & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
      this.session = data.startedAt;
      this.render(data);
    } catch (error) {
      this.message.textContent = error instanceof Error ? error.message : String(error);
    }
    this.startPolling();
  }

  private async stop(): Promise<void> {
    await fetch('/api/ai/stop', { method: 'POST' }).catch(() => undefined);
    void this.refresh();
  }

  private startPolling(): void {
    window.clearInterval(this.poll);
    this.poll = window.setInterval(() => void this.refresh(), 600);
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch('/api/ai/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const status = await response.json() as Status;
      this.render(status);
      if (status.state === 'running') { if (this.poll === undefined) this.startPolling(); }
      else { window.clearInterval(this.poll); this.poll = undefined; }
    } catch {
      this.stateChip.textContent = 'Offline';
      this.message.textContent = 'The AI agent needs the local dev server (npm run dev).';
      window.clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private render(status: Status): void {
    this.status = status;
    const running = status.state === 'running';
    if (running) this.session = status.startedAt;
    this.hud.dataset.state = status.state;
    this.button.dataset.state = status.state;
    this.stateChip.textContent = running ? 'Learning' : status.state === 'completed' ? 'Learned'
      : status.state === 'failed' ? 'Failed' : status.state === 'stopped' ? 'Stopped' : 'Ready';
    this.message.textContent = status.state === 'idle' ? '' : status.message;
    this.setup.hidden = running;
    const stopRow = this.live.querySelector<HTMLElement>('.ai-stop');
    if (stopRow) stopRow.hidden = !running;
    this.live.hidden = status.state === 'idle';
    if (status.start && this.builtFor !== status.start.regimens.join('|')) this.buildLive(status);
    const last = status.updates.at(-1);
    if (last) this.drawUpdate(last, status);
    this.drawCurve(status.updates);
    const elapsed = status.startedAt ? (Date.now() - status.startedAt) / 1000 : 0;
    const budget = status.seconds ?? this.budget;
    (this.progress.firstElementChild as HTMLElement).style.width =
      `${status.state === 'completed' ? 100 : Math.min(100, (100 * elapsed) / budget)}%`;
    this.stats.replaceChildren(
      stat('Practice runs', last ? last.episodes.toLocaleString() : '0'),
      stat('Updates', last ? String(last.update) : '0'),
      stat('Time', `${Math.min(elapsed, budget).toFixed(0)} / ${budget} s`),
    );
    this.next();
    if (status.evaluation && !this.result.childElementCount) this.renderResult(status.evaluation);
    if (status.state === 'failed') this.setup.hidden = false;
  }

  private buildLive(status: Status): void {
    const start = status.start!;
    this.builtFor = start.regimens.join('|');
    const stop = el('button', { type: 'button', class: 'btn ghost', text: 'Stop' });
    stop.addEventListener('click', () => void this.stop());
    this.live.replaceChildren(
      this.progress, this.stats,
      el('div', { class: 'ai-label', text: 'Its brain: what it looks at → what it chooses' }), this.brain,
      el('div', { class: 'ai-label', text: 'What it now prefers (top bar: at the start of a run · bottom: mid-run)' }), this.bars,
      el('div', { class: 'ai-label', text: 'Learning curve (score per update; higher is better)' }), this.curve,
      this.playing,
      el('div', { class: 'ai-row ai-stop' }, [stop]),
    );
    // the network: input groups on the left, regimens on the right
    this.brain.replaceChildren();
    this.edges = [];
    this.outputs = [];
    const k = start.regimens.length;
    const inY = (i: number) => 22 + i * (106 / (GROUPS.length - 1));
    const outY = (j: number) => 14 + j * (122 / Math.max(1, k - 1));
    GROUPS.forEach(([, ], i) => {
      const row: SVGLineElement[] = [];
      for (let j = 0; j < k; j++) {
        const line = svg('line', { x1: 86, y1: inY(i), x2: 214, y2: outY(j), class: 'ai-edge' }) as SVGLineElement;
        line.style.animationDelay = `${(-(i * 7 + j * 3) % 10) / 10}s`;
        this.brain.append(line);
        row.push(line);
      }
      this.edges.push(row);
    });
    GROUPS.forEach(([name], i) => {
      this.brain.append(
        svg('circle', { cx: 86, cy: inY(i), r: 5, class: 'ai-in' }),
        label(name, 78, inY(i) + 3.5, 'end'),
      );
    });
    start.regimens.forEach((name, j) => {
      const c = svg('circle', { cx: 214, cy: outY(j), r: 5, fill: COLORS[j % COLORS.length], class: 'ai-out' }) as SVGCircleElement;
      this.outputs.push(c);
      this.brain.append(c, label(shortName(name), 226, outY(j) + 3.5, 'start'));
    });
    // preference bars
    this.bars.replaceChildren();
    start.regimens.forEach((name, j) => {
      const fill = el('i');
      fill.style.background = COLORS[j % COLORS.length];
      const mid = el('b');
      mid.style.background = COLORS[j % COLORS.length];
      this.bars.append(el('div', { class: 'ai-bar' }, [
        el('span', { class: 'ai-bar-name', text: name, title: name }),
        el('span', { class: 'ai-bar-track' }, [fill, mid]),
        el('span', { class: 'ai-bar-val', text: '—' }),
      ]));
    });
  }

  private drawUpdate(update: Update, status: Status): void {
    const features = status.start?.features ?? [];
    const k = update.weights[0]?.length ?? 0;
    // edge strength: summed |weight| from a group to a regimen; colour: its sign
    const strength = GROUPS.map(([, inGroup]) => Array.from({ length: k }, (_, j) =>
      features.reduce((sum, f, row) => sum + (inGroup(f) ? update.weights[row][j] : 0), 0)));
    const max = Math.max(1e-6, ...strength.flat().map(Math.abs));
    strength.forEach((row, i) => row.forEach((w, j) => {
      const line = this.edges[i]?.[j];
      if (!line) return;
      line.style.strokeWidth = (0.4 + (4 * Math.abs(w)) / max).toFixed(2);
      line.style.opacity = (0.15 + (0.8 * Math.abs(w)) / max).toFixed(2);
      line.classList.toggle('neg', w < 0);
    }));
    this.outputs.forEach((c, j) => c.setAttribute('r', (3 + 9 * (update.probs_start[j] ?? 0)).toFixed(1)));
    if (this.brain.dataset.update !== String(update.update)) {
      this.brain.dataset.update = String(update.update);
      this.brain.classList.remove('pulse');
      void this.brain.getBoundingClientRect();
      this.brain.classList.add('pulse');
    }
    [...this.bars.children].forEach((row, j) => {
      const [fill, mid] = row.querySelectorAll<HTMLElement>('.ai-bar-track > *');
      fill.style.width = `${100 * (update.probs_start[j] ?? 0)}%`;
      mid.style.width = `${100 * (update.probs_middle[j] ?? 0)}%`;
      row.querySelector('.ai-bar-val')!.textContent = `${Math.round(100 * (update.probs_start[j] ?? 0))}%`;
    });
  }

  private drawCurve(updates: Update[]): void {
    this.curve.replaceChildren();
    if (updates.length < 2) return;
    const values = updates.map((u) => u.mean_return);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const x = (i: number) => (i / (values.length - 1)) * 276 + 2;
    const y = (v: number) => 58 - ((v - lo) / span) * 52;
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    this.curve.append(
      svg('path', { d: `${d}L${x(values.length - 1)},64L${x(0)},64Z`, class: 'ai-curve-fill' }),
      svg('path', { d, class: 'ai-curve-line' }),
      svg('circle', { cx: x(values.length - 1), cy: y(values.at(-1)!), r: 3, class: 'ai-curve-dot' }),
    );
  }

  /** Put the newest run in the world once the current one has played out (the final one at once). */
  private next(): void {
    const status = this.status;
    if (!status || this.loading || status.startedAt === undefined || status.startedAt !== this.session) return;
    const final = status.showcases.find((s) => s.kind === 'final');
    let pick: Showcase | undefined;
    if (final && !this.finalPlayed) pick = final;
    else if (this.ended && status.state === 'running') {
      const newest = status.showcases.filter((s) => s.kind === 'practice').at(-1);
      if (newest && newest.update !== this.shown?.update) pick = newest;
    }
    if (!pick) return;
    if (pick.kind === 'final') this.finalPlayed = true;
    void this.show(pick);
  }

  private async show(run: Showcase): Promise<void> {
    this.loading = true;
    this.shown = run;
    this.ended = false;
    this.renderPlaying(run);
    try {
      // practice runs flash past; the learned pattern plays slowly enough to follow
      await this.handlers.play(run.viewer_url, run.kind === 'final' ? 128 : 512);
    } finally {
      this.loading = false;
    }
  }

  private renderPlaying(run: Showcase): void {
    const regimens = this.status?.start?.regimens ?? [];
    const days = this.status?.start?.days ?? 60;
    const every = this.status?.start?.decision_days ?? 10;
    const strip = el('div', { class: 'ai-strip' });
    run.choices.forEach((a, i) => {
      const cell = el('span', { title: `day ${i * every}: ${regimens[a] ?? a}` });
      cell.style.background = COLORS[a % COLORS.length];
      cell.style.flex = String(Math.min(every, days - i * every));
      strip.append(cell);
    });
    const title = run.kind === 'final'
      ? 'Now in the world: the learned pattern, on a tumour it never practised on'
      : `Now in the world: practice run after update ${run.update} (still exploring)`;
    this.playing.replaceChildren(
      el('div', { class: 'ai-label', text: title }), strip,
      el('div', { class: 'ai-decisions' }, run.decisions.map((d) => el('div', { text: `day ${d.day}: ${d.text}` }))),
      el('div', { class: 'ai-note', text:
        `Ended at ${run.final_ratio.toFixed(2)}× its starting size, ${Math.round(100 * run.final_resistant)}% resistant cells.` }),
    );
    this.banner.hidden = false;
    this.banner.dataset.kind = run.kind;
    this.banner.replaceChildren(el('i'), document.createTextNode(run.kind === 'final'
      ? 'AI agent · learned pattern'
      : `AI agent · practice run · update ${run.update} · ${run.episodes.toLocaleString()} runs so far`));
  }

  private renderResult(evaluation: Evaluation): void {
    const rows = [...evaluation.summary].sort((a, b) => a.burden_auc_median - b.burden_auc_median);
    const learned = rows.findIndex((r) => r.policy === 'REINFORCE');
    const shown = rows.filter((r, i) => i < 4 || r.policy === 'REINFORCE');
    const table = el('div', { class: 'ai-table' }, [
      el('div', { class: 'ai-tr ai-th' }, [el('span', { text: 'Strategy' }), el('span', { text: 'Tumour size*' }), el('span', { text: 'Days controlled' })]),
      ...shown.map((r) => el('div', { class: `ai-tr${r.policy === 'REINFORCE' ? ' ai-me' : ''}` }, [
        el('span', { text: r.policy === 'REINFORCE' ? 'AI agent (REINFORCE)' : r.policy.replace(/^constant: /, 'always ') }),
        el('span', { text: r.burden_auc_median.toFixed(2) }),
        el('span', { text: r.control_days_median.toFixed(0) }),
      ])),
    ]);
    const replay = el('button', { type: 'button', class: 'btn primary', text: 'Replay learned pattern' });
    replay.addEventListener('click', () => {
      const final = this.status?.showcases.find((s) => s.kind === 'final');
      if (final) void this.show(final);
    });
    const again = el('button', { type: 'button', class: 'btn ghost', text: 'Train again' });
    again.addEventListener('click', () => void this.start());
    const home = el('button', { type: 'button', class: 'btn ghost', text: 'Back to the demo' });
    home.addEventListener('click', () => this.handlers.home());
    this.result.replaceChildren(
      el('div', { class: 'ai-label', text: `What it learned (ranked ${learned + 1} of ${rows.length} on ${evaluation.seeds.length} unseen tumours)` }),
      el('div', { class: 'ai-pattern' }, evaluation.pattern.map((line) => el('div', { text: line }))),
      el('div', { class: 'ai-note', text: evaluation.verdict }),
      table,
      el('div', { class: 'ai-note', text: '* average tumour size over the run, relative to the start (lower is better). Simulation only; not a treatment recommendation.' }),
      el('div', { class: 'ai-row' }, [replay, again, home]),
    );
  }
}

function orb(): SVGElement {
  const s = svg('svg', { class: 'ai-orb', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  s.append(
    svg('circle', { cx: 12, cy: 12, r: 10, class: 'ai-orb-ring' }),
    svg('circle', { cx: 12, cy: 12, r: 6.5, class: 'ai-orb-ring ai-orb-inner' }),
    svg('circle', { cx: 12, cy: 12, r: 2.6, class: 'ai-orb-core' }),
  );
  return s;
}

function label(text: string, x: number, y: number, anchor: 'start' | 'end'): SVGElement {
  const t = svg('text', { x, y, 'text-anchor': anchor, class: 'ai-node-label' });
  t.textContent = text;
  return t;
}

function stat(name: string, value: string): HTMLElement {
  return el('div', { class: 'ai-stat' }, [el('span', { text: name }), el('strong', { text: value })]);
}

/** "osimertinib 100% + capmatinib 50%" -> "osimertinib + capmatinib ½" for the small drawing. */
function shortName(name: string): string {
  return name.replace(/ 100%/g, '').replace(/ 50%/g, ' ½').replace('endocrine suppression', 'endocrine')
    .replace('no treatment', 'nothing');
}

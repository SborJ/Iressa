import { loadData, describeLoadError } from './data.js';
import { Viewer } from './render/viewer.js';
import { FileSource } from './source/fileSource.js';
import { eventsUrl, keyframesUrl, rulesUrl, sourceKind } from './defaultRun.js';
import { LocalSimSource } from './source/localSim.js';
import { SocketSource } from './source/socketSource.js';
import type { SimulationSource } from './source/types.js';
import { applyLocalExperimentOverrides, type ExperimentParams } from './experimentParams.js';
import { resolveRules } from './sim/rules.js';
import { Card, ScaleBar } from './ui/card.js';
import { CauseChart } from './ui/causeChart.js';
import { Controls } from './ui/controls.js';
import { copyText, downloadText, FrameCapture } from './ui/exporters.js';
import { Headline, StageTags } from './ui/headline.js';
import { History } from './ui/history.js';
import { Narrative } from './ui/narrative.js';
import { Panel } from './ui/panel.js';
import { enter } from './ui/motion.js';
import { bindShortcuts } from './ui/shortcuts.js';
import { Timeline } from './ui/timeline.js';
import { CauseStats } from './world/causeStats.js';
import { World } from './world/world.js';

/** How long one frame may spend advancing the simulation. */
const TICK_BUDGET_MS = 10;
/** Picking costs a GPU readback, so it runs well below the frame rate. */
const PICK_INTERVAL_MS = 60;
/** How long a frame may spend skipping ahead, so the page stays responsive. */
const SKIP_BUDGET_MS = 24;

function showError(err: unknown): void {
  const { title, note, problems } = describeLoadError(err);
  document.getElementById('error-title')!.textContent = title;
  document.getElementById('error-note')!.textContent = note;
  const list = document.getElementById('error-list')!;
  list.replaceChildren();
  for (const p of problems) {
    const li = document.createElement('li');
    li.textContent = p;
    list.append(li);
  }
  document.getElementById('error')!.classList.add('on');
  console.error(title, problems);
}

/**
 * The source is chosen by query string:
 *
 *   (default)                             the calibrated Python engine's demo run (src/defaultRun.ts)
 *   ?source=local                         the TypeScript stand-in simulator
 *   ?source=socket&host=…&port=…          the same records, streamed
 *   ?source=file&rules=…&events=…&keyframes=…   any recorded run
 */
async function makeSource(data: Awaited<ReturnType<typeof loadData>>): Promise<SimulationSource> {
  const q = new URLSearchParams(location.search);
  const kind = sourceKind(q);

  if (kind === 'socket') {
    // The Vite dev server returns 403 for query strings containing a ws:// URL, so the
    // stream address may also be given as ?host=…&port=… and is assembled here.
    let url = q.get('url') ?? `ws://${q.get('host') ?? location.hostname}:${q.get('port') ?? '8787'}`;
    if (!/^wss?:\/\//.test(url)) url = `ws://${url}`;
    const source = new SocketSource(data.rules, url);
    await source.connect();
    return source;
  }
  if (kind === 'file') {
    const evUrl = eventsUrl(q);
    const res = await fetch(evUrl);
    if (!res.ok) throw new Error(`cannot load ${evUrl} (${res.status})`);
    const events = new Uint8Array(await res.arrayBuffer());
    const keyframes: Uint8Array[] = [];
    const kfUrl = keyframesUrl(q);
    if (kfUrl) {
      const kr = await fetch(kfUrl);
      if (kr.ok) keyframes.push(new Uint8Array(await kr.arrayBuffer()));
    }
    return new FileSource(data.rules, events, keyframes);
  }
  return new LocalSimSource(data.rules);
}

/**
 * How far back the default view sits, as a multiple of the renderer's own
 * framing distance. Above 1 the specimen has room around it and reads as a
 * sample rather than as a wall of cells.
 */
const STAND_OFF = 1.35;

/** Frames the tumour, then stands back so it is not filling the frame. */
function frameWithRoom(viewer: Viewer): void {
  viewer.frameTumour();
  const target = viewer.controls.target;
  viewer.camera.position.sub(target).multiplyScalar(STAND_OFF).add(target);
  viewer.controls.update();
}

/** The first clause of a view's own description, for the stage label. */
function shortDescription(text: string): string {
  const first = (text.split(/[:.]/)[0] ?? '').trim();
  return first.length > 2 ? first.charAt(0).toLowerCase() + first.slice(1) : text;
}

async function start(): Promise<void> {
  const data = await loadData();
  const { rules, visuals } = data;
  let source = await makeSource(data);

  let framed = false;
  const world = new World(rules);
  let activeRules = rules;
  let stats = new CauseStats(rules);
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const viewer = new Viewer(canvas, world, visuals, rules);

  const q = new URLSearchParams(location.search);
  const sourceLabel = rulesUrl(q).split('/').pop() ?? 'rules.json';
  const history = new History(rules);
  const capture = new FrameCapture();

  const panelRoot = document.getElementById('panel')!;
  const headlineRoot = document.getElementById('headline')!;
  const scaleBar = new ScaleBar(document.getElementById('scalebar')!, rules.raw.grid.voxelMicrons);
  const stageTags = new StageTags(document.getElementById('stagetop')!);

  const subscribe = (s: SimulationSource) =>
    s.onPacket((packet) => {
      world.apply(packet);
      stats.ingest(packet, world);
    });
  let unsubscribe = subscribe(source);

  const resetWorld = () => {
    world.clear();
    world.tick = 0;
    history.reset();
    viewer.displayTick = 0;
    viewer.markDirty();
    framed = false;
  };

  const resetRun = () => {
    unsubscribe();
    source.reset?.();
    resetWorld();
    stats.reset();
    unsubscribe = subscribe(source);
    source.pump(1);
  };

  /* Everything below is rebuilt when an experiment replaces the rules: each of
     these reads the schedule, the clone table or the cause table at
     construction, and a panel still describing the previous run would be
     quietly wrong rather than visibly broken. */
  let narrative = new Narrative(activeRules);
  const headline = new Headline(headlineRoot);
  let card = new Card(document.getElementById('card')!, activeRules, visuals, narrative);
  let chartHost = document.createElement('div');
  let chart: CauseChart;
  let panel: Panel;
  let timeline: Timeline;

  const controlsHost = document.createElement('div');

  const startExperiment = (params: ExperimentParams) => {
    unsubscribe();
    activeRules = resolveRules(applyLocalExperimentOverrides(data.rules.raw, params));
    source = new LocalSimSource(activeRules);
    stats = new CauseStats(activeRules);
    resetWorld();
    buildPanels();
    unsubscribe = subscribe(source);
    source.pump(1);
    controls.setPlaying(true);
    timeline.setPlaying(true);
  };

  function buildPanels(): void {
    const openFolds = panel?.foldState() ?? {};
    narrative = new Narrative(activeRules);
    card = new Card(document.getElementById('card')!, activeRules, visuals, narrative);

    panelRoot.replaceChildren();
    chartHost = document.createElement('div');
    chartHost.id = 'chart';
    chart = new CauseChart(chartHost, activeRules, visuals);

    panel = new Panel(panelRoot, activeRules, visuals, narrative, {
      onHighlightCause: (causeId) => {
        chart.setHighlight(causeId);
        panel.setHighlight(causeId);
      },
      onRunExperiment: startExperiment,
      onCopyState: () => {
        const st = controls.state;
        void copyText(
          JSON.stringify(
            {
              tick: world.tick,
              day: (world.tick * activeRules.hoursPerTick) / 24,
              seed: activeRules.raw.seed,
              rules: sourceLabel,
              source: source.kind,
              view: st.view,
              colorBy: st.colorBy,
              cut: { mode: st.cutMode, fraction: st.cutFraction },
              camera: {
                position: viewer.camera.position.toArray(),
                target: viewer.controls.target.toArray(),
              },
              counts: history.latest && {
                living: history.latest.living,
                dying: history.latest.dying,
                byClone: Object.fromEntries(history.latest.byClone),
              },
            },
            null,
            2,
          ),
        );
      },
      onExportFrame: () => capture.request(),
      onExportParameters: () =>
        downloadText(
          `iressa-parameters-${activeRules.raw.seed}.json`,
          JSON.stringify(activeRules.raw, null, 2),
        ),
    }, openFolds);
    panelRoot.insertBefore(controlsHost, panelRoot.children[1] ?? null);
    panel.appendChart(chartHost);

    const timelineRoot = document.getElementById('timeline')!;
    timelineRoot.replaceChildren();
    timeline = new Timeline(timelineRoot, activeRules, narrative, {
      onTogglePlay: () => controls.togglePlay(),
    });
    timeline.setPlaying(controls.state.playing);
  }

  /**
   * Run ahead without drawing every frame of it.
   *
   * Spread across animation frames on a time budget: pumping a whole simulated
   * day in one go would freeze the page for as long as it took.
   */
  let skipRun = 0;
  const skipAhead = (ticks: number) => {
    const run = ++skipRun;
    let remaining = Math.max(0, ticks);
    controls.setPlaying(false);
    timeline.setPlaying(false);
    tickDebt = 0;

    const chunk = () => {
      const deadline = performance.now() + SKIP_BUDGET_MS;
      while (remaining > 0 && !source.done && performance.now() < deadline) {
        source.pump(1);
        remaining--;
      }
      viewer.markDirty();
      viewer.displayTick = world.tick;
      if (remaining > 0 && !source.done && run === skipRun) requestAnimationFrame(chunk);
    };
    requestAnimationFrame(chunk);
  };

  const controls = new Controls(controlsHost, visuals, rules, {
    onChange: (state, changed) => {
      if (changed === 'view' || changed === 'init') viewer.applyView(state.view);
      if (changed === 'colorBy' || changed === 'view') viewer.setColorBy(state.colorBy);
      if (changed === 'cutMode' || changed === 'cutFraction' || changed === 'init') {
        viewer.setCut(state.cutMode, state.cutFraction);
      }
      if (changed === 'cutMode') frameWithRoom(viewer);
      if (changed === 'playing') timeline.setPlaying(state.playing);
      viewer.presentation = state.presentation;
    },
    onStep: () => source.pump(1),
    onFrame: () => frameWithRoom(viewer),
    onReset: () => resetRun(),
    onSkipDay: () => skipAhead(activeRules.ticksPerDay),
  });
  document.getElementById('viewswitch')!.replaceWith(controls.viewSwitch);
  controls.viewSwitch.id = 'viewswitch';

  buildPanels();

  viewer.applyView(controls.state.view);
  viewer.setColorBy(controls.state.colorBy);
  viewer.setCut(controls.state.cutMode, controls.state.cutFraction);
  bindShortcuts(controls, { onFrame: () => frameWithRoom(viewer), onReset: () => resetRun() });

  /* --- hover: pick on the next frame, not on every pointer event --- */
  let pointer: { x: number; y: number } | undefined;
  canvas.addEventListener('pointermove', (ev) => {
    pointer = { x: ev.clientX, y: ev.clientY };
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = undefined;
    card.hide();
  });

  /* --- the loop --- */
  let last = performance.now();
  let tickDebt = 0;
  let nextUiUpdate = 0;
  let nextChartUpdate = 0;
  let nextPick = 0;

  source.pump(1);

  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (controls.state.playing && !source.done) {
      tickDebt += dt * controls.state.ticksPerSecond;
      const deadline = performance.now() + TICK_BUDGET_MS;
      while (tickDebt >= 1 && performance.now() < deadline) {
        source.pump(1);
        tickDebt -= 1;
      }
      // Never let the debt grow without bound when the simulation cannot keep up.
      if (tickDebt > controls.state.ticksPerSecond) tickDebt = 0;
    }
    if (source.done) {
      controls.setPlaying(false);
      timeline.setPlaying(false);
    }
    if (!framed && world.count > 0) {
      frameWithRoom(viewer);
      framed = true;
    }

    viewer.advance(dt, controls.state.ticksPerSecond);
    const frameStats = viewer.render(now / 1000);

    // Picking reads a pixel back from the GPU, which stalls the pipeline, so it
    // runs at a fraction of the frame rate rather than every frame.
    if (pointer && now >= nextPick) {
      nextPick = now + PICK_INTERVAL_MS;
      const node = viewer.pick(pointer.x, pointer.y);
      const slot = node >= 0 ? world.slotForNode(node) : -1;
      if (slot >= 0) card.show(pointer.x, pointer.y, world, slot, source.probe?.(node) ?? [], source);
      else card.hide();
    }

    // The drawing buffer is only valid inside the frame that produced it.
    capture.take(canvas, `day${((world.tick * activeRules.hoursPerTick) / 24).toFixed(1)}-${controls.state.view}`);

    if (now >= nextUiUpdate) {
      nextUiUpdate = now + 200;
      const counts = history.record(world, source);
      const story = narrative.read(counts, history, world.tick);
      headline.update(story);
      scaleBar.update(viewer.worldPerPixel());
      panel.update(source, history, stats, frameStats, controls.state.view, story);
      timeline.update(world.tick, history);
      const view = visuals.view(controls.state.view);
      stageTags.update({
        viewLabel: view.label,
        description: shortDescription(view.description ?? ''),
        cutMode: controls.state.cutMode,
        colorBy: controls.state.colorBy,
      });
    }
    if (now >= nextChartUpdate) {
      nextChartUpdate = now + 500;
      chart.update(stats);
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // One arrival, once. Nothing else on this screen moves unless asked to.
  enter([
    document.getElementById('topbar')!,
    document.querySelector('#panel .hero')!,
    document.getElementById('stagetop')!,
    document.getElementById('timeline')!,
  ]);
}

start().catch(showError);

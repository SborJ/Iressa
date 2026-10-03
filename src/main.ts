import { loadData, describeLoadError, makeExperimentRules } from './data.js';
import { Viewer } from './render/viewer.js';
import { FileSource } from './source/fileSource.js';
import { eventsUrl, keyframesUrl, sourceKind } from './defaultRun.js';
import { LocalSimSource } from './source/localSim.js';
import { SocketSource } from './source/socketSource.js';
import type { SimulationSource } from './source/types.js';
import type { ExperimentParams } from './experimentParams.js';
import { Controls } from './ui/controls.js';
import { CauseChart } from './ui/causeChart.js';
import { CauseTally } from './ui/causeTally.js';
import { HoverCard } from './ui/hoverCard.js';
import { Legend } from './ui/legend.js';
import { ScaleBar } from './ui/scaleBar.js';
import { StatusPanel } from './ui/statusPanel.js';
import { CauseStats } from './world/causeStats.js';
import { World } from './world/world.js';

/** How long one frame may spend advancing the simulation. */
const TICK_BUDGET_MS = 24;
/** Fast-forwarding runs in short chunks so the tab remains interactive. */
const FAST_FORWARD_BUDGET_MS = 32;
/** Picking costs a GPU readback, so it runs well below the frame rate. */
const PICK_INTERVAL_MS = 60;

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

async function start(): Promise<void> {
  const data = await loadData();
  const { rules, visuals } = data;
  let source = await makeSource(data);
  let activeRules = rules;

  const world = new World(rules);
  let stats = new CauseStats(rules);
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const viewer = new Viewer(canvas, world, visuals, rules);

  const statusRoot = document.getElementById('status')!;
  const tallyRoot = document.getElementById('tally')!;
  const chartRoot = document.getElementById('chart')!;
  let status = new StatusPanel(statusRoot, rules, visuals, source.kind);
  let tally = new CauseTally(tallyRoot, rules, visuals);
  let chart = new CauseChart(chartRoot, rules, visuals);
  const hover = new HoverCard(document.getElementById('hover')!, rules, visuals);
  const legend = new Legend(document.getElementById('legend')!, rules, visuals);
  const scaleBar = new ScaleBar(document.getElementById('scale')!, rules.raw.grid.voxelMicrons);

  const subscribe = (s: SimulationSource) =>
    s.onPacket((packet) => {
      world.apply(packet);
      stats.ingest(packet, world);
    });
  let unsubscribe = subscribe(source);
  let tickDebt = 0;
  let framed = false;
  let fastForwardRun = 0;

  const resetWorld = () => {
    world.clear();
    world.tick = 0;
    stats.reset();
    viewer.displayTick = 0;
    tickDebt = 0;
    framed = false;
    fastForwardRun++;
    hover.hide();
    viewer.markDirty();
  };

  const rebuildPanels = () => {
    status = new StatusPanel(statusRoot, activeRules, visuals, source.kind);
    tally = new CauseTally(tallyRoot, activeRules, visuals);
    chart = new CauseChart(chartRoot, activeRules, visuals);
  };

  const startLocalExperiment = (params: ExperimentParams) => {
    unsubscribe();
    activeRules = makeExperimentRules(data, params);
    source = new LocalSimSource(activeRules);
    stats = new CauseStats(activeRules);
    rebuildPanels();
    resetWorld();
    unsubscribe = subscribe(source);
    source.pump(1);
    controls.setPlaying(true);
  };

  const fastForwardTicks = (ticks: number) => {
    const run = ++fastForwardRun;
    let remaining = Math.max(0, ticks);
    controls.setPlaying(false);
    tickDebt = 0;

    const pumpChunk = () => {
      const deadline = performance.now() + FAST_FORWARD_BUDGET_MS;
      while (remaining > 0 && !source.done && performance.now() < deadline) {
        source.pump(1);
        remaining--;
      }
      viewer.markDirty();
      status.update(world, source);
      tally.update(stats);
      chart.update(stats);
      if (remaining > 0 && !source.done && run === fastForwardRun) {
        requestAnimationFrame(pumpChunk);
      }
    };
    requestAnimationFrame(pumpChunk);
  };

  const controls = new Controls(document.getElementById('controls')!, visuals, {
    onChange: (state, changed) => {
      if (changed === 'view' || changed === 'init') {
        viewer.applyView(state.view);
        legend.update(state.view);
      }
      if (changed === 'colorBy' || changed === 'view') viewer.setColorBy(state.colorBy);
      if (changed === 'cutMode' || changed === 'cutFraction' || changed === 'init') {
        viewer.setCut(state.cutMode, state.cutFraction);
      }
      viewer.presentation = state.presentation;
    },
    onStep: () => source.pump(1),
    onFrame: () => viewer.frameTumour(),
    onReset: () => {
      unsubscribe();
      source.reset?.();
      resetWorld();
      unsubscribe = subscribe(source);
      source.pump(1);
    },
    onRunExperiment: startLocalExperiment,
    onFastForwardDay: () => fastForwardTicks(activeRules.ticksPerDay),
  });
  viewer.applyView(controls.state.view);
  viewer.setColorBy(controls.state.colorBy);
  viewer.setCut(controls.state.cutMode, controls.state.cutFraction);
  legend.update(controls.state.view);


  /* --- hover: pick on the next frame, not on every pointer event --- */
  let pointer: { x: number; y: number } | undefined;
  canvas.addEventListener('pointermove', (ev) => {
    pointer = { x: ev.clientX, y: ev.clientY };
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = undefined;
    hover.hide();
  });

  /* --- the loop --- */
  let last = performance.now();
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
    if (source.done) controls.setPlaying(false);
    if (!framed && world.count > 0) {
      viewer.frameTumour();
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
      if (slot >= 0) hover.show(pointer.x, pointer.y, world, slot, source.probe?.(node) ?? []);
      else hover.hide();
    }

    if (now >= nextUiUpdate) {
      nextUiUpdate = now + 200;
      status.update(world, source, frameStats);
      tally.update(stats);
      scaleBar.update(viewer.worldPerPixel());
    }
    if (now >= nextChartUpdate) {
      nextChartUpdate = now + 500;
      chart.update(stats);
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

start().catch(showError);

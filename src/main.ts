import { loadData, describeLoadError } from './data.js';
import { Viewer, type ClipAxis } from './render/viewer.js';
import { FileSource } from './source/fileSource.js';
import { LocalSimSource } from './source/localSim.js';
import { SocketSource } from './source/socketSource.js';
import type { SimulationSource } from './source/types.js';
import { Controls } from './ui/controls.js';
import { CauseChart } from './ui/causeChart.js';
import { CauseTally } from './ui/causeTally.js';
import { HoverCard } from './ui/hoverCard.js';
import { StatusPanel } from './ui/statusPanel.js';
import { CauseStats } from './world/causeStats.js';
import { World } from './world/world.js';

/** How long one frame may spend advancing the simulation. */
const TICK_BUDGET_MS = 10;
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
 * The source is chosen by query string, which is how the stand-in simulator is
 * swapped for the real one:
 *
 *   (default)                             the stand-in simulator
 *   ?source=socket&url=ws://host:port     the same records, streamed
 *   ?source=file&events=/run.events       a recorded run
 */
async function makeSource(data: Awaited<ReturnType<typeof loadData>>): Promise<SimulationSource> {
  const q = new URLSearchParams(location.search);
  const kind = q.get('source') ?? 'local';

  if (kind === 'socket') {
    const url = q.get('url') ?? `ws://${location.hostname}:8787`;
    const source = new SocketSource(data.rules, url);
    await source.connect();
    return source;
  }
  if (kind === 'file') {
    const eventsUrl = q.get('events') ?? '/run.events';
    const res = await fetch(eventsUrl);
    if (!res.ok) throw new Error(`cannot load ${eventsUrl} (${res.status})`);
    const events = new Uint8Array(await res.arrayBuffer());
    const keyframes: Uint8Array[] = [];
    const kfUrl = q.get('keyframes');
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

  const world = new World(rules);
  const stats = new CauseStats(rules);
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const viewer = new Viewer(canvas, world, visuals);

  const status = new StatusPanel(document.getElementById('status')!, rules, visuals, source.kind);
  const tally = new CauseTally(document.getElementById('tally')!, rules, visuals);
  const chart = new CauseChart(document.getElementById('chart')!, rules, visuals);
  const hover = new HoverCard(document.getElementById('hover')!, rules, visuals);

  const subscribe = (s: SimulationSource) =>
    s.onPacket((packet) => {
      world.apply(packet);
      stats.ingest(packet, world);
    });
  let unsubscribe = subscribe(source);

  const controls = new Controls(document.getElementById('controls')!, {
    onChange: (state) => {
      viewer.setViewMode(state.viewMode);
      viewer.setClip(state.clipAxis as ClipAxis, state.clipFraction);
    },
    onStep: () => source.pump(1),
    onReset: () => {
      unsubscribe();
      source.reset?.();
      world.clear();
      world.tick = 0;
      stats.reset();
      viewer.displayTick = 0;
      unsubscribe = subscribe(source);
      source.pump(1);
    },
  });
  viewer.setClip(controls.state.clipAxis, controls.state.clipFraction);

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
    if (source.done) controls.setPlaying(false);

    viewer.advance(dt, controls.state.ticksPerSecond);
    viewer.render();

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
      status.update(world, source);
      tally.update(stats);
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

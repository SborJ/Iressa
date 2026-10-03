import { describe, expect, it, vi } from 'vitest';
import { EVENT_SIZE } from '../src/format/events.js';
import { Simulator } from '../src/sim/simulator.js';
import { FileSource } from '../src/source/fileSource.js';
import { LocalSimSource } from '../src/source/localSim.js';
import { SocketSource } from '../src/source/socketSource.js';
import { CauseStats } from '../src/world/causeStats.js';
import { World } from '../src/world/world.js';
import { projectRules } from './helpers.js';

const smallRules = () =>
  projectRules((r) => {
    r.grid.nx = 20;
    r.grid.ny = 20;
    r.grid.nz = 20;
    r.seeding.radiusVoxels = 2.5;
    r.time.keyframeEveryTicks = 1000;
  });

function record(ticks: number) {
  const rules = smallRules();
  const sim = new Simulator(rules);
  const blocks: Uint8Array[] = [];
  const keyframes: Uint8Array[] = [];
  for (let t = 0; t < ticks; t++) {
    const p = sim.step();
    if (p.keyframe) keyframes.push(p.keyframe);
    if (p.events.byteLength) blocks.push(p.events);
    if (p.done) break;
  }
  const total = blocks.reduce((a, b) => a + b.byteLength, 0);
  const events = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) {
    events.set(b, o);
    o += b.byteLength;
  }
  return { rules, sim, events, keyframes };
}

describe('the source seam', () => {
  it('a recorded run replays to the same matrix the live run reached', () => {
    const { rules, sim, events, keyframes } = record(300);

    const source = new FileSource(rules, events, keyframes);
    const world = new World(rules);
    source.onPacket((p) => world.apply(p));
    // One packet per distinct tick in the file.
    for (let i = 0; i < 2000 && !source.done; i++) source.pump(1);

    const snapshot = sim.snapshot();
    expect(world.count).toBe(snapshot.nodes.length);
    const fromWorld = new Map<number, string>();
    for (let s = 0; s < world.count; s++) {
      fromWorld.set(world.nodeOfSlot[s], `${world.clone[s]}/${world.state[s]}`);
    }
    for (const n of snapshot.nodes) {
      expect(fromWorld.get(n.node), `node ${n.node}`).toBe(`${n.clone}/${n.state}`);
    }
  });

  it('a recorded run gives the same deaths-by-cause tallies as the live run', () => {
    const { rules, events, keyframes } = record(300);

    const live = new LocalSimSource(smallRules());
    const liveWorld = new World(rules);
    const liveStats = new CauseStats(rules);
    live.onPacket((p) => {
      liveWorld.apply(p);
      liveStats.ingest(p, liveWorld);
    });
    live.pump(300);

    const replay = new FileSource(rules, events, keyframes);
    const replayWorld = new World(rules);
    const replayStats = new CauseStats(rules);
    replay.onPacket((p) => {
      replayWorld.apply(p);
      replayStats.ingest(p, replayWorld);
    });
    for (let i = 0; i < 2000 && !replay.done; i++) replay.pump(1);

    expect([...replayStats.total]).toEqual([...liveStats.total]);
  });

  it('groups a file into one packet per tick', () => {
    const { rules, events, keyframes } = record(60);
    const source = new FileSource(rules, events, keyframes);
    const ticks: number[] = [];
    source.onPacket((p) => {
      if (p.events.byteLength) ticks.push(p.tick);
    });
    for (let i = 0; i < 500 && !source.done; i++) source.pump(1);
    expect(ticks.length).toBeGreaterThan(5);
    // Strictly increasing, and every packet holds whole records.
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    expect(events.byteLength % EVENT_SIZE).toBe(0);
  });

  it('the stand-in simulator behind the source interface reports when it is finished', () => {
    const rules = projectRules((r) => {
      r.grid.nx = 12;
      r.grid.ny = 12;
      r.grid.nz = 12;
      r.time.maxTicks = 5;
      r.seeding.radiusVoxels = 1.5;
    });
    const source = new LocalSimSource(rules);
    source.pump(20);
    expect(source.done).toBe(true);
    expect(source.tick).toBe(5);
  });
});

describe('cause statistics', () => {
  it('the rolling window only counts the last simulated day', () => {
    const rules = smallRules();
    const source = new LocalSimSource(rules);
    const world = new World(rules);
    const stats = new CauseStats(rules);
    source.onPacket((p) => {
      world.apply(p);
      stats.ingest(p, world);
    });
    source.pump(rules.ticksPerDay * 4);

    const windowTotal = [...stats.window].reduce((a, b) => a + b, 0);
    const allTime = [...stats.total].reduce((a, b) => a + b, 0);
    expect(windowTotal).toBeGreaterThan(0);
    expect(windowTotal).toBeLessThan(allTime);
    expect(stats.windowTicks).toBe(rules.ticksPerDay);
  });

  it('buckets the series for the chart and records the living count', () => {
    const rules = smallRules();
    const source = new LocalSimSource(rules);
    const world = new World(rules);
    const stats = new CauseStats(rules);
    source.onPacket((p) => {
      world.apply(p);
      stats.ingest(p, world);
    });
    source.pump(200);
    expect(stats.buckets.length).toBeGreaterThan(5);
    for (let i = 1; i < stats.buckets.length; i++) {
      expect(stats.buckets[i].tick).toBe(stats.buckets[i - 1].tick + stats.bucketTicks);
    }
    expect(stats.buckets.some((b) => b.living > 0)).toBe(true);
  });
});

describe('the streaming protocol', () => {
  it('decodes the same frames the Python example server sends', () => {
    const rules = smallRules();
    const sim = new Simulator(rules);
    const frames: { keyframe?: Uint8Array; events: Uint8Array; tick: number }[] = [];
    for (let t = 0; t < 40; t++) {
      const p = sim.step();
      frames.push({ keyframe: p.keyframe, events: p.events, tick: p.tick });
    }

    const source = new SocketSource(rules, 'ws://unused');
    const world = new World(rules);
    source.onPacket((p) => world.apply(p));
    for (const f of frames) {
      if (f.keyframe) source.handleFrame(f.keyframe.buffer.slice(f.keyframe.byteOffset, f.keyframe.byteOffset + f.keyframe.byteLength));
      if (f.events.byteLength) source.handleFrame(f.events.buffer.slice(f.events.byteOffset, f.events.byteOffset + f.events.byteLength));
    }

    const snapshot = sim.snapshot();
    expect(world.count).toBe(snapshot.nodes.length);
    expect(source.tick).toBe(frames[frames.length - 1].tick);
    expect(source.done).toBe(false);

    source.handleFrame(JSON.stringify({ done: true }));
    expect(source.done).toBe(true);
  });

  it('drops a frame that is neither a keyframe nor whole event records', () => {
    const rules = smallRules();
    const source = new SocketSource(rules, 'ws://unused');
    const seen: number[] = [];
    source.onPacket((p) => seen.push(p.tick));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    source.handleFrame(new ArrayBuffer(13));
    expect(seen).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeKeyframe } from '../src/format/keyframes.js';
import { loadRules } from '../src/sim/rules.js';
import { FileSource } from '../src/source/fileSource.js';
import { World } from '../src/world/world.js';

/**
 * A run written by the Python engine (scripts/export_iressa_run.py) must replay through this
 * viewer's own FileSource and World to exactly its final keyframe. Uses the committed default run
 * (data/runs/demo48); set IRESSA_RUN to check another exported run.
 */
const RUN = join(process.cwd(), 'data', 'runs', process.env.IRESSA_RUN ?? 'demo48');
const present = existsSync(join(RUN, 'run.events')) && existsSync(join(RUN, 'run.keyframes'));

function splitKeyframes(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const kf = decodeKeyframe(bytes.subarray(offset));
    const size = 32 + kf.nodes.length * 8;
    out.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return out;
}

describe.skipIf(!present)('a run exported by the Python engine', () => {
  it('passes rules validation and replays to its final keyframe node by node', () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), 'data', 'schema', 'rules.schema.json'), 'utf8'));
    const rules = loadRules(JSON.parse(readFileSync(join(RUN, 'rules.json'), 'utf8')), schema);
    const events = new Uint8Array(readFileSync(join(RUN, 'run.events')));
    const keyframes = splitKeyframes(new Uint8Array(readFileSync(join(RUN, 'run.keyframes'))));
    expect(keyframes.length).toBeGreaterThan(1);

    const last = decodeKeyframe(keyframes[keyframes.length - 1]);
    // replay everything strictly before the last keyframe's tick, using only the first keyframe
    const source = new FileSource(rules, events, [keyframes[0]]);
    const world = new World(rules);
    source.onPacket((p) => {
      if (p.tick < last.tick) world.apply(p);
    });
    for (let i = 0; i < 1e6 && !source.done; i++) source.pump(1);

    expect(world.count).toBe(last.nodes.length);
    const fromWorld = new Map<number, string>();
    for (let s = 0; s < world.count; s++) fromWorld.set(world.nodeOfSlot[s], `${world.clone[s]}/${world.state[s]}`);
    for (const n of last.nodes) expect(fromWorld.get(n.node), `node ${n.node}`).toBe(`${n.clone}/${n.state}`);
    expect(rules.raw.vasculature?.segments?.length ?? 0).toBeGreaterThan(0);
    expect(rules.cloneIds).toEqual([0, 1, 2, 3]);
  });
});

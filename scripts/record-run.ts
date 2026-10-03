/**
 * Record a run to the two files the viewer replays, which is the same pair the
 * Python simulation will produce.
 *
 *   npm run record -- [ticks] [outDir]
 *
 * Then: http://localhost:5173/?source=file&events=/run.events&keyframes=/run.keyframes
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRules } from '../src/sim/rules.js';
import { Simulator } from '../src/sim/simulator.js';
import { EVENT_SIZE } from '../src/format/events.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const rules = loadRules(readJson('data/rules.json'), readJson('data/schema/rules.schema.json'));
const ticks = Number(process.argv[2] ?? rules.maxTicks);
const outDir = join(root, process.argv[3] ?? 'data');
mkdirSync(outDir, { recursive: true });

const sim = new Simulator(rules);
const eventBlocks: Uint8Array[] = [];
const keyframeBlocks: Uint8Array[] = [];
for (let t = 0; t < ticks; t++) {
  const p = sim.step();
  if (p.keyframe) keyframeBlocks.push(p.keyframe);
  if (p.events.byteLength) eventBlocks.push(p.events);
  if (p.done) break;
}

const join2 = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

const events = join2(eventBlocks);
const keyframes = join2(keyframeBlocks);
writeFileSync(join(outDir, 'run.events'), events);
writeFileSync(join(outDir, 'run.keyframes'), keyframes);
console.log(
  `${events.byteLength / EVENT_SIZE} events (${(events.byteLength / 1e6).toFixed(1)} MB) and ` +
    `${keyframeBlocks.length} keyframes (${(keyframes.byteLength / 1e6).toFixed(1)} MB) ` +
    `over ${sim.tick} ticks -> ${outDir}`,
);

/**
 * Headless run of the stand-in simulator, straight off data/rules.json.
 *
 *   npm run sim -- [ticks]
 *
 * Prints the population and the deaths by cause over time, which is how you
 * check that a change to rules.json actually changed the biology.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRules, RulesError } from '../src/sim/rules.js';
import { Simulator } from '../src/sim/simulator.js';
import { forEachEvent, EventType } from '../src/format/events.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

let rules;
try {
  rules = loadRules(readJson('data/rules.json'), readJson('data/schema/rules.schema.json'));
} catch (err) {
  if (err instanceof RulesError) {
    console.error(`${err.message}:`);
    for (const p of err.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  throw err;
}

const ticks = Number(process.argv[2] ?? rules.maxTicks);
const reportEvery = Number(process.argv[3] ?? 5);
const sim = new Simulator(rules);
const deathsByCause = new Map<number, number>();
const divisions = { n: 0 };
const mutations = new Map<number, number>();
const stateChanges = new Map<number, number>();
const causeName = (id: number) => rules.causeById.get(id)?.name ?? `cause ${id}`;
const cloneName = (id: number) => rules.clones[id]?.name ?? `clone ${id}`;

const t0 = Date.now();
let lastReport = -1;
for (let t = 0; t < ticks; t++) {
  const r = sim.step();
  forEachEvent(r.events, (e) => {
    if (e.type === EventType.DeathStart) {
      deathsByCause.set(e.cause, (deathsByCause.get(e.cause) ?? 0) + 1);
    } else if (e.type === EventType.Divide) {
      divisions.n++;
    } else if (e.type === EventType.Mutate) {
      mutations.set(e.b, (mutations.get(e.b) ?? 0) + 1);
    } else if (e.type === EventType.StateChange) {
      stateChanges.set(e.cause, (stateChanges.get(e.cause) ?? 0) + 1);
    }
  });

  const day = Math.floor((r.tick * rules.hoursPerTick) / 24);
  if (day !== lastReport && r.tick % rules.ticksPerDay === 0) {
    lastReport = day;
    const s = sim.stats();
    const clones = [...s.byClone.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${cloneName(id)} ${n}`)
      .join(', ');
    const plasma = [...s.plasma.entries()]
      .map(([id, c]) => `${rules.drugById.get(id)?.name ?? id}=${c.toFixed(2)}`)
      .join(' ');
    if (day % reportEvery === 0) {
      console.log(
        `day ${String(day).padStart(3)}  living ${String(s.living).padStart(6)}  dying ${String(s.dying).padStart(5)}  ${plasma}  | ${clones}`,
      );
    }
  }
  if (r.done) break;
}

const elapsed = (Date.now() - t0) / 1000;
console.log(`\n${sim.tick} ticks in ${elapsed.toFixed(1)}s (${(sim.tick / elapsed).toFixed(0)} ticks/s)`);
console.log(`divisions: ${divisions.n}`);
console.log('\ndeaths by cause:');
const totalDeaths = [...deathsByCause.values()].reduce((a, b) => a + b, 0);
for (const [id, n] of [...deathsByCause.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = totalDeaths ? ((100 * n) / totalDeaths).toFixed(1) : '0.0';
  console.log(`  ${String(n).padStart(8)}  ${pct.padStart(5)}%  ${causeName(id)}`);
}
console.log(`  ${String(totalDeaths).padStart(8)}         total`);
console.log('\nstate changes by cause:');
for (const [id, n] of [...stateChanges.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(8)}         ${causeName(id)}`);
}
if (mutations.size) {
  console.log('\nmutations acquired:');
  for (const [cloneId, n] of mutations) console.log(`  ${String(n).padStart(8)}  -> ${cloneName(cloneId)}`);
} else {
  console.log('\nno mutations acquired');
}

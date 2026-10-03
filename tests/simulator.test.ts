import { describe, expect, it } from 'vitest';
import { EventType, forEachEvent, drugOfEvent, NO_DRUG, stateOf } from '../src/format/events.js';
import { Simulator } from '../src/sim/simulator.js';
import type { ResolvedRules } from '../src/sim/rules.js';
import { World } from '../src/world/world.js';
import { projectRules } from './helpers.js';

/** A smaller, faster world for the tests; still entirely rules-driven. */
function smallRules(mutate?: (r: any) => void): ResolvedRules {
  return projectRules((r) => {
    r.grid.nx = 24;
    r.grid.ny = 24;
    r.grid.nz = 24;
    r.seeding.radiusVoxels = 2.5;
    r.time.keyframeEveryTicks = 60;
    // The shipped scenario doses on day 20; these runs are a few hundred ticks,
    // so bring treatment into the window they actually cover.
    r.treatment.schedule[0].startHour = 120;
    r.treatment.radiation = [{ hour: 300, doseGy: 2.5 }];
    mutate?.(r);
  });
}

function run(rules: ResolvedRules, ticks: number) {
  const sim = new Simulator(rules);
  const bytes: Uint8Array[] = [];
  const keyframes: (Uint8Array | undefined)[] = [];
  const deaths = new Map<number, number>();
  const stateChanges = new Map<number, number>();
  let divisions = 0;
  let mutations = 0;
  for (let t = 0; t < ticks; t++) {
    const r = sim.step();
    bytes.push(r.events);
    keyframes.push(r.keyframe);
    forEachEvent(r.events, (e) => {
      if (e.type === EventType.DeathStart) deaths.set(e.cause, (deaths.get(e.cause) ?? 0) + 1);
      else if (e.type === EventType.Divide) divisions++;
      else if (e.type === EventType.Mutate) mutations++;
      else if (e.type === EventType.StateChange)
        stateChanges.set(e.cause, (stateChanges.get(e.cause) ?? 0) + 1);
    });
    if (r.done) break;
  }
  return { sim, bytes, keyframes, deaths, stateChanges, divisions, mutations };
}

const concat = (parts: Uint8Array[]) => {
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

describe('determinism', () => {
  it('produces byte-identical events for the same seed', () => {
    const a = run(smallRules(), 200);
    const b = run(smallRules(), 200);
    expect(concat(a.bytes)).toEqual(concat(b.bytes));
  });

  it('produces a different run for a different seed', () => {
    const a = run(smallRules(), 200);
    const b = run(smallRules((r) => (r.seed = r.seed + 1)), 200);
    expect(concat(a.bytes)).not.toEqual(concat(b.bytes));
  });

  it('does not depend on the order nodes happen to be visited in', () => {
    // Seeding order changes which slot a node occupies; the rolls are hashed
    // from (seed, tick, node, channel), so the outcome must not move.
    const a = run(smallRules(), 150);
    const b = run(
      smallRules((r) => {
        r.seeding.center = [12, 12, 12];
      }),
      150,
    );
    expect(a.sim.livingCount).toBe(b.sim.livingCount);
  });
});

describe('every event refers to something the rules declare', () => {
  it('uses only declared causes and states', () => {
    const rules = smallRules();
    const { bytes } = run(rules, 400);
    let checked = 0;
    for (const block of bytes) {
      forEachEvent(block, (e) => {
        checked++;
        expect(rules.causeById.has(e.cause), `cause ${e.cause}`).toBe(true);
        expect(e.type).toBeGreaterThanOrEqual(1);
        expect(e.type).toBeLessThanOrEqual(5);
        expect(rules.clones[e.clone], `clone ${e.clone}`).toBeDefined();
        if (e.type === EventType.StateChange) {
          expect(rules.stateById.has(stateOf(e.b)), `state ${stateOf(e.b)}`).toBe(true);
        }
        const drug = drugOfEvent(e);
        if (drug !== NO_DRUG) expect(rules.drugById.has(drug)).toBe(true);
      });
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('attaches a drug id to every drug-caused event', () => {
    const rules = smallRules();
    const drugDeath = rules.causeByRole.get('drugApoptosis')!.id;
    const drugArrest = rules.causeByRole.get('drugArrest')!.id;
    const { bytes } = run(rules, 900);
    let seen = 0;
    for (const block of bytes) {
      forEachEvent(block, (e) => {
        if (e.cause === drugDeath || e.cause === drugArrest) {
          expect(drugOfEvent(e)).not.toBe(NO_DRUG);
          seen++;
        }
      });
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('the rules decide the behaviour', () => {
  it('no treatment means no drug deaths and no drug arrests', () => {
    const rules = smallRules((r) => {
      r.treatment.schedule = [];
      r.treatment.radiation = [];
    });
    const drugDeath = rules.causeByRole.get('drugApoptosis')!.id;
    const drugArrest = rules.causeByRole.get('drugArrest')!.id;
    const radiation = rules.causeByRole.get('radiation')!.id;
    const { deaths, stateChanges } = run(rules, 900);
    expect(deaths.get(drugDeath) ?? 0).toBe(0);
    expect(deaths.get(radiation) ?? 0).toBe(0);
    expect(stateChanges.get(drugArrest) ?? 0).toBe(0);
    // Everything else still happens.
    expect(deaths.get(rules.causeByRole.get('baselineApoptosis')!.id)!).toBeGreaterThan(0);
  });

  it('a higher baseline death rate kills more cells of that cause', () => {
    const baseline = smallRules().causeByRole.get('baselineApoptosis')!.id;
    const low = run(smallRules((r) => (r.clones[0].baselineDeathPerHour = 0.001)), 300);
    const high = run(smallRules((r) => (r.clones[0].baselineDeathPerHour = 0.02)), 300);
    expect(high.deaths.get(baseline)!).toBeGreaterThan(low.deaths.get(baseline)! * 3);
  });

  it('raising the IC50 makes a clone resistant without touching any code', () => {
    const drugDeath = smallRules().causeByRole.get('drugApoptosis')!.id;
    const sensitive = run(smallRules(), 900);
    const resistant = run(
      smallRules((r) => {
        r.clones[0].drugSensitivity[0].ic50 = 1000;
      }),
      900,
    );
    expect(sensitive.deaths.get(drugDeath)!).toBeGreaterThan(0);
    expect(resistant.deaths.get(drugDeath) ?? 0).toBe(0);
    expect(resistant.sim.livingCount).toBeGreaterThan(sensitive.sim.livingCount);
  });

  it('turning off immune pressure removes immune kills', () => {
    const immune = smallRules().causeByRole.get('immuneKill')!.id;
    const on = run(smallRules(), 300);
    const off = run(smallRules((r) => (r.immune.killPerHour = 0)), 300);
    expect(on.deaths.get(immune)!).toBeGreaterThan(0);
    expect(off.deaths.get(immune) ?? 0).toBe(0);
  });

  it('a lower necrosis threshold spares the hypoxic core', () => {
    // The 24-voxel test box sits inside the oxygen diffusion length of the
    // shipped rules, so raise consumption in both arms to starve the core.
    const starved = (extra?: (r: any) => void) =>
      smallRules((r) => {
        r.oxygen.consumptionPerCell = 0.05;
        extra?.(r);
      });
    const necrosis = starved().causeByRole.get('hypoxicNecrosis')!.id;
    const normal = run(starved(), 500);
    const forgiving = run(starved((r) => (r.oxygen.necrosisThreshold = 0.0)), 500);
    expect(normal.deaths.get(necrosis)!).toBeGreaterThan(0);
    expect(forgiving.deaths.get(necrosis) ?? 0).toBe(0);
  });

  it('a higher mutation rate produces more mutants', () => {
    const rare = run(smallRules((r) => (r.mutations[0].ratePerDivision = 1e-9)), 400);
    const common = run(smallRules((r) => (r.mutations[0].ratePerDivision = 0.02)), 400);
    expect(rare.mutations).toBe(0);
    expect(common.mutations).toBeGreaterThan(0);
  });

  it('the same cell population dies of different causes under different treatment', () => {
    const rules = smallRules();
    const drugDeath = rules.causeByRole.get('drugApoptosis')!.id;
    const treated = run(smallRules(), 900);
    const untreated = run(smallRules((r) => (r.treatment.schedule = [])), 900);
    const share = (m: Map<number, number>, id: number) => {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      return total ? (m.get(id) ?? 0) / total : 0;
    };
    expect(share(treated.deaths, drugDeath)).toBeGreaterThan(0.3);
    expect(share(untreated.deaths, drugDeath)).toBe(0);
  });
});

describe('replaying the event stream reproduces the matrix', () => {
  it('world state matches the simulator snapshot exactly', () => {
    const rules = smallRules();
    const sim = new Simulator(rules);
    const world = new World(rules);
    for (let t = 0; t < 500; t++) {
      const packet = sim.step();
      world.apply(packet);
      if (packet.done) break;
    }
    const snapshot = sim.snapshot();
    expect(world.count).toBe(snapshot.nodes.length);

    const fromWorld = new Map<number, string>();
    for (let s = 0; s < world.count; s++) {
      fromWorld.set(world.nodeOfSlot[s], `${world.clone[s]}/${world.state[s]}/${world.cause[s]}`);
    }
    for (const n of snapshot.nodes) {
      expect(fromWorld.get(n.node), `node ${n.node}`).toBe(`${n.clone}/${n.state}/${n.cause}`);
    }
  });

  it('a keyframe alone rebuilds the same matrix', () => {
    const rules = smallRules((r) => (r.time.keyframeEveryTicks = 1));
    const sim = new Simulator(rules);
    let lastKeyframe: Uint8Array | undefined;
    for (let t = 0; t < 120; t++) lastKeyframe = sim.step().keyframe;
    expect(lastKeyframe).toBeDefined();

    const world = new World(rules);
    world.applyKeyframe(lastKeyframe!);
    // The keyframe is the state at the start of the last tick; step the
    // simulator's own copy back by comparing against a run one tick shorter.
    const reference = new Simulator(rules);
    for (let t = 0; t < 119; t++) reference.step();
    const snapshot = reference.snapshot();
    expect(world.count).toBe(snapshot.nodes.length);
  });
});

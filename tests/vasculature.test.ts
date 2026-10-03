import { describe, expect, it } from 'vitest';
import { Grid } from '../src/sim/grid.js';
import { Simulator } from '../src/sim/simulator.js';
import { growVasculature } from '../src/sim/vasculature.js';
import { projectRules } from './helpers.js';

const smallRules = (mutate?: (r: any) => void) =>
  projectRules((r) => {
    r.grid.nx = 28;
    r.grid.ny = 28;
    r.grid.nz = 28;
    r.seeding.radiusVoxels = 2;
    r.treatment.schedule = [];
    r.treatment.radiation = [];
    mutate?.(r);
  });

const gridOf = (rules: ReturnType<typeof projectRules>) =>
  new Grid(rules.raw.grid.nx, rules.raw.grid.ny, rules.raw.grid.nz, 26);

describe('the vascular tree', () => {
  it('is a pure function of the rules, so the simulator and the renderer agree', () => {
    const rules = smallRules();
    const a = growVasculature(rules.raw, gridOf(rules))!;
    const b = growVasculature(rules.raw, gridOf(rules))!;
    expect(a.segments).toEqual(b.segments);
    expect([...a.mask]).toEqual([...b.mask]);
  });

  it('a different seed grows a different tree', () => {
    const a = growVasculature(smallRules().raw, gridOf(smallRules()))!;
    const other = smallRules((r) => (r.seed = r.seed + 1));
    const b = growVasculature(other.raw, gridOf(other))!;
    expect(a.segments).not.toEqual(b.segments);
  });

  it('tapers towards the tips, as Murray\'s law requires', () => {
    const rules = smallRules();
    const v = growVasculature(rules.raw, gridOf(rules))!;
    const byDepth = new Map<number, number[]>();
    for (const s of v.segments) {
      const list = byDepth.get(s.depth) ?? [];
      list.push(s.ra);
      byDepth.set(s.depth, list);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const depths = [...byDepth.keys()].sort((a, b) => a - b);
    expect(depths.length).toBeGreaterThan(2);
    for (let i = 1; i < depths.length; i++) {
      expect(mean(byDepth.get(depths[i])!)).toBeLessThan(mean(byDepth.get(depths[i - 1])!));
    }
  });

  it('every lumen voxel is a supply point and no wall voxel is', () => {
    const rules = smallRules();
    const v = growVasculature(rules.raw, gridOf(rules))!;
    expect(v.sources.length).toBeGreaterThan(0);
    const sources = new Set(v.sources);
    for (let i = 0; i < v.mask.length; i++) {
      if (v.mask[i] === 1) expect(sources.has(i)).toBe(true);
      else expect(sources.has(i)).toBe(false);
    }
  });

  it('no cell ever occupies a vessel', () => {
    const rules = smallRules();
    const sim = new Simulator(rules);
    const vasc = sim.vasculature!;
    for (let t = 0; t < 400; t++) {
      if (sim.step().done) break;
      for (const n of sim.snapshot().nodes) {
        if (vasc.mask[n.node] !== 0) {
          expect.unreachable(`cell at node ${n.node}, which is a vessel`);
        }
      }
    }
  });

  it('removing the vessels removes the supply, and the tumour starves', () => {
    const withVessels = new Simulator(smallRules());
    for (let t = 0; t < 400; t++) if (withVessels.step().done) break;

    const none = new Simulator(
      smallRules((r) => {
        delete r.vasculature;
        r.seeding.snapToVessel = false;
      }),
    );
    for (let t = 0; t < 400; t++) if (none.step().done) break;

    expect(withVessels.livingCount).toBeGreaterThan(none.livingCount * 2);
  });

  it('oxygen is highest next to a lumen and falls away from it', () => {
    const rules = smallRules();
    const sim = new Simulator(rules);
    for (let t = 0; t < 300; t++) if (sim.step().done) break;
    const ox = sim.field('oxygen')!;
    const g = gridOf(rules);
    const vasc = sim.vasculature!;
    const nbr = new Int32Array(g.degree);

    /* Compare cells touching a lumen against cells that are not, rather than
       against an absolute threshold: a small test tumour may be perfused
       throughout and still show the gradient. */
    let near = 0;
    let nearCount = 0;
    let far = 0;
    let farCount = 0;
    for (const n of sim.snapshot().nodes) {
      const c = g.neighbors(n.node, nbr);
      let touches = false;
      for (let k = 0; k < c; k++) if (vasc.mask[nbr[k]] === 1) touches = true;
      if (touches) {
        near += ox[n.node];
        nearCount++;
      } else {
        far += ox[n.node];
        farCount++;
      }
    }
    expect(nearCount).toBeGreaterThan(0);
    expect(farCount).toBeGreaterThan(0);
    expect(near / nearCount).toBeGreaterThan(far / farCount);
  });
});

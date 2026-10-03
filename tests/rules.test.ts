import { describe, expect, it } from 'vitest';
import { RulesError, loadRules } from '../src/sim/rules.js';
import { projectRules, rawRules, rulesSchema } from './helpers.js';

describe('rules.json', () => {
  it('validates against its schema', () => {
    expect(() => projectRules()).not.toThrow();
  });

  it('declares a cause for every mechanism the simulator runs', () => {
    const rules = projectRules();
    for (const role of [
      'normalCycle',
      'baselineApoptosis',
      'drugApoptosis',
      'hypoxicNecrosis',
      'radiation',
      'crowdingArrest',
      'hypoxiaArrest',
      'drugArrest',
      'immuneKill',
      'mutation',
    ] as const) {
      expect(rules.causeByRole.get(role), `role ${role}`).toBeDefined();
    }
  });

  it('resolves a derived clone from its parent and the mutation multipliers', () => {
    const rules = projectRules();
    const parent = rules.clones[0]!;
    const t790m = rules.clones[1]!;
    const mutation = (rules.raw.mutations ?? []).find((m) => m.toClone === 1)!;

    // cycleHours: parent's own cycle, times the mutation multiplier, times this
    // clone's fitness cost.
    const expected =
      parent.cycleHours * mutation.multipliers!.cycleHours! * (1 + 0.08);
    expect(t790m.cycleHours).toBeCloseTo(expected, 6);
    // IC50 inherits the parent's and is multiplied by the mutation's factor.
    expect(t790m.drug[0]!.ic50).toBeCloseTo(parent.drug[0]!.ic50 * 14, 6);
    // Everything not mentioned is inherited unchanged.
    expect(t790m.drug[0]!.killMaxPerHour).toBe(parent.drug[0]!.killMaxPerHour);
  });

  it('a parent fitness cost is not applied twice down the chain', () => {
    const rules = projectRules((r) => {
      r.clones[0].fitnessCost = 0.5;
    });
    const parent = rules.clones[0]!;
    const child = rules.clones[1]!;
    const mult = rules.raw.mutations!.find((m) => m.toClone === 1)!.multipliers!.cycleHours!;
    expect(parent.cycleHours).toBeCloseTo(22 * 1.5, 6);
    expect(child.cycleHours).toBeCloseTo(22 * mult * 1.08, 6);
  });

  it('rejects a mutation that points at a clone that is not declared', () => {
    expect(() =>
      projectRules((r) => {
        r.mutations[0].toClone = 99;
      }),
    ).toThrow(RulesError);
  });

  it('rejects a cause table with two causes claiming the same role', () => {
    try {
      projectRules((r) => {
        r.causes[1].role = 'normalCycle';
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RulesError);
      expect((err as RulesError).problems.join(' ')).toMatch(/role "normalCycle"/);
    }
  });

  it('rejects a drug schedule that names a drug that is not declared', () => {
    expect(() =>
      projectRules((r) => {
        r.treatment.schedule[0].drug = 9;
      }),
    ).toThrow(RulesError);
  });

  it('rejects a clone inheritance cycle', () => {
    expect(() =>
      projectRules((r) => {
        r.clones[0].derivesFrom = 1;
      }),
    ).toThrow(RulesError);
  });

  it('rejects an out-of-range diffusion coefficient, which would be unstable', () => {
    expect(() =>
      projectRules((r) => {
        r.oxygen.diffusion = 0.5;
      }),
    ).toThrow(RulesError);
  });

  it('reports every problem at once rather than the first', () => {
    try {
      loadRules(
        (() => {
          const r = rawRules() as any;
          r.mutations[0].toClone = 99;
          r.treatment.schedule[0].drug = 9;
          return r;
        })(),
        rulesSchema(),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as RulesError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });
});

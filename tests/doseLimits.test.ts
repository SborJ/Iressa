import { describe, expect, it } from 'vitest';
import {
  approxMgPerDose,
  concentrationsAreMicromolar,
  DOSE_LIMITS,
  maxSafeAmount,
  steadyStatePeakPerUnit,
} from '../src/doseLimits.js';
import { applyLocalExperimentOverrides, doseReport, experimentParamsFromQuery } from '../src/experimentParams.js';
import { Pharmacokinetics } from '../src/sim/fields.js';
import type { RulesFile } from '../src/sim/rules.js';
import { rawRules, readJson } from './helpers.js';

/** The engine's demo run: concentrations in µM, three named drugs. */
const engineRules = (): RulesFile => readJson('data/runs/demo48/rules.json');
const q = (search: string) => new URLSearchParams(search);
const drugNamed = (rules: RulesFile, name: string) => rules.drugs!.find((d) => d.name === name)!;

/** Peak plasma over a schedule, stepped by the simulator's own PK class. */
function simulatedPeak(rules: RulesFile, drugId: number): number {
  const drug = rules.drugs!.find((d) => d.id === drugId)!;
  const pk = new Pharmacokinetics(
    drug.pk.absorptionPerHour, drug.pk.eliminationHalfLifeHours,
    drug.pk.bioavailability ?? 1, drug.pk.volumeOfDistribution ?? 1,
  );
  const entries = (rules.treatment?.schedule ?? []).filter((s) => s.drug === drugId);
  const end = Math.max(...entries.map((s) => s.startHour + s.doses * s.everyHours));
  const dt = rules.time.tickMinutes / 60;
  let peak = 0;
  for (let h = 0; h < end; h += dt) {
    for (const s of entries) {
      for (let k = 0; k < s.doses; k++) {
        const at = s.startHour + k * s.everyHours;
        if (at >= h && at < h + dt) pk.dose(s.amount);
      }
    }
    pk.step(dt);
    peak = Math.max(peak, pk.plasma);
  }
  return peak;
}

describe('human dose limits', () => {
  it('knows which rules are in µM', () => {
    expect(concentrationsAreMicromolar(engineRules())).toBe(true);
    // The stand-in's scale is arbitrary, so a µM ceiling would mean nothing there.
    expect(concentrationsAreMicromolar(rawRules())).toBe(false);
  });

  it('the steady-state peak per unit matches the simulator stepping the same schedule', () => {
    const rules = engineRules();
    for (const name of ['gefitinib', 'osimertinib']) {
      const drug = drugNamed(rules, name);
      rules.treatment = { schedule: [{ drug: drug.id, startHour: 0, everyHours: 24, doses: 60, amount: 1 }] };
      const simulated = simulatedPeak(rules, drug.id);
      expect(steadyStatePeakPerUnit(drug, 24)).toBeCloseTo(simulated, 1);
    }
  });

  it('caps a large requested dose so no drug passes what people have tolerated', () => {
    const base = engineRules();
    for (const schedule of ['continuous-gefitinib', 'gefitinib-osimertinib', 'adaptive-gefitinib']) {
      const params = experimentParamsFromQuery(q(`dose=5&days=60&switchDay=20&schedule=${schedule}`));
      const rules = applyLocalExperimentOverrides(base, params);
      for (const id of new Set((rules.treatment?.schedule ?? []).map((s) => s.drug))) {
        const drug = rules.drugs!.find((d) => d.id === id)!;
        // A switch starts the second drug from zero, so it may not reach steady
        // state; the bound still has to hold.
        expect(simulatedPeak(rules, id)).toBeLessThanOrEqual(DOSE_LIMITS[drug.name].maxPeakMicromolar * 1.01);
      }
    }
  });

  it('holds the default dose to the ceiling where it was above it', () => {
    const rules = engineRules();
    const report = doseReport(experimentParamsFromQuery(q('')), rules);
    const gef = report.find((r) => r.drug.name === 'gefitinib')!;
    const osi = report.find((r) => r.drug.name === 'osimertinib')!;
    // 0.9 a day settles above both peaks; each is held to its own ceiling.
    expect(gef.capped).toBe(true);
    expect(osi.capped).toBe(true);
    expect(gef.mg).toBeCloseTo(DOSE_LIMITS.gefitinib.maxMgPerDay, 0);
    expect(osi.mg).toBeCloseTo(DOSE_LIMITS.osimertinib.maxMgPerDay, 0);
  });

  it('leaves a dose below the ceiling alone and reports its mg', () => {
    const rules = engineRules();
    const gef = drugNamed(rules, 'gefitinib');
    const approved = (DOSE_LIMITS.gefitinib.approvedMgPerDay / DOSE_LIMITS.gefitinib.maxMgPerDay) * maxSafeAmount(rules, gef, 24);
    const report = doseReport(experimentParamsFromQuery(q(`dose=${approved}&schedule=continuous-gefitinib`)), rules);
    expect(report[0].capped).toBe(false);
    expect(report[0].mg).toBeCloseTo(250, 0);
  });

  it('never lets one dose exceed the highest daily dose, however far apart the doses are', () => {
    const rules = engineRules();
    const gef = drugNamed(rules, 'gefitinib');
    expect(maxSafeAmount(rules, gef, 48)).toBeCloseTo(maxSafeAmount(rules, gef, 24), 6);
    expect(approxMgPerDose(rules, gef, maxSafeAmount(rules, gef, 48))).toBeCloseTo(700, 0);
  });

  it('does not cap the stand-in simulator', () => {
    const rules = applyLocalExperimentOverrides(rawRules(), experimentParamsFromQuery(q('dose=5&schedule=continuous-gefitinib')));
    expect(rules.treatment!.schedule![0].amount).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyLocalExperimentOverrides,
  experimentParamsFromQuery,
  oxygenPreset,
} from '../src/experimentParams.js';
import { readJson, rawRules } from './helpers.js';

/** The shipped demo run, which is the only rules file with a second drug. */
const twoDrugRules = () => readJson('data/runs/demo48/rules.json');

const q = (search: string) => new URLSearchParams(search);

describe('experiment parameters', () => {
  it('an empty query gives the declared defaults, not the clamp minimums', () => {
    const p = experimentParamsFromQuery(q(''));
    // Number(null) is 0, which used to pass the finite check and collapse every
    // default to its lower bound: a 1-day run at zero dose.
    expect(p.days).toBe(60);
    expect(p.dose).toBeCloseTo(0.9);
    expect(p.switchDay).toBe(20);
    expect(p.schedule).toBe('gefitinib-osimertinib');
    expect(p.oxygenMode).toBe('default');
    expect(p.oxygenSupply).toBeCloseTo(1.0);
    expect(p.oxygenUptake).toBeCloseTo(0.014);
  });

  it('reads and clamps what the query does state', () => {
    const p = experimentParamsFromQuery(q('days=10&dose=99&switchDay=3'));
    expect(p.days).toBe(10);
    expect(p.dose).toBe(5);
    expect(p.switchDay).toBe(3);
  });

  it('ignores a value that is not a number', () => {
    expect(experimentParamsFromQuery(q('days=soon')).days).toBe(60);
  });

  it('an oxygen mode brings its preset with it', () => {
    const p = experimentParamsFromQuery(q('oxygenMode=necrotic'));
    expect(p.oxygenSupply).toBeCloseTo(oxygenPreset('necrotic').oxygenSupply);
    expect(p.oxygenUptake).toBeCloseTo(oxygenPreset('necrotic').oxygenUptake);
  });

  it('an explicit value still overrides the preset it came with', () => {
    const p = experimentParamsFromQuery(q('oxygenMode=hypoxic&oxygenSupply=1.5'));
    expect(p.oxygenSupply).toBeCloseTo(1.5);
  });

  describe('applied to the rules', () => {
    const base = rawRules();

    it('sets the run length from the day count', () => {
      const p = experimentParamsFromQuery(q('days=10'));
      const out = applyLocalExperimentOverrides(base, p);
      expect(out.time.maxTicks).toBe((10 * 24 * 60) / base.time.tickMinutes);
    });

    it('switching gives two courses that meet on the switch day', () => {
      const p = experimentParamsFromQuery(q('days=30&switchDay=12&schedule=gefitinib-osimertinib'));
      const out = applyLocalExperimentOverrides(twoDrugRules(), p);
      const schedule = out.treatment?.schedule ?? [];
      expect(schedule.length).toBe(2);
      expect(schedule[0].doses).toBe(12);
      expect(schedule[1].startHour).toBe(12 * 24);
      expect(schedule[0].doses + schedule[1].doses).toBe(30);
    });

    it('with only one drug the switch carries that drug through, not stops', () => {
      // data/rules.json names gefitinib alone. Stopping at the switch day would
      // silently leave the rest of the run untreated.
      const p = experimentParamsFromQuery(q('days=30&switchDay=12&schedule=gefitinib-osimertinib'));
      const schedule = applyLocalExperimentOverrides(base, p).treatment?.schedule ?? [];
      const dosed = schedule.reduce((a, s) => a + s.doses, 0);
      expect(dosed).toBe(30);
      expect(new Set(schedule.map((s) => s.drug)).size).toBe(1);
    });

    it('no treatment leaves an empty schedule', () => {
      const out = applyLocalExperimentOverrides(base, experimentParamsFromQuery(q('schedule=none')));
      expect(out.treatment?.schedule).toEqual([]);
    });

    it('a zero dose is the same as no treatment', () => {
      const out = applyLocalExperimentOverrides(base, experimentParamsFromQuery(q('dose=0')));
      expect(out.treatment?.schedule).toEqual([]);
    });

    it('adaptive dosing is every other day', () => {
      const out = applyLocalExperimentOverrides(
        base,
        experimentParamsFromQuery(q('schedule=adaptive-gefitinib&days=20')),
      );
      const schedule = out.treatment?.schedule ?? [];
      expect(schedule).toHaveLength(1);
      expect(schedule[0].everyHours).toBe(48);
      expect(schedule[0].doses).toBe(10);
    });

    it('the oxygen environment reaches both the field and the vessels', () => {
      const p = experimentParamsFromQuery(q('oxygenMode=necrotic'));
      const out = applyLocalExperimentOverrides(base, p);
      expect(out.oxygen.consumptionPerCell).toBeCloseTo(p.oxygenUptake);
      if (out.vasculature) expect(out.vasculature.oxygenSupply).toBeCloseTo(p.oxygenSupply);
    });

    it('leaves the original rules untouched', () => {
      const before = JSON.stringify(base);
      applyLocalExperimentOverrides(base, experimentParamsFromQuery(q('days=5')));
      expect(JSON.stringify(base)).toBe(before);
    });
  });
});

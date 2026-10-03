import { approxMgPerDose, DOSE_LIMITS, maxSafeAmount } from './doseLimits.js';
import type { DrugSpec, RulesFile } from './sim/rules.js';

export type ExperimentSchedule =
  | 'none'
  | 'continuous-gefitinib'
  | 'gefitinib-osimertinib'
  | 'adaptive-gefitinib';

export type OxygenMode = 'default' | 'vascular' | 'hypoxic' | 'necrotic';

export interface ExperimentParams {
  days: number;
  dose: number;
  schedule: ExperimentSchedule;
  switchDay: number;
  oxygenMode: OxygenMode;
  oxygenSupply: number;
  oxygenUptake: number;
}

const DEFAULTS: ExperimentParams = {
  days: 60,
  dose: 0.9,
  schedule: 'gefitinib-osimertinib',
  switchDay: 20,
  oxygenMode: 'default',
  oxygenSupply: 1.0,
  oxygenUptake: 0.014,
};

const OXYGEN_PRESETS: Record<OxygenMode, Pick<ExperimentParams, 'oxygenSupply' | 'oxygenUptake'>> = {
  default: { oxygenSupply: 1.0, oxygenUptake: 0.014 },
  vascular: { oxygenSupply: 1.2, oxygenUptake: 0.010 },
  hypoxic: { oxygenSupply: 0.72, oxygenUptake: 0.022 },
  necrotic: { oxygenSupply: 0.48, oxygenUptake: 0.030 },
};

/**
 * The longest run the viewer will set up.
 *
 * Ten years of simulated time. There has to be some bound - the day count sets
 * maxTicks, and a value with no ceiling turns a typo into a browser that never
 * finishes a tick - but it is far past any experiment anyone has asked for
 * rather than a year, which a resistance study can genuinely outlast.
 */
export const MAX_DAYS = 3650;

export function experimentParamsFromQuery(q = new URLSearchParams(location.search)): ExperimentParams {
  const oxygenMode = parseOxygenMode(q.get('oxygenMode')) ?? DEFAULTS.oxygenMode;
  const preset = OXYGEN_PRESETS[oxygenMode];
  return {
    days: numberParam(q, 'days', DEFAULTS.days, 1, MAX_DAYS),
    dose: numberParam(q, 'dose', DEFAULTS.dose, 0, 5),
    schedule: parseSchedule(q.get('schedule')) ?? DEFAULTS.schedule,
    switchDay: numberParam(q, 'switchDay', DEFAULTS.switchDay, 0, MAX_DAYS),
    oxygenMode,
    oxygenSupply: numberParam(q, 'oxygenSupply', preset.oxygenSupply, 0.05, 2),
    oxygenUptake: numberParam(q, 'oxygenUptake', preset.oxygenUptake, 0.001, 0.08),
  };
}

export function applyLocalExperimentOverrides(raw: RulesFile, params: ExperimentParams): RulesFile {
  const rules = JSON.parse(JSON.stringify(raw)) as RulesFile;
  const tickMinutes = rules.time.tickMinutes;
  rules.time.maxTicks = Math.max(1, Math.round(params.days * 24 * 60 / tickMinutes));
  rules.time.keyframeEveryTicks = Math.max(1, Math.round(24 * 60 / tickMinutes));
  rules.oxygen.consumptionPerCell = params.oxygenUptake;
  rules.oxygen.maximum = Math.max(rules.oxygen.maximum ?? 1, params.oxygenSupply);
  if (rules.vasculature) rules.vasculature.oxygenSupply = params.oxygenSupply;
  rules.treatment = {
    ...(rules.treatment ?? {}),
    schedule: capToHumanMaximum(localTreatmentSchedule(params, rules), rules),
  };
  return rules;
}

export function oxygenPreset(mode: OxygenMode): Pick<ExperimentParams, 'oxygenSupply' | 'oxygenUptake'> {
  return OXYGEN_PRESETS[mode];
}

type Schedule = NonNullable<RulesFile['treatment']>['schedule'];

/**
 * Every dose held at or below the most of that drug people have been given
 * (doseLimits.ts). The requested dose is a single number shared by both drugs
 * of a switch, and each drug has its own ceiling, so the cap is per entry.
 */
export function capToHumanMaximum(schedule: Schedule, rules: RulesFile): Schedule {
  return (schedule ?? []).map((s) => {
    const drug = rules.drugs?.find((d) => d.id === s.drug);
    if (!drug) return s;
    return { ...s, amount: Math.min(s.amount, maxSafeAmount(rules, drug, s.everyHours)) };
  });
}

export interface DoseReport {
  drug: DrugSpec;
  everyHours: number;
  requested: number;
  applied: number;
  /** Roughly what `applied` is in mg per dose, when the drug's limits are known. */
  mg?: number;
  capped: boolean;
}

/** What each drug of the experiment will actually be given, for the panel to state. */
export function doseReport(params: ExperimentParams, rules: RulesFile): DoseReport[] {
  const out: DoseReport[] = [];
  for (const s of localTreatmentSchedule(params, rules) ?? []) {
    const drug = rules.drugs?.find((d) => d.id === s.drug);
    if (!drug || out.some((r) => r.drug.id === drug.id)) continue;
    const applied = Math.min(s.amount, maxSafeAmount(rules, drug, s.everyHours));
    out.push({
      drug, everyHours: s.everyHours, requested: s.amount, applied,
      mg: DOSE_LIMITS[drug.name] ? approxMgPerDose(rules, drug, applied) : undefined,
      capped: applied < s.amount - 1e-9,
    });
  }
  return out;
}

function localTreatmentSchedule(params: ExperimentParams, rules: RulesFile): NonNullable<RulesFile['treatment']>['schedule'] {
  if (params.schedule === 'none' || params.dose <= 0) return [];
  const gefitinib = rules.drugs?.find((d) => d.name === 'gefitinib') ?? rules.drugs?.[0];
  const osimertinib = rules.drugs?.find((d) => d.name === 'osimertinib');
  if (!gefitinib) return [];
  const totalDoses = Math.max(1, Math.ceil(params.days));
  const switchDoses = Math.max(0, Math.min(totalDoses, Math.ceil(params.switchDay)));
  if (params.schedule === 'gefitinib-osimertinib') {
    const schedule: NonNullable<RulesFile['treatment']>['schedule'] = [];
    if (switchDoses > 0) {
      schedule.push({ drug: gefitinib.id, startHour: 0, everyHours: 24, doses: switchDoses, amount: params.dose });
    }
    if (switchDoses < totalDoses) {
      // With no second drug there is nothing to switch to, so the first one
      // carries on. Stopping at the switch day instead would quietly drop the
      // rest of a run the caller asked to be treated.
      schedule.push({
        drug: (osimertinib ?? gefitinib).id,
        startHour: switchDoses * 24,
        everyHours: 24,
        doses: totalDoses - switchDoses,
        amount: params.dose,
      });
    }
    if (!schedule.length) {
      schedule.push({ drug: gefitinib.id, startHour: 0, everyHours: 24, doses: totalDoses, amount: params.dose });
    }
    return schedule;
  }
  if (params.schedule === 'adaptive-gefitinib') {
    return [{ drug: gefitinib.id, startHour: 0, everyHours: 48, doses: Math.ceil(totalDoses / 2), amount: params.dose }];
  }
  return [{ drug: gefitinib.id, startHour: 0, everyHours: 24, doses: totalDoses, amount: params.dose }];
}

function numberParam(q: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = q.get(name);
  // Number(null) is 0, not NaN, so an absent parameter has to be rejected
  // before the conversion - otherwise every default collapses to `min`.
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function parseSchedule(value: string | null): ExperimentSchedule | undefined {
  if (
    value === 'none' ||
    value === 'continuous-gefitinib' ||
    value === 'gefitinib-osimertinib' ||
    value === 'adaptive-gefitinib'
  ) return value;
  return undefined;
}

function parseOxygenMode(value: string | null): OxygenMode | undefined {
  if (value === 'default' || value === 'vascular' || value === 'hypoxic' || value === 'necrotic') return value;
  return undefined;
}

import type { RulesFile } from './sim/rules.js';

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

export function experimentParamsFromQuery(q = new URLSearchParams(location.search)): ExperimentParams {
  const oxygenMode = parseOxygenMode(q.get('oxygenMode')) ?? DEFAULTS.oxygenMode;
  const preset = OXYGEN_PRESETS[oxygenMode];
  return {
    days: numberParam(q, 'days', DEFAULTS.days, 1, 365),
    dose: numberParam(q, 'dose', DEFAULTS.dose, 0, 5),
    schedule: parseSchedule(q.get('schedule')) ?? DEFAULTS.schedule,
    switchDay: numberParam(q, 'switchDay', DEFAULTS.switchDay, 0, 365),
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
    schedule: localTreatmentSchedule(params, rules),
  };
  return rules;
}

export function oxygenPreset(mode: OxygenMode): Pick<ExperimentParams, 'oxygenSupply' | 'oxygenUptake'> {
  return OXYGEN_PRESETS[mode];
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
    if (osimertinib && switchDoses < totalDoses) {
      schedule.push({
        drug: osimertinib.id,
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
  const raw = Number(q.get(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
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

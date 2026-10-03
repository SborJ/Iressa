import { sourceKind } from './defaultRun.js';
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

export function localExperimentUrl(params: ExperimentParams): string {
  const q = new URLSearchParams(location.search);
  q.set('source', 'local');
  writeParams(q, params);
  q.delete('events');
  q.delete('keyframes');
  q.delete('rules');
  return `${location.pathname}?${q.toString()}`;
}

export function pythonExportCommand(params: ExperimentParams, name = 'custom-demo'): string {
  const parts = [
    'python3 scripts/export_iressa_run.py',
    `--name ${shellWord(name)}`,
    `--schedule ${shellWord(params.schedule)}`,
    `--days ${formatNumber(params.days)}`,
    `--dose ${formatNumber(params.dose)}`,
    `--switch-time ${formatNumber(params.switchDay)}`,
    `--oxygen-mode ${shellWord(params.oxygenMode)}`,
    `--oxygen-source ${formatNumber(params.oxygenSupply)}`,
    `--oxygen-uptake ${formatNumber(params.oxygenUptake)}`,
  ];
  return parts.join(' ');
}

export function isLocalSource(q = new URLSearchParams(location.search)): boolean {
  return sourceKind(q) === 'local';
}

export function oxygenPreset(mode: OxygenMode): Pick<ExperimentParams, 'oxygenSupply' | 'oxygenUptake'> {
  return OXYGEN_PRESETS[mode];
}

function writeParams(q: URLSearchParams, params: ExperimentParams): void {
  q.set('days', formatNumber(params.days));
  q.set('dose', formatNumber(params.dose));
  q.set('schedule', params.schedule);
  q.set('switchDay', formatNumber(params.switchDay));
  q.set('oxygenMode', params.oxygenMode);
  q.set('oxygenSupply', formatNumber(params.oxygenSupply));
  q.set('oxygenUptake', formatNumber(params.oxygenUptake));
}

function localTreatmentSchedule(params: ExperimentParams, rules: RulesFile): NonNullable<RulesFile['treatment']>['schedule'] {
  if (params.schedule === 'none' || params.dose <= 0) return [];
  const drug = rules.drugs?.find((d) => d.name === 'gefitinib') ?? rules.drugs?.[0];
  if (!drug) return [];
  const totalDoses = Math.max(1, Math.ceil(params.days));
  const switchDoses = Math.max(0, Math.min(totalDoses, Math.ceil(params.switchDay)));
  if (params.schedule === 'gefitinib-osimertinib') {
    return [{ drug: drug.id, startHour: 0, everyHours: 24, doses: switchDoses, amount: params.dose }];
  }
  if (params.schedule === 'adaptive-gefitinib') {
    return [{ drug: drug.id, startHour: 0, everyHours: 48, doses: Math.ceil(totalDoses / 2), amount: params.dose }];
  }
  return [{ drug: drug.id, startHour: 0, everyHours: 24, doses: totalDoses, amount: params.dose }];
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

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function shellWord(value: string): string {
  return /^[a-zA-Z0-9._/-]+$/.test(value) ? value : JSON.stringify(value);
}

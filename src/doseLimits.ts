import type { DrugSpec, RulesFile } from './sim/rules.js';

/**
 * The most of each drug a person has been given, as a plasma concentration.
 *
 * An experiment's dose is a model amount, not milligrams: it goes through the
 * one-compartment PK in rules.json and becomes a plasma concentration. Left
 * unbounded, a "daily dose" of 5 settles at several times the plasma level any
 * patient has reached, and the run is then about a poisoning, not a treatment.
 * So each drug's amount is capped at the one whose steady-state peak equals the
 * peak at the highest daily dose given to people.
 *
 * The ceilings are the highest doses with tolerable toxicity, not the approved
 * ones: the approved dose is shown for scale. Peak concentrations are steady
 * state, scaled linearly from the approved dose, which is what the label data
 * support (exposure is dose-proportional over these ranges).
 */
export interface DoseLimit {
  /** The approved daily dose, mg. */
  approvedMgPerDay: number;
  /** The highest daily dose people tolerated in dose-escalation trials, mg. */
  maxMgPerDay: number;
  /** Steady-state peak plasma concentration at maxMgPerDay, µM. */
  maxPeakMicromolar: number;
  /** Why that ceiling, in a sentence, with the source. */
  basis: string;
}

export const DOSE_LIMITS: Record<string, DoseLimit> = {
  gefitinib: {
    approvedMgPerDay: 250,
    maxMgPerDay: 700,
    // 250 mg/day: median steady-state trough 174 ng/mL (0.39 µM, MW 446.9);
    // with a 41 h half-life the peak is ~1.4x the trough, ~0.54 µM. x 700/250.
    maxPeakMicromolar: 1.5,
    basis:
      'Phase I trials of continuous daily gefitinib set a maximum tolerated dose of 600-700 mg/day; ' +
      '8 of 17 patients at 1000 mg/day had dose-limiting diarrhoea or rash ' +
      '(https://pmc.ncbi.nlm.nih.gov/articles/PMC4414209/, https://pmc.ncbi.nlm.nih.gov/articles/PMC6894987/). ' +
      'Approved 250 mg/day: median steady-state trough 174 ng/mL ' +
      '(https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4521154/).',
  },
  osimertinib: {
    approvedMgPerDay: 80,
    maxMgPerDay: 240,
    // 80 mg/day: steady-state Cmax 525 nmol/L, dose-proportional to 240 mg.
    maxPeakMicromolar: 1.575,
    basis:
      'Highest dose given in the AURA dose escalation (20-240 mg/day); no maximum tolerated dose was ' +
      'reached, but toxicity rose with dose (https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5995494/). ' +
      'Steady-state Cmax 525 nmol/L at 80 mg, dose-proportional over 20-240 mg ' +
      '(https://pmc.ncbi.nlm.nih.gov/articles/PMC5427226/).',
  },
  capmatinib: {
    approvedMgPerDay: 800,
    maxMgPerDay: 800,
    // 400 mg twice daily: steady-state Cmax 4780 ng/mL (MW 412.4) = 11.6 µM.
    maxPeakMicromolar: 11.6,
    basis:
      'Approved and recommended phase II dose 400 mg twice daily; no maximum tolerated dose was ' +
      'reached and no higher dose was taken forward (https://onlinelibrary.wiley.com/doi/10.1111/cas.14254). ' +
      'Steady-state Cmax 4780 ng/mL (TABRECTA label, ' +
      'https://www.accessdata.fda.gov/drugsatfda_docs/label/2022/213591s004lbl.pdf).',
  },
};

/**
 * True when a rules file states its concentrations in µM.
 *
 * Runs exported by the calibrated engine do (their IC50s carry an nM
 * provenance and are divided by 1000); the stand-in rules use an arbitrary
 * scale, where a µM ceiling would mean nothing, so they are not capped.
 */
export function concentrationsAreMicromolar(rules: RulesFile): boolean {
  return (rules.clones ?? []).some(
    (c) => (c as { provenance?: { ic50_nM?: unknown } }).provenance?.ic50_nM !== undefined,
  );
}

/**
 * Steady-state peak plasma concentration per unit amount, for one dose every
 * `everyHours`, stepped exactly as the simulator's Pharmacokinetics steps it.
 */
export function steadyStatePeakPerUnit(drug: DrugSpec, everyHours: number, stepHours = 0.5): number {
  const ka = drug.pk.absorptionPerHour;
  const ke = Math.LN2 / drug.pk.eliminationHalfLifeHours;
  const f = drug.pk.bioavailability ?? 1;
  const v = drug.pk.volumeOfDistribution ?? 1;
  // Ten half-lives is steady state to within 0.1%; the last interval holds the peak.
  const hours = Math.max(10 * drug.pk.eliminationHalfLifeHours, 4 * everyHours) + everyHours;
  const steps = Math.ceil(hours / stepHours);
  const doseEvery = Math.max(1, Math.round(everyHours / stepHours));
  let gut = 0;
  let plasma = 0;
  let peak = 0;
  for (let i = 0; i < steps; i++) {
    if (i % doseEvery === 0) gut += f;
    const absorbed = gut * (1 - Math.exp(-ka * stepHours));
    gut -= absorbed;
    plasma = plasma * Math.exp(-ke * stepHours) + absorbed / v;
    if (i >= steps - doseEvery) peak = Math.max(peak, plasma);
  }
  return peak;
}

/**
 * The largest amount of `drug` per dose, every `everyHours`, that keeps its
 * steady-state peak at or below what people have tolerated. Infinity when
 * the drug or the rules' units are not ones the limits know.
 */
export function maxSafeAmount(rules: RulesFile, drug: DrugSpec, everyHours: number): number {
  const limit = DOSE_LIMITS[drug.name];
  if (!limit || !concentrationsAreMicromolar(rules)) return Infinity;
  const byPeak = (hours: number) => {
    const perUnit = steadyStatePeakPerUnit(drug, hours);
    return perUnit > 0 ? limit.maxPeakMicromolar / perUnit : Infinity;
  };
  // Spacing doses further apart lowers the steady-state peak, which would let
  // one dose grow past anything given at once in a trial. No single dose may
  // exceed the highest daily dose, whatever the interval.
  return everyHours > 24 ? Math.min(byPeak(everyHours), byPeak(24)) : byPeak(everyHours);
}

/**
 * Roughly how many mg one model amount is. PK here is linear, so an amount
 * maps to the same mg whatever the interval: scale against the daily cap.
 */
export function approxMgPerDose(rules: RulesFile, drug: DrugSpec, amount: number): number | undefined {
  const limit = DOSE_LIMITS[drug.name];
  const dailyMax = maxSafeAmount(rules, drug, 24);
  if (!limit || !Number.isFinite(dailyMax)) return undefined;
  return (amount / dailyMax) * limit.maxMgPerDay;
}

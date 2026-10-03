import Ajv from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

/* ------------------------------------------------------------------ *
 * Shapes, mirroring data/schema/rules.schema.json.
 * ------------------------------------------------------------------ */

export type CauseKind = 'divide' | 'death' | 'arrest' | 'mutation' | 'removal' | 'damage';

export type CauseRole =
  | 'normalCycle'
  | 'baselineApoptosis'
  | 'drugApoptosis'
  | 'hypoxicNecrosis'
  | 'radiation'
  | 'crowdingArrest'
  | 'hypoxiaArrest'
  | 'drugArrest'
  | 'immuneKill'
  | 'mutation';

export type StateRole = 'cycling' | 'arrested' | 'damaged' | 'dying';

export interface CauseSpec {
  id: number;
  name: string;
  kind: CauseKind;
  animation: string;
  role?: CauseRole;
  label?: string;
  dyingTicks?: number;
}

export interface StateSpec {
  id: number;
  name: string;
  label?: string;
  role?: StateRole;
  alive?: boolean;
  occupies?: boolean;
}

export interface DrugSensitivitySpec {
  drug: number;
  ic50: number;
  hill: number;
  killMaxPerHour: number;
}

export interface CloneSpec {
  id: number;
  name: string;
  derivesFrom?: number;
  cycleHours?: number;
  baselineDeathPerHour?: number;
  fitnessCost?: number;
  immuneVisibility?: number;
  drugSensitivity?: DrugSensitivitySpec[];
}

export interface MutationSpec {
  id: number;
  name: string;
  fromClone: number;
  toClone: number;
  ratePerDivision: number;
  multipliers?: {
    cycleHours?: number;
    baselineDeathPerHour?: number;
    immuneVisibility?: number;
    drugIc50?: Record<string, number>;
    drugKillMax?: Record<string, number>;
  };
}

export interface DrugSpec {
  id: number;
  name: string;
  displayName?: string;
  pk: {
    absorptionPerHour: number;
    eliminationHalfLifeHours: number;
    bioavailability?: number;
    volumeOfDistribution?: number;
  };
  penetration: { diffusion: number; uptakePerCell: number; relaxSweepsPerTick: number };
  cytostatic?: { maxSlowdown: number; ic50: number; ic50Ratio?: number; hill: number };
  arrestThreshold?: number;
}

export interface VasculatureSpec {
  trunks: number;
  maxDepth: number;
  segmentLengthVoxels: number;
  tortuosity: number;
  branchAngle: number;
  branchEverySegments: number;
  trunkRadiusVoxels: number;
  minRadiusVoxels: number;
  murrayExponent?: number;
  wallThicknessVoxels: number;
  oxygenSupply?: number;
  drugSupplyFraction?: number;
  /** Explicit network from an external simulation; when present, growth is skipped. */
  segments?: {
    ax: number; ay: number; az: number;
    bx: number; by: number; bz: number;
    ra: number; rb: number; depth: number; parent: number;
  }[];
}

export interface RulesFile {
  version: 1;
  seed: number;
  time: { tickMinutes: number; maxTicks?: number; keyframeEveryTicks?: number };
  grid: { nx: number; ny: number; nz: number; voxelMicrons: number; neighborhood?: 6 | 18 | 26 };
  seeding: {
    clone: number;
    radiusVoxels: number;
    center?: [number, number, number];
    snapToVessel?: boolean;
  };
  vasculature?: VasculatureSpec;
  oxygen: {
    boundary: number;
    maximum?: number;
    diffusion: number;
    consumptionPerCell: number;
    debrisConsumptionFactor?: number;
    relaxSweepsPerTick: number;
    proliferationHalfMax: number;
    arrestThreshold: number;
    necrosisThreshold: number;
    necrosisTicks: number;
    necrosisHazardPerHour?: number;
  };
  drugs?: DrugSpec[];
  treatment?: {
    schedule?: { drug: number; startHour: number; everyHours: number; doses: number; amount: number }[];
    radiation?: { hour: number; doseGy: number }[];
  };
  radiation?: {
    alphaPerGy: number;
    betaPerGy2: number;
    oxygenEnhancementRatio?: number;
    oxygenHalfMax?: number;
    mitoticCatastropheFraction?: number;
  };
  immune?: { killPerHour: number; surfaceOnly?: boolean };
  clones: CloneSpec[];
  mutations?: MutationSpec[];
  states: StateSpec[];
  causes: CauseSpec[];
  clearance?: { defaultDyingTicks?: number };
}

/* ------------------------------------------------------------------ *
 * Resolved form: what the simulator actually reads.
 * ------------------------------------------------------------------ */

export interface CloneProfile {
  id: number;
  name: string;
  /** Cycle time after the fitness cost is applied. */
  cycleHours: number;
  baselineDeathPerHour: number;
  immuneVisibility: number;
  fitnessCost: number;
  /** Indexed by drug id. */
  drug: (DrugSensitivitySpec | undefined)[];
}

export interface MutationEdge extends MutationSpec {
  multipliers: NonNullable<MutationSpec['multipliers']>;
}

export interface ResolvedRules {
  raw: RulesFile;
  hoursPerTick: number;
  ticksPerDay: number;
  maxTicks: number;
  keyframeEveryTicks: number;
  nodeCount: number;
  /** Clone profiles indexed by clone id (sparse ids are allowed). */
  clones: (CloneProfile | undefined)[];
  cloneIds: number[];
  /** Mutation edges grouped by the clone they can arise on. */
  mutationsByClone: Map<number, MutationEdge[]>;
  causeById: Map<number, CauseSpec>;
  causeByRole: Map<CauseRole, CauseSpec>;
  stateById: Map<number, StateSpec>;
  stateByRole: Map<StateRole, StateSpec>;
  drugById: Map<number, DrugSpec>;
  drugIds: number[];
  /** Ticks a node spends dying before it is removed, indexed by cause id. */
  dyingTicksByCause: Map<number, number>;
}

/* ------------------------------------------------------------------ *
 * Validation.
 * ------------------------------------------------------------------ */

export class RulesError extends Error {
  constructor(message: string, readonly problems: string[]) {
    super(message);
    this.name = 'RulesError';
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

let cachedValidator: ValidateFunction | undefined;

export function compileRulesValidator(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
  return ajv.compile(schema);
}

/** Roles the stand-in simulator cannot run without. */
const REQUIRED_CAUSE_ROLES: CauseRole[] = [
  'normalCycle',
  'baselineApoptosis',
  'hypoxicNecrosis',
  'crowdingArrest',
  'hypoxiaArrest',
  'mutation',
];
const REQUIRED_STATE_ROLES: StateRole[] = ['cycling', 'arrested', 'dying'];

/**
 * Cross-reference checks a JSON schema cannot express: ids that must point at
 * something, roles the simulator resolves, and clone inheritance cycles.
 */
function crossCheck(r: RulesFile): string[] {
  const problems: string[] = [];
  const cloneIds = new Set(r.clones.map((c) => c.id));
  const drugIds = new Set((r.drugs ?? []).map((d) => d.id));

  const dupe = <T>(items: T[], key: (t: T) => number, what: string) => {
    const seen = new Set<number>();
    for (const it of items) {
      const k = key(it);
      if (seen.has(k)) problems.push(`duplicate ${what} id ${k}`);
      seen.add(k);
    }
  };
  dupe(r.clones, (c) => c.id, 'clone');
  dupe(r.causes, (c) => c.id, 'cause');
  dupe(r.states, (s) => s.id, 'state');
  dupe(r.drugs ?? [], (d) => d.id, 'drug');
  dupe(r.mutations ?? [], (m) => m.id, 'mutation');

  if (!cloneIds.has(r.seeding.clone)) {
    problems.push(`seeding.clone ${r.seeding.clone} is not a declared clone`);
  }
  for (const c of r.clones) {
    if (c.derivesFrom !== undefined && !cloneIds.has(c.derivesFrom)) {
      problems.push(`clone ${c.id} derivesFrom ${c.derivesFrom}, which is not a declared clone`);
    }
    for (const ds of c.drugSensitivity ?? []) {
      if (!drugIds.has(ds.drug)) {
        problems.push(`clone ${c.id} has sensitivity to drug ${ds.drug}, which is not declared`);
      }
    }
  }
  for (const m of r.mutations ?? []) {
    if (!cloneIds.has(m.fromClone)) problems.push(`mutation ${m.id} fromClone ${m.fromClone} is not declared`);
    if (!cloneIds.has(m.toClone)) problems.push(`mutation ${m.id} toClone ${m.toClone} is not declared`);
    if (m.fromClone === m.toClone) problems.push(`mutation ${m.id} maps clone ${m.fromClone} to itself`);
    for (const key of Object.keys(m.multipliers?.drugIc50 ?? {})) {
      if (!drugIds.has(Number(key))) problems.push(`mutation ${m.id} drugIc50 names drug ${key}, which is not declared`);
    }
    for (const key of Object.keys(m.multipliers?.drugKillMax ?? {})) {
      if (!drugIds.has(Number(key))) problems.push(`mutation ${m.id} drugKillMax names drug ${key}, which is not declared`);
    }
  }
  for (const s of r.treatment?.schedule ?? []) {
    if (!drugIds.has(s.drug)) problems.push(`treatment schedule names drug ${s.drug}, which is not declared`);
  }
  if ((r.treatment?.radiation ?? []).length > 0 && !r.radiation) {
    problems.push('treatment.radiation is scheduled but the radiation model block is missing');
  }

  // Roles must be unique and complete.
  const causeRoles = new Map<string, number>();
  for (const c of r.causes) {
    if (!c.role) continue;
    if (causeRoles.has(c.role)) {
      problems.push(`cause role "${c.role}" is claimed by both cause ${causeRoles.get(c.role)} and ${c.id}`);
    }
    causeRoles.set(c.role, c.id);
  }
  for (const role of REQUIRED_CAUSE_ROLES) {
    if (!causeRoles.has(role)) problems.push(`no cause declares role "${role}"`);
  }
  if ((r.drugs ?? []).length > 0) {
    for (const role of ['drugApoptosis', 'drugArrest'] as CauseRole[]) {
      if (!causeRoles.has(role)) problems.push(`drugs are declared but no cause declares role "${role}"`);
    }
  }
  if ((r.treatment?.radiation ?? []).length > 0 && !causeRoles.has('radiation')) {
    problems.push('radiation is scheduled but no cause declares role "radiation"');
  }
  if ((r.immune?.killPerHour ?? 0) > 0 && !causeRoles.has('immuneKill')) {
    problems.push('immune.killPerHour is above zero but no cause declares role "immuneKill"');
  }

  const stateRoles = new Map<string, number>();
  for (const s of r.states) {
    if (!s.role) continue;
    if (stateRoles.has(s.role)) {
      problems.push(`state role "${s.role}" is claimed by both state ${stateRoles.get(s.role)} and ${s.id}`);
    }
    stateRoles.set(s.role, s.id);
  }
  for (const role of REQUIRED_STATE_ROLES) {
    if (!stateRoles.has(role)) problems.push(`no state declares role "${role}"`);
  }
  if ((r.treatment?.radiation ?? []).length > 0 && !stateRoles.has('damaged')) {
    problems.push('radiation is scheduled but no state declares role "damaged"');
  }

  // Inheritance must terminate.
  for (const c of r.clones) {
    const seen = new Set<number>([c.id]);
    let cur = c.derivesFrom;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        problems.push(`clone inheritance cycle through clone ${c.id}`);
        break;
      }
      seen.add(cur);
      cur = r.clones.find((x) => x.id === cur)?.derivesFrom;
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Clone profile resolution.
 *
 * A derived clone starts from its parent's resolved profile, has the
 * multipliers of the mutation that creates it applied, and then any field it
 * states explicitly overrides the result. So a mutation is described once, as
 * data, and the clone entry only has to carry what makes it different.
 * ------------------------------------------------------------------ */

function emptyProfile(spec: CloneSpec): CloneProfile {
  return {
    id: spec.id,
    name: spec.name,
    cycleHours: 24,
    baselineDeathPerHour: 0,
    immuneVisibility: 1,
    fitnessCost: 0,
    drug: [],
  };
}

function cloneProfile(p: CloneProfile): CloneProfile {
  return { ...p, drug: p.drug.map((d) => (d ? { ...d } : undefined)) };
}

function resolveClones(r: RulesFile): { clones: (CloneProfile | undefined)[]; problems: string[] } {
  const problems: string[] = [];
  const specById = new Map(r.clones.map((c) => [c.id, c]));
  const mutationTo = new Map<number, MutationSpec>();
  for (const m of r.mutations ?? []) mutationTo.set(m.toClone, m);

  const out: (CloneProfile | undefined)[] = [];
  const resolving = new Set<number>();

  const resolve = (id: number): CloneProfile | undefined => {
    if (out[id]) return out[id];
    const spec = specById.get(id);
    if (!spec) return undefined;
    if (resolving.has(id)) return undefined;
    resolving.add(id);

    let prof: CloneProfile;
    if (spec.derivesFrom !== undefined) {
      const parent = resolve(spec.derivesFrom);
      if (!parent) {
        problems.push(`clone ${id} cannot resolve its parent ${spec.derivesFrom}`);
        prof = emptyProfile(spec);
      } else {
        prof = cloneProfile(parent);
        prof.id = spec.id;
        prof.name = spec.name;
        const mult = mutationTo.get(id)?.multipliers;
        if (mult) {
          if (mult.cycleHours !== undefined) prof.cycleHours *= mult.cycleHours;
          if (mult.baselineDeathPerHour !== undefined) prof.baselineDeathPerHour *= mult.baselineDeathPerHour;
          if (mult.immuneVisibility !== undefined) prof.immuneVisibility *= mult.immuneVisibility;
          for (const [drugKey, factor] of Object.entries(mult.drugIc50 ?? {})) {
            const d = prof.drug[Number(drugKey)];
            if (d) d.ic50 *= factor;
          }
          for (const [drugKey, factor] of Object.entries(mult.drugKillMax ?? {})) {
            const d = prof.drug[Number(drugKey)];
            if (d) d.killMaxPerHour *= factor;
          }
        }
        // The parent's cycleHours already carries the parent's fitness cost;
        // strip it so this clone's own cost is the only one applied.
        if (parent.fitnessCost > 0) prof.cycleHours /= 1 + parent.fitnessCost;
        prof.fitnessCost = 0;
      }
    } else {
      prof = emptyProfile(spec);
      if (spec.cycleHours === undefined) {
        problems.push(`root clone ${id} must state cycleHours`);
      }
    }

    if (spec.cycleHours !== undefined) prof.cycleHours = spec.cycleHours;
    if (spec.baselineDeathPerHour !== undefined) prof.baselineDeathPerHour = spec.baselineDeathPerHour;
    if (spec.immuneVisibility !== undefined) prof.immuneVisibility = spec.immuneVisibility;
    if (spec.fitnessCost !== undefined) prof.fitnessCost = spec.fitnessCost;
    for (const ds of spec.drugSensitivity ?? []) prof.drug[ds.drug] = { ...ds };

    prof.cycleHours *= 1 + prof.fitnessCost;

    resolving.delete(id);
    out[id] = prof;
    return prof;
  };

  for (const c of r.clones) resolve(c.id);
  return { clones: out, problems };
}

/* ------------------------------------------------------------------ *
 * Entry points.
 * ------------------------------------------------------------------ */

export function validateRules(raw: unknown, schema: object): RulesFile {
  const validator = cachedValidator ?? (cachedValidator = compileRulesValidator(schema));
  if (!validator(raw)) {
    throw new RulesError('rules.json does not match its schema', formatAjvErrors(validator.errors));
  }
  const problems = crossCheck(raw as RulesFile);
  if (problems.length) throw new RulesError('rules.json is inconsistent', problems);
  return raw as RulesFile;
}

export function resolveRules(raw: RulesFile): ResolvedRules {
  const { clones, problems } = resolveClones(raw);
  if (problems.length) throw new RulesError('rules.json clone profiles cannot be resolved', problems);

  const hoursPerTick = raw.time.tickMinutes / 60;
  const mutationsByClone = new Map<number, MutationEdge[]>();
  for (const m of raw.mutations ?? []) {
    const list = mutationsByClone.get(m.fromClone) ?? [];
    list.push({ ...m, multipliers: m.multipliers ?? {} });
    mutationsByClone.set(m.fromClone, list);
  }

  const causeById = new Map(raw.causes.map((c) => [c.id, c]));
  const causeByRole = new Map<CauseRole, CauseSpec>();
  for (const c of raw.causes) if (c.role) causeByRole.set(c.role, c);

  const stateById = new Map(raw.states.map((s) => [s.id, s]));
  const stateByRole = new Map<StateRole, StateSpec>();
  for (const s of raw.states) if (s.role) stateByRole.set(s.role, s);

  const drugById = new Map((raw.drugs ?? []).map((d) => [d.id, d]));
  const defaultDying = raw.clearance?.defaultDyingTicks ?? 8;
  const dyingTicksByCause = new Map<number, number>();
  for (const c of raw.causes) dyingTicksByCause.set(c.id, c.dyingTicks ?? defaultDying);

  return {
    raw,
    hoursPerTick,
    ticksPerDay: Math.max(1, Math.round(24 / hoursPerTick)),
    maxTicks: raw.time.maxTicks ?? 2880,
    keyframeEveryTicks: raw.time.keyframeEveryTicks ?? 240,
    nodeCount: raw.grid.nx * raw.grid.ny * raw.grid.nz,
    clones,
    cloneIds: raw.clones.map((c) => c.id),
    mutationsByClone,
    causeById,
    causeByRole,
    stateById,
    stateByRole,
    drugById,
    drugIds: (raw.drugs ?? []).map((d) => d.id),
    dyingTicksByCause,
  };
}

export function loadRules(raw: unknown, schema: object): ResolvedRules {
  return resolveRules(validateRules(raw, schema));
}

/** Throws with a clear message rather than returning undefined mid-tick. */
export function requireCause(rules: ResolvedRules, role: CauseRole): number {
  const c = rules.causeByRole.get(role);
  if (!c) throw new RulesError(`no cause declares role "${role}"`, [role]);
  return c.id;
}

export function requireState(rules: ResolvedRules, role: StateRole): number {
  const s = rules.stateByRole.get(role);
  if (!s) throw new RulesError(`no state declares role "${role}"`, [role]);
  return s.id;
}

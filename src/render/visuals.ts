import Ajv from 'ajv';
import type { ErrorObject } from 'ajv';
import type { ResolvedRules } from '../sim/rules.js';

export type CurveName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'pulse' | 'step';

export const CURVE_IDS: Record<CurveName, number> = {
  linear: 0,
  easeIn: 1,
  easeOut: 2,
  easeInOut: 3,
  pulse: 4,
  step: 5,
};

export interface PresetSpec {
  durationTicks: number;
  scaleTarget?: number;
  scaleCurve?: CurveName;
  swell?: number;
  alphaTarget?: number;
  alphaCurve?: CurveName;
  tint?: string;
  tintFrom?: 'fixed' | 'drug' | 'clone';
  tintAmount?: number;
  tintCurve?: CurveName;
  desaturate?: number;
  bleb?: number;
  blebFrequency?: number;
  blebDrift?: number;
  fragments?: number;
  fragmentSpread?: number;
  nuclei?: number;
  nucleiBulge?: number;
  emissive?: number;
  flashTicks?: number;
}

export interface VisualsFile {
  version: 1;
  scene: { background: string; fogDensity?: number; ambient?: number; keyLight?: number; rimLight?: number };
  cell: { radiusFraction: number; detail?: number };
  cloneColors: Record<string, string>;
  causeColors: Record<string, string>;
  drugColors?: Record<string, string>;
  stateFallbackPresets?: Record<string, string>;
  byEvent?: Record<string, string>;
  byCause?: Record<string, string>;
  presets: Record<string, PresetSpec>;
}

export class VisualsError extends Error {
  constructor(message: string, readonly problems: string[]) {
    super(message);
    this.name = 'VisualsError';
  }
}

export type RGB = readonly [number, number, number];

/**
 * A preset is 5 vec4s, copied into per-instance attributes. Passing them per
 * instance rather than as an indexed uniform array keeps the shader within
 * what every GLSL target allows, and they only change when an event changes
 * the slot anyway.
 */
export const PRESET_VEC4S = 5;
export const PRESET_FLOATS = PRESET_VEC4S * 4;

const IDENTITY_PRESET: PresetSpec = { durationTicks: 0 };

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function parseColor(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [
    srgbToLinear(((n >> 16) & 0xff) / 255),
    srgbToLinear(((n >> 8) & 0xff) / 255),
    srgbToLinear((n & 0xff) / 255),
  ];
}

/**
 * visuals.json, resolved.
 *
 * The renderer asks this for two things: which preset a (type, cause) pair
 * uses, and what colour something is. Both answers come out of the data files;
 * there is no cause, no colour and no duration written in code.
 */
export class Visuals {
  readonly raw: VisualsFile;
  readonly presetNames: string[] = [];
  readonly presetIndex = new Map<string, number>();
  /** Packed per-preset payload: presetCount * PRESET_FLOATS. Copied into instance attributes. */
  readonly presetParams: Float32Array;
  /** Per-preset tint source and colour, applied per instance on the CPU. */
  readonly presetTintFrom: Uint8Array;
  readonly presetTint: Float32Array;

  private cloneColorCache = new Map<number, RGB>();
  private causeColorCache = new Map<number, RGB>();
  private drugColorCache = new Map<number, RGB>();
  private resolveCache = new Map<number, number>();

  constructor(raw: VisualsFile, private rules: ResolvedRules) {
    this.raw = raw;
    const names = Object.keys(raw.presets);
    if (!names.includes('normal')) names.unshift('normal');
    this.presetParams = new Float32Array(names.length * PRESET_FLOATS);
    this.presetTintFrom = new Uint8Array(names.length);
    this.presetTint = new Float32Array(names.length * 3);
    names.forEach((name, i) => {
      this.presetNames.push(name);
      this.presetIndex.set(name, i);
      this.packPreset(i, raw.presets[name] ?? IDENTITY_PRESET);
    });
  }

  private packPreset(i: number, p: PresetSpec): void {
    const o = i * PRESET_FLOATS;
    const f = this.presetParams;
    const curve = (c: CurveName | undefined, dflt: CurveName) => CURVE_IDS[c ?? dflt];

    f[o + 0] = p.durationTicks;
    f[o + 1] = p.scaleTarget ?? 1;
    f[o + 2] = curve(p.scaleCurve, 'easeInOut');
    f[o + 3] = p.alphaTarget ?? 1;

    f[o + 4] = p.swell ?? 0;
    f[o + 5] = p.bleb ?? 0;
    f[o + 6] = p.blebFrequency ?? 6;
    f[o + 7] = p.blebDrift ?? 1;

    f[o + 8] = p.fragments ?? 0;
    f[o + 9] = p.fragmentSpread ?? 0;
    f[o + 10] = p.nuclei ?? 0;
    f[o + 11] = p.nucleiBulge ?? 0.18;

    f[o + 12] = p.tintAmount ?? 0;
    f[o + 13] = curve(p.tintCurve, 'linear');
    f[o + 14] = p.desaturate ?? 0;
    f[o + 15] = p.emissive ?? 0;

    f[o + 16] = p.flashTicks ?? 0;
    f[o + 17] = curve(p.alphaCurve, 'easeIn');
    // 18 and 19 are filled per instance with the animation start tick and the
    // cell's own random seed.
    f[o + 18] = 0;
    f[o + 19] = 0;

    this.presetTintFrom[i] = p.tintFrom === 'drug' ? 1 : p.tintFrom === 'clone' ? 2 : 0;
    const tint = p.tint ? parseColor(p.tint) : ([1, 1, 1] as RGB);
    this.presetTint[i * 3 + 0] = tint[0];
    this.presetTint[i * 3 + 1] = tint[1];
    this.presetTint[i * 3 + 2] = tint[2];
  }

  /**
   * Which preset plays for an event. Most specific wins:
   * visuals.byEvent["type:cause"], then visuals.byCause[cause], then the
   * animation the cause names in rules.json.
   */
  presetFor(type: number, cause: number): number {
    const key = type * 256 + cause;
    const hit = this.resolveCache.get(key);
    if (hit !== undefined) return hit;
    const name =
      this.raw.byEvent?.[`${type}:${cause}`] ??
      this.raw.byCause?.[String(cause)] ??
      this.rules.causeById.get(cause)?.animation ??
      'normal';
    const idx = this.presetIndex.get(name) ?? this.presetIndex.get('normal') ?? 0;
    this.resolveCache.set(key, idx);
    return idx;
  }

  presetForState(state: number): number {
    const name = this.raw.stateFallbackPresets?.[String(state)] ?? 'normal';
    return this.presetIndex.get(name) ?? 0;
  }

  cloneColor(id: number): RGB {
    let c = this.cloneColorCache.get(id);
    if (!c) {
      const hex = this.raw.cloneColors[String(id)] ?? '#888888';
      c = parseColor(hex);
      this.cloneColorCache.set(id, c);
    }
    return c;
  }

  causeColor(id: number): RGB {
    let c = this.causeColorCache.get(id);
    if (!c) {
      const hex = this.raw.causeColors[String(id)] ?? '#888888';
      c = parseColor(hex);
      this.causeColorCache.set(id, c);
    }
    return c;
  }

  drugColor(id: number): RGB {
    let c = this.drugColorCache.get(id);
    if (!c) {
      const hex = this.raw.drugColors?.[String(id)] ?? '#ffffff';
      c = parseColor(hex);
      this.drugColorCache.set(id, c);
    }
    return c;
  }

  cloneCss(id: number): string {
    return this.raw.cloneColors[String(id)] ?? '#888888';
  }

  causeCss(id: number): string {
    return this.raw.causeColors[String(id)] ?? '#888888';
  }

  drugCss(id: number): string {
    return this.raw.drugColors?.[String(id)] ?? '#ffffff';
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

/**
 * Cross-checks between the two data files. These are what make "adding a cause
 * is a data change" safe: forget the preset or the colour and startup says so
 * instead of silently drawing a grey ball.
 */
function crossCheck(v: VisualsFile, rules: ResolvedRules): string[] {
  const problems: string[] = [];
  const presets = new Set(Object.keys(v.presets));
  presets.add('normal');

  for (const cause of rules.raw.causes) {
    if (!presets.has(cause.animation)) {
      problems.push(`cause ${cause.id} ("${cause.name}") names animation "${cause.animation}", which visuals.json does not define`);
    }
    if (!v.causeColors[String(cause.id)]) {
      problems.push(`cause ${cause.id} ("${cause.name}") has no entry in causeColors`);
    }
  }
  for (const clone of rules.raw.clones) {
    if (!v.cloneColors[String(clone.id)]) {
      problems.push(`clone ${clone.id} ("${clone.name}") has no entry in cloneColors`);
    }
  }
  for (const drug of rules.raw.drugs ?? []) {
    const needsColor = Object.values(v.presets).some((p) => p.tintFrom === 'drug');
    if (needsColor && !v.drugColors?.[String(drug.id)]) {
      problems.push(`a preset tints from the drug but drug ${drug.id} ("${drug.name}") has no entry in drugColors`);
    }
  }
  for (const [key, name] of Object.entries(v.byEvent ?? {})) {
    if (!presets.has(name)) problems.push(`byEvent["${key}"] names preset "${name}", which is not defined`);
    if (!/^\d+:\d+$/.test(key)) problems.push(`byEvent key "${key}" is not "<eventType>:<causeId>"`);
    else {
      const cause = Number(key.split(':')[1]);
      if (!rules.causeById.has(cause)) problems.push(`byEvent["${key}"] names cause ${cause}, which rules.json does not declare`);
    }
  }
  for (const [key, name] of Object.entries(v.byCause ?? {})) {
    if (!presets.has(name)) problems.push(`byCause["${key}"] names preset "${name}", which is not defined`);
    if (!rules.causeById.has(Number(key))) problems.push(`byCause["${key}"] names a cause rules.json does not declare`);
  }
  for (const [key, name] of Object.entries(v.stateFallbackPresets ?? {})) {
    if (!presets.has(name)) problems.push(`stateFallbackPresets["${key}"] names preset "${name}", which is not defined`);
    if (!rules.stateById.has(Number(key))) problems.push(`stateFallbackPresets["${key}"] names a state rules.json does not declare`);
  }
  for (const [name, p] of Object.entries(v.presets)) {
    if ((p.tintFrom ?? 'fixed') === 'fixed' && (p.tintAmount ?? 0) > 0 && !p.tint) {
      problems.push(`preset "${name}" tints but states no tint colour`);
    }
  }
  return problems;
}

export function loadVisuals(raw: unknown, schema: object, rules: ResolvedRules): Visuals {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(raw)) {
    throw new VisualsError('visuals.json does not match its schema', formatAjvErrors(validate.errors));
  }
  const problems = crossCheck(raw as VisualsFile, rules);
  if (problems.length) throw new VisualsError('visuals.json and rules.json disagree', problems);
  return new Visuals(raw as VisualsFile, rules);
}

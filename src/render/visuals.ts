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
  grain?: number;
  nucleusScale?: number;
  nucleusFade?: number;
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

export interface LightSpec {
  direction: [number, number, number];
  color: string;
  intensity: number;
}

export interface ViewSpec {
  label: string;
  description?: string;
  background: string;
  exposure?: number;
  emissionOnly?: boolean;
  lights: { key: LightSpec; fill: LightSpec; rim: LightSpec; sky: string; ground: string };
  material: {
    roughness: number;
    clearcoat: number;
    sheen: number;
    thickness: number;
    subsurface: string;
  };
  cloneColors: Record<string, string>;
  causeColors?: Record<string, string>;
  nucleus: string;
  presetOverrides?: Record<string, Partial<PresetSpec>>;
  slabVoxels?: number;
  surfaceEmission?: number;
  surface?: string;
  surfaceSubsurface?: string;
  vesselWall?: string;
  blood?: string;
  empty?: string;
  post: {
    fogDensity: number;
    ao: number;
    aoRadius?: number;
    membrane: number;
    membraneDarkness?: number;
    bloom?: number;
    bloomThreshold?: number;
    mosaic?: number;
    grain?: number;
  };
}

export interface CellSpec {
  radiusFraction: number;
  restingScale?: number;
  jitterVoxels?: number;
  sizeVariation?: number;
  wobbleAmplitude?: number;
  wobbleFrequency?: number;
  nucleusOffsetFraction?: number;
  grainScale?: number;
  detail?: number;
  nucleusDetail?: number;
  slabVoxels?: number;
}

export interface VisualsFile {
  version: 1;
  scene: { background: string; fogDensity?: number; ambient?: number; keyLight?: number; rimLight?: number };
  cell: CellSpec;
  defaultView?: string;
  views: Record<string, ViewSpec>;
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
export const PRESET_VEC4S = 6;
export const PRESET_FLOATS = PRESET_VEC4S * 4;

const IDENTITY_PRESET: PresetSpec = { durationTicks: 0 };

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearFromHex(hex: string): RGB {
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
  /**
   * Packed per-preset payload: presetCount * PRESET_FLOATS, copied into
   * instance attributes. One set per view, because a view may adjust a preset:
   * a necrotic cell is pale in a cleared sample and simply dark in a
   * fluorescence image, since it has stopped expressing.
   */
  readonly presetParams: Float32Array;
  private readonly byView = new Map<string, {
    params: Float32Array;
    tintFrom: Uint8Array;
    tint: Float32Array;
  }>();
  /** Per-preset tint source and colour, applied per instance on the CPU. */
  readonly presetTintFrom: Uint8Array;
  readonly presetTint: Float32Array;

  private cloneColorCache = new Map<number, RGB>();
  private causeColorCache = new Map<number, RGB>();
  private drugColorCache = new Map<number, RGB>();
  private resolveCache = new Map<number, number>();
  private viewCloneCache = new Map<string, RGB>();
  private viewCauseCache = new Map<string, RGB>();

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
      this.packPreset(i, raw.presets[name] ?? IDENTITY_PRESET, {
        params: this.presetParams,
        tintFrom: this.presetTintFrom,
        tint: this.presetTint,
      });
    });

    /* One packed set per view. A view may patch a preset, so a necrotic cell
       can be pale in a cleared sample, pale pink in a section and simply dark
       under fluorescence, where it has stopped expressing. */
    for (const [viewName, view] of Object.entries(raw.views)) {
      const target = {
        params: this.presetParams.slice(),
        tintFrom: this.presetTintFrom.slice(),
        tint: this.presetTint.slice(),
      };
      for (const [presetName, patch] of Object.entries(view.presetOverrides ?? {})) {
        const i = this.presetIndex.get(presetName);
        if (i === undefined) continue;
        this.packPreset(i, { ...(raw.presets[presetName] ?? IDENTITY_PRESET), ...patch }, target);
      }
      this.byView.set(viewName, target);
    }
  }

  /** Preset payload as the named view wants it. */
  paramsFor(viewName: string): Float32Array {
    return this.byView.get(viewName)?.params ?? this.presetParams;
  }

  tintFromFor(viewName: string): Uint8Array {
    return this.byView.get(viewName)?.tintFrom ?? this.presetTintFrom;
  }

  tintFor(viewName: string): Float32Array {
    return this.byView.get(viewName)?.tint ?? this.presetTint;
  }

  private packPreset(
    i: number,
    p: PresetSpec,
    into: { params: Float32Array; tintFrom: Uint8Array; tint: Float32Array },
  ): void {
    const o = i * PRESET_FLOATS;
    const f = into.params;
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

    f[o + 20] = p.grain ?? 0;
    f[o + 21] = p.nucleusScale ?? 0.5;
    f[o + 22] = p.nucleusFade ?? 0;
    f[o + 23] = 0;

    into.tintFrom[i] = p.tintFrom === 'drug' ? 1 : p.tintFrom === 'clone' ? 2 : 0;
    const tint = p.tint ? linearFromHex(p.tint) : ([1, 1, 1] as RGB);
    into.tint[i * 3 + 0] = tint[0];
    into.tint[i * 3 + 1] = tint[1];
    into.tint[i * 3 + 2] = tint[2];
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
      c = linearFromHex(hex);
      this.cloneColorCache.set(id, c);
    }
    return c;
  }

  causeColor(id: number): RGB {
    let c = this.causeColorCache.get(id);
    if (!c) {
      const hex = this.raw.causeColors[String(id)] ?? '#888888';
      c = linearFromHex(hex);
      this.causeColorCache.set(id, c);
    }
    return c;
  }

  drugColor(id: number): RGB {
    let c = this.drugColorCache.get(id);
    if (!c) {
      const hex = this.raw.drugColors?.[String(id)] ?? '#ffffff';
      c = linearFromHex(hex);
      this.drugColorCache.set(id, c);
    }
    return c;
  }

  /** The imaging views, in declaration order. */
  get viewNames(): string[] {
    return Object.keys(this.raw.views);
  }

  view(name: string): ViewSpec {
    return this.raw.views[name] ?? this.raw.views[this.defaultViewName];
  }

  get defaultViewName(): string {
    const wanted = this.raw.defaultView;
    if (wanted && this.raw.views[wanted]) return wanted;
    return Object.keys(this.raw.views)[0];
  }

  /** Scene colour for a clone in a given view, falling back to the UI palette. */
  viewCloneColor(viewName: string, id: number): RGB {
    const key = `${viewName}:${id}`;
    let c = this.viewCloneCache.get(key);
    if (!c) {
      const hex = this.view(viewName).cloneColors[String(id)] ?? this.raw.cloneColors[String(id)] ?? '#888888';
      c = linearFromHex(hex);
      this.viewCloneCache.set(key, c);
    }
    return c;
  }

  viewCauseColor(viewName: string, id: number): RGB {
    const key = `${viewName}:${id}`;
    let c = this.viewCauseCache.get(key);
    if (!c) {
      const v = this.view(viewName);
      const hex = v.causeColors?.[String(id)] ?? this.raw.causeColors[String(id)] ?? '#888888';
      c = linearFromHex(hex);
      this.viewCauseCache.set(key, c);
    }
    return c;
  }

  static color(hex: string): RGB {
    return linearFromHex(hex);
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

  /* Every view has to be able to colour everything the rules declare, or a
     clone silently falls back to grey in one view and not another. */
  const viewNames = Object.keys(v.views ?? {});
  if (!viewNames.length) problems.push('visuals.json declares no views');
  if (v.defaultView && !viewNames.includes(v.defaultView)) {
    problems.push(`defaultView "${v.defaultView}" is not one of the declared views`);
  }
  for (const [viewName, view] of Object.entries(v.views ?? {})) {
    for (const clone of rules.raw.clones) {
      if (!view.cloneColors[String(clone.id)]) {
        problems.push(`view "${viewName}" has no cloneColor for clone ${clone.id} ("${clone.name}")`);
      }
    }
    if (view.causeColors) {
      for (const cause of rules.raw.causes) {
        if (!view.causeColors[String(cause.id)]) {
          problems.push(`view "${viewName}" overrides causeColors but is missing cause ${cause.id}`);
        }
      }
    }
    if ((rules.raw.vasculature || (rules.raw.drugs ?? []).length) && !view.blood) {
      problems.push(`view "${viewName}" has no blood colour, but the matrix has vessels to draw`);
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

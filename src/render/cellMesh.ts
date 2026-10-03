import * as THREE from 'three';
import { NO_DRUG } from '../format/events.js';
import type { World } from '../world/world.js';
import { CELL_FRAGMENT_SHADER, CELL_VERTEX_SHADER } from './shaders/cell.js';
import { PRESET_FLOATS, type Visuals } from './visuals.js';

export type ViewMode = 'clone' | 'cause';

/** Floats per instance, in the order the attributes are declared below. */
const FLOATS = {
  pos: 3,
  base: 3,
  tint: 3,
  pick: 3,
  p: PRESET_FLOATS,
} as const;

/**
 * Every cell in one instanced draw.
 *
 * The mesh is the only place that turns world state into appearance, and it
 * does it entirely through visuals.json: which preset a (type, cause) pair
 * uses, and what colour a clone, cause or drug is.
 */
export class CellMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.InstancedBufferGeometry;
  private capacity: number;
  private viewMode: ViewMode = 'clone';

  private aPos!: THREE.InstancedBufferAttribute;
  private aBase!: THREE.InstancedBufferAttribute;
  private aTint!: THREE.InstancedBufferAttribute;
  private aPick!: THREE.InstancedBufferAttribute;
  private aP: THREE.InstancedBufferAttribute[] = [];

  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;

  constructor(
    private world: World,
    private visuals: Visuals,
  ) {
    this.cx = (world.nx - 1) / 2;
    this.cy = (world.ny - 1) / 2;
    this.cz = (world.nz - 1) / 2;

    const detail = visuals.raw.cell.detail ?? 1;
    const base = new THREE.IcosahedronGeometry(1, detail);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', base.getAttribute('position'));
    this.geometry.setAttribute('normal', base.getAttribute('normal'));
    if (base.index) this.geometry.setIndex(base.index);

    const scene = visuals.raw.scene;
    const bg = visuals.raw.scene.background;
    this.material = new THREE.ShaderMaterial({
      vertexShader: CELL_VERTEX_SHADER,
      fragmentShader: CELL_FRAGMENT_SHADER,
      uniforms: {
        uTick: { value: 0 },
        uRadius: { value: visuals.raw.cell.radiusFraction },
        uBackground: { value: new THREE.Color(bg).convertSRGBToLinear() },
        uFogDensity: { value: scene.fogDensity ?? 0 },
        uAmbient: { value: scene.ambient ?? 0.4 },
        uKeyLight: { value: scene.keyLight ?? 0.9 },
        uRimLight: { value: scene.rimLight ?? 0.3 },
        uKeyDirection: { value: new THREE.Vector3(0.4, 0.8, 0.45).normalize() },
        uCameraPos: { value: new THREE.Vector3() },
        uClipNormal: { value: new THREE.Vector3(0, 0, 1) },
        uClipOffset: { value: 1e9 },
        uClipOn: { value: 0 },
        uPicking: { value: 0 },
      },
    });

    this.capacity = Math.max(1024, Math.min(world.nodeCount, 1 << 14));
    this.allocate(this.capacity);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    const span = Math.max(world.nx, world.ny, world.nz);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), span);
    base.dispose();
  }

  private allocate(capacity: number): void {
    const make = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
    this.aPos = make(FLOATS.pos);
    this.aBase = make(FLOATS.base);
    this.aTint = make(FLOATS.tint);
    this.aPick = make(FLOATS.pick);
    this.aP = [];
    for (let k = 0; k < PRESET_FLOATS / 4; k++) this.aP.push(make(4));

    this.geometry.setAttribute('aPos', this.aPos);
    this.geometry.setAttribute('aBase', this.aBase);
    this.geometry.setAttribute('aTint', this.aTint);
    this.geometry.setAttribute('aPick', this.aPick);
    this.aP.forEach((attr, k) => this.geometry.setAttribute(`aP${k}`, attr));
    this.capacity = capacity;
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.world.rebuilt = true;
  }

  get mode(): ViewMode {
    return this.viewMode;
  }

  setClip(normal: THREE.Vector3, offset: number, on: boolean): void {
    (this.material.uniforms.uClipNormal.value as THREE.Vector3).copy(normal);
    this.material.uniforms.uClipOffset.value = offset;
    this.material.uniforms.uClipOn.value = on ? 1 : 0;
  }

  /** Writes one slot's attributes from world state plus visuals.json. */
  private writeSlot(slot: number): void {
    const w = this.world;
    const v = this.visuals;
    const node = w.nodeOfSlot[slot];

    const x = node % w.nx;
    const y = Math.floor(node / w.nx) % w.ny;
    const z = Math.floor(node / (w.nx * w.ny));
    this.aPos.array[slot * 3 + 0] = x - this.cx;
    this.aPos.array[slot * 3 + 1] = y - this.cy;
    this.aPos.array[slot * 3 + 2] = z - this.cz;

    const preset = v.presetFor(w.animType[slot], w.animCause[slot]);

    const from = w.animFromClone[slot];
    const baseColor =
      this.viewMode === 'cause'
        ? v.causeColor(w.cause[slot])
        : v.cloneColor(from === 0xffff ? w.clone[slot] : from);
    this.aBase.array[slot * 3 + 0] = baseColor[0];
    this.aBase.array[slot * 3 + 1] = baseColor[1];
    this.aBase.array[slot * 3 + 2] = baseColor[2];

    // Tint source is the preset's choice: a fixed colour, the drug's colour, or
    // the clone being mutated into. In colour-by-cause view the cause colour
    // carries the meaning, so the tint follows it.
    let tint: readonly [number, number, number];
    if (this.viewMode === 'cause') {
      tint = baseColor;
    } else {
      const tintFrom = v.presetTintFrom[preset];
      if (tintFrom === 1) {
        const drug = w.drug[slot];
        tint = drug === NO_DRUG ? baseColor : v.drugColor(drug);
      } else if (tintFrom === 2) {
        tint = v.cloneColor(w.clone[slot]);
      } else {
        tint = [
          v.presetTint[preset * 3 + 0],
          v.presetTint[preset * 3 + 1],
          v.presetTint[preset * 3 + 2],
        ];
      }
    }
    this.aTint.array[slot * 3 + 0] = tint[0];
    this.aTint.array[slot * 3 + 1] = tint[1];
    this.aTint.array[slot * 3 + 2] = tint[2];

    // The node index, so a pick resolves to a cell even after slots are swapped.
    this.aPick.array[slot * 3 + 0] = (node & 0xff) / 255;
    this.aPick.array[slot * 3 + 1] = ((node >> 8) & 0xff) / 255;
    this.aPick.array[slot * 3 + 2] = ((node >> 16) & 0xff) / 255;

    const src = v.presetParams;
    const o = preset * PRESET_FLOATS;
    for (let k = 0; k < this.aP.length; k++) {
      const dst = this.aP[k].array as Float32Array;
      dst[slot * 4 + 0] = src[o + k * 4 + 0];
      dst[slot * 4 + 1] = src[o + k * 4 + 1];
      dst[slot * 4 + 2] = src[o + k * 4 + 2];
      dst[slot * 4 + 3] = src[o + k * 4 + 3];
    }
    // The last two slots of aP4 are per-instance, not per-preset.
    const last = this.aP[this.aP.length - 1].array as Float32Array;
    last[slot * 4 + 2] = this.world.animStart[slot];
    last[slot * 4 + 3] = this.world.seed[slot];
  }

  /** Uploads whatever changed and points the shader at the current time. */
  sync(displayTick: number, cameraPos: THREE.Vector3): void {
    const w = this.world;
    if (w.count > this.capacity) {
      let cap = this.capacity;
      while (cap < w.count) cap *= 2;
      this.allocate(Math.min(cap, w.nodeCount));
      w.rebuilt = true;
    }

    if (w.rebuilt) {
      for (let s = 0; s < w.count; s++) this.writeSlot(s);
      this.markAll();
      w.rebuilt = false;
      w.dirty.clear();
    } else if (w.dirty.size) {
      let lo = Infinity;
      let hi = -1;
      for (const slot of w.dirty) {
        if (slot >= w.count) continue;
        this.writeSlot(slot);
        if (slot < lo) lo = slot;
        if (slot > hi) hi = slot;
      }
      if (hi >= 0) this.markRange(lo, hi - lo + 1);
      w.dirty.clear();
    }

    this.geometry.instanceCount = w.count;
    this.material.uniforms.uTick.value = displayTick;
    (this.material.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
  }

  private attrs(): THREE.InstancedBufferAttribute[] {
    return [this.aPos, this.aBase, this.aTint, this.aPick, ...this.aP];
  }

  private markAll(): void {
    for (const a of this.attrs()) {
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
  }

  private markRange(start: number, count: number): void {
    for (const a of this.attrs()) {
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  setPicking(on: boolean): void {
    this.material.uniforms.uPicking.value = on ? 1 : 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

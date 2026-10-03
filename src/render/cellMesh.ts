import * as THREE from 'three';
import { NO_DRUG } from '../format/events.js';
import type { World } from '../world/world.js';
import { CELL_FRAGMENT, CELL_VERTEX, PICK_FRAGMENT } from './shaders/cell.js';
import { PRESET_FLOATS, linearFromHex, type RGB, type Visuals } from './visuals.js';

export type ColorBy = 'clone' | 'cause';

export type CutMode = 'none' | 'plane' | 'octant';

export interface CutState {
  mode: CutMode;
  /** Corner (octant) or a point on the plane, in voxel coordinates about the grid centre. */
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

const ATTR = {
  pos: 3,
  base: 3,
  tint: 3,
  pick: 3,
  shape: 4,
} as const;

/** 2^-24 scaled hash, stable per node. */
function hashUnit(node: number, salt: number): number {
  let h = Math.imul(node ^ salt, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 8) / 0x1000000;
}

/**
 * Every cell that is actually drawn, plus its nucleus.
 *
 * Only the cells exposed by the cut are instanced - a slab a few voxels deep
 * behind each cut face. The rest of the mass is the isosurface. Drawing all
 * 260 000 nodes at once is both unaffordable and, at that distance, exactly
 * what makes a tumour read as a cloud of dots.
 *
 * Cells and nuclei share one set of instance attributes and are drawn twice,
 * so a nucleus can never end up somewhere its cell is not.
 */
export class CellMesh {
  readonly cells: THREE.Mesh;
  readonly nuclei: THREE.Mesh;
  readonly cellMaterial: THREE.ShaderMaterial;
  readonly nucleusMaterial: THREE.ShaderMaterial;
  readonly pickMaterial: THREE.ShaderMaterial;

  private cellGeometry: THREE.InstancedBufferGeometry;
  private nucleusGeometry: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private drawn = 0;

  private aPos!: THREE.InstancedBufferAttribute;
  private aBase!: THREE.InstancedBufferAttribute;
  private aTint!: THREE.InstancedBufferAttribute;
  private aPick!: THREE.InstancedBufferAttribute;
  private aShape!: THREE.InstancedBufferAttribute;
  private aP: THREE.InstancedBufferAttribute[] = [];

  private colorBy: ColorBy = 'clone';
  private viewName: string;
  private cut: CutState = {
    mode: 'none',
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 0, 1),
  };

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
    this.viewName = visuals.defaultViewName;

    const spec = visuals.raw.cell;
    this.cellGeometry = this.makeGeometry(spec.detail ?? 2);
    this.nucleusGeometry = this.makeGeometry(spec.nucleusDetail ?? 1);

    this.cellMaterial = this.makeMaterial(false);
    this.nucleusMaterial = this.makeMaterial(true);
    this.pickMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CELL_VERTEX,
      fragmentShader: PICK_FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: this.cellMaterial.uniforms,
    });

    this.allocate(1 << 13);

    this.cells = new THREE.Mesh(this.cellGeometry, this.cellMaterial);
    this.nuclei = new THREE.Mesh(this.nucleusGeometry, this.nucleusMaterial);
    const span = Math.max(world.nx, world.ny, world.nz);
    for (const m of [this.cells, this.nuclei]) {
      m.frustumCulled = false;
      m.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), span);
    }
    // Nuclei sit inside their cells; drawing them second keeps the depth order
    // natural without a sort.
    this.nuclei.renderOrder = 1;
  }

  private makeGeometry(detail: number): THREE.InstancedBufferGeometry {
    const base = new THREE.IcosahedronGeometry(1, detail);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('normal', base.getAttribute('normal'));
    if (base.index) g.setIndex(base.index);
    base.dispose();
    return g;
  }

  private makeMaterial(isNucleus: boolean): THREE.ShaderMaterial {
    const spec = this.visuals.raw.cell;
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CELL_VERTEX,
      fragmentShader: CELL_FRAGMENT,
      // A cell the cut passes through has to show its inside, the way a cell in
      // a real section does. Front-side only leaves a hole.
      side: THREE.DoubleSide,
      uniforms: {
        uTick: { value: 0 },
        uRadius: { value: spec.radiusFraction },
        uRestingScale: { value: spec.restingScale ?? 0.88 },
        uIsNucleus: { value: isNucleus ? 1 : 0 },
        uNucleusOffset: { value: spec.nucleusOffsetFraction ?? 0.17 },
        uGrainScale: { value: spec.grainScale ?? 3.2 },
        uFade: { value: 1 },
        uCutMode: { value: 0 },
        uCutPoint: { value: new THREE.Vector3() },
        uCutNormal: { value: new THREE.Vector3(0, 0, 1) },
        uRoughness: { value: 0.45 },
        uClearcoat: { value: 0.25 },
        uSheen: { value: 0.3 },
        uThickness: { value: 0.55 },
        uSubsurface: { value: new THREE.Vector3(0.75, 0.34, 0.3) },
        uNucleusColor: { value: new THREE.Vector3(0.33, 0.19, 0.29) },
        uNucleusBlend: { value: 0.35 },
        uKeyDir: { value: new THREE.Vector3(0.42, 0.74, 0.52) },
        uFillDir: { value: new THREE.Vector3(-0.62, -0.12, 0.38) },
        uRimDir: { value: new THREE.Vector3(-0.34, 0.42, -0.84) },
        uKeyColor: { value: new THREE.Vector3(1, 0.94, 0.89) },
        uFillColor: { value: new THREE.Vector3(0.42, 0.52, 0.65) },
        uRimColor: { value: new THREE.Vector3(1, 0.82, 0.71) },
        uSkyColor: { value: new THREE.Vector3(0.27, 0.35, 0.43) },
        uGroundColor: { value: new THREE.Vector3(0.18, 0.11, 0.09) },
        uExposure: { value: 1.05 },
        uViewMode: { value: 0 },
      },
    });
  }

  get instanceCount(): number {
    return this.drawn;
  }

  setColorBy(mode: ColorBy): void {
    if (mode !== this.colorBy) {
      this.colorBy = mode;
      this.world.rebuilt = true;
    }
  }

  setView(name: string): void {
    this.viewName = name;
    this.world.rebuilt = true;
  }

  setCut(cut: CutState): void {
    this.cut = cut;
    const modeId = cut.mode === 'none' ? 0 : cut.mode === 'plane' ? 1 : 2;
    for (const m of [this.cellMaterial, this.nucleusMaterial]) {
      m.uniforms.uCutMode.value = modeId;
      (m.uniforms.uCutPoint.value as THREE.Vector3).copy(cut.point);
      (m.uniforms.uCutNormal.value as THREE.Vector3).copy(cut.normal);
    }
  }

  /** Lighting, palette and material for the active view. */
  applyView(name: string): void {
    this.viewName = name;
    const v = this.visuals.view(name);
    const vec = (hex: string) => {
      const [r, g, b] = linearFromHex(hex);
      return new THREE.Vector3(r, g, b);
    };
    const viewModeId = name === 'fluorescence' ? 1 : name === 'histology' ? 2 : 0;
    for (const m of [this.cellMaterial, this.nucleusMaterial]) {
      const u = m.uniforms;
      u.uRoughness.value = v.material.roughness;
      u.uClearcoat.value = v.material.clearcoat;
      u.uSheen.value = v.material.sheen;
      u.uThickness.value = v.material.thickness;
      u.uSubsurface.value = vec(v.material.subsurface);
      u.uNucleusColor.value = vec(v.nucleus);
      u.uNucleusBlend.value = v.emissionOnly ? 0 : 0.35;
      u.uKeyDir.value = new THREE.Vector3(...v.lights.key.direction).normalize();
      u.uFillDir.value = new THREE.Vector3(...v.lights.fill.direction).normalize();
      u.uRimDir.value = new THREE.Vector3(...v.lights.rim.direction).normalize();
      u.uKeyColor.value = vec(v.lights.key.color).multiplyScalar(v.lights.key.intensity);
      u.uFillColor.value = vec(v.lights.fill.color).multiplyScalar(v.lights.fill.intensity);
      u.uRimColor.value = vec(v.lights.rim.color).multiplyScalar(v.lights.rim.intensity);
      u.uSkyColor.value = vec(v.lights.sky);
      u.uGroundColor.value = vec(v.lights.ground);
      u.uExposure.value = v.exposure ?? 1;
      u.uViewMode.value = viewModeId;
    }
    this.world.rebuilt = true;
  }

  private allocate(capacity: number): void {
    const make = (n: number) =>
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
    this.aPos = make(ATTR.pos);
    this.aBase = make(ATTR.base);
    this.aTint = make(ATTR.tint);
    this.aPick = make(ATTR.pick);
    this.aShape = make(ATTR.shape);
    this.aP = [];
    for (let k = 0; k < PRESET_FLOATS / 4; k++) this.aP.push(make(4));

    for (const g of [this.cellGeometry, this.nucleusGeometry]) {
      g.setAttribute('aPos', this.aPos);
      g.setAttribute('aBase', this.aBase);
      g.setAttribute('aTint', this.aTint);
      g.setAttribute('aPick', this.aPick);
      g.setAttribute('aShape', this.aShape);
      this.aP.forEach((attr, k) => g.setAttribute(`aP${k}`, attr));
    }
    this.capacity = capacity;
  }

  /**
   * Signed distance past a cut corner or plane: positive means cut away.
   *
   * The scene is partitioned with this one function so the three regions meet
   * exactly. Nothing is cut past `point`; individual cells fill the band from
   * `point` back to `point` minus the slab depth; the isosurface takes over
   * behind that. Using the same test for all three is what stops cells sitting
   * on top of a surface that should have been cut away beneath them.
   */
  private cutDistance(x: number, y: number, z: number, shift: number): number {
    const c = this.cut;
    if (c.mode === 'none') return -1;
    const dx = x - this.cx - c.point.x + shift;
    const dy = y - this.cy - c.point.y + shift;
    const dz = z - this.cz - c.point.z + shift;
    if (c.mode === 'plane') {
      return dx * c.normal.x + dy * c.normal.y + dz * c.normal.z;
    }
    if (dx > 0 && dy > 0 && dz > 0) return Math.min(dx, Math.min(dy, dz));
    let sum = 0;
    if (dx < 0) sum += dx * dx;
    if (dy < 0) sum += dy * dy;
    if (dz < 0) sum += dz * dz;
    return -Math.sqrt(sum);
  }

  /** True where an individual cell should be drawn: inside the slab band. */
  private inSlab(x: number, y: number, z: number, slab: number): boolean {
    if (this.cut.mode === 'none') return false;
    return this.cutDistance(x, y, z, 0) <= 0 && this.cutDistance(x, y, z, slab) > 0;
  }

  /**
   * Chooses which cells to instance and writes their attributes.
   *
   * Called when the world, the cut or the view changes - not every frame.
   */
  rebuild(): void {
    const w = this.world;
    const v = this.visuals;
    const spec = v.raw.cell;
    const slab = v.view(this.viewName).slabVoxels ?? spec.slabVoxels ?? 4;
    const jitter = Math.min(0.35, spec.jitterVoxels ?? 0.3);
    const variation = spec.sizeVariation ?? 0.15;
    const wobbleAmp = spec.wobbleAmplitude ?? 0.13;
    const wobbleFreq = spec.wobbleFrequency ?? 2.6;
    const view = this.viewName;

    /* First pass: how many cells are exposed. */
    let count = 0;
    for (let s = 0; s < w.count; s++) {
      const node = w.nodeOfSlot[s];
      const x = node % w.nx;
      const y = Math.floor(node / w.nx) % w.ny;
      const z = Math.floor(node / (w.nx * w.ny));
      if (this.inSlab(x, y, z, slab)) count++;
    }
    if (count > this.capacity) {
      let cap = this.capacity;
      while (cap < count) cap *= 2;
      this.allocate(cap);
    }

    const pos = this.aPos.array as Float32Array;
    const base = this.aBase.array as Float32Array;
    const tint = this.aTint.array as Float32Array;
    const pick = this.aPick.array as Float32Array;
    const shape = this.aShape.array as Float32Array;
    const presets = v.paramsFor(view);

    let out = 0;
    for (let s = 0; s < w.count; s++) {
      const node = w.nodeOfSlot[s];
      const x = node % w.nx;
      const y = Math.floor(node / w.nx) % w.ny;
      const z = Math.floor(node / (w.nx * w.ny));
      if (!this.inSlab(x, y, z, slab)) continue;

      /* Jitter is hashed from the node, so a cell always sits in or against
         its own voxel and never moves between frames. */
      pos[out * 3 + 0] = x - this.cx + (hashUnit(node, 0x1f) - 0.5) * 2 * jitter;
      pos[out * 3 + 1] = y - this.cy + (hashUnit(node, 0x2b) - 0.5) * 2 * jitter;
      pos[out * 3 + 2] = z - this.cz + (hashUnit(node, 0x3d) - 0.5) * 2 * jitter;

      const preset = v.presetFor(w.animType[s], w.animCause[s]);
      const from = w.animFromClone[s];
      const colour =
        this.colorBy === 'cause'
          ? v.viewCauseColor(view, w.cause[s])
          : v.viewCloneColor(view, from === 0xffff ? w.clone[s] : from);
      base[out * 3 + 0] = colour[0];
      base[out * 3 + 1] = colour[1];
      base[out * 3 + 2] = colour[2];

      let t: RGB;
      if (this.colorBy === 'cause') {
        t = colour;
      } else {
        const tintFrom = v.tintFromFor(view)[preset];
        if (tintFrom === 1) {
          const drug = w.drug[s];
          t = drug === NO_DRUG ? colour : v.drugColor(drug);
        } else if (tintFrom === 2) {
          t = v.viewCloneColor(view, w.clone[s]);
        } else {
          const tints = v.tintFor(view);
          t = [tints[preset * 3 + 0], tints[preset * 3 + 1], tints[preset * 3 + 2]];
        }
      }
      tint[out * 3 + 0] = t[0];
      tint[out * 3 + 1] = t[1];
      tint[out * 3 + 2] = t[2];

      pick[out * 3 + 0] = (node & 0xff) / 255;
      pick[out * 3 + 1] = ((node >> 8) & 0xff) / 255;
      pick[out * 3 + 2] = ((node >> 16) & 0xff) / 255;

      shape[out * 4 + 0] = 1 + (hashUnit(node, 0x4f) - 0.5) * 2 * variation;
      shape[out * 4 + 1] = wobbleAmp * (0.6 + hashUnit(node, 0x55));
      shape[out * 4 + 2] = wobbleFreq * (0.8 + hashUnit(node, 0x61) * 0.5);
      shape[out * 4 + 3] = 0;

      const o = preset * PRESET_FLOATS;
      for (let k = 0; k < this.aP.length; k++) {
        const dst = this.aP[k].array as Float32Array;
        dst[out * 4 + 0] = presets[o + k * 4 + 0];
        dst[out * 4 + 1] = presets[o + k * 4 + 1];
        dst[out * 4 + 2] = presets[o + k * 4 + 2];
        dst[out * 4 + 3] = presets[o + k * 4 + 3];
      }
      const p4 = this.aP[4].array as Float32Array;
      p4[out * 4 + 2] = w.animStart[s];
      p4[out * 4 + 3] = w.seed[s];

      out++;
    }

    this.drawn = out;
    for (const a of this.attributes()) {
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
    this.cellGeometry.instanceCount = out;
    this.nucleusGeometry.instanceCount = out;
  }

  private attributes(): THREE.InstancedBufferAttribute[] {
    return [this.aPos, this.aBase, this.aTint, this.aPick, this.aShape, ...this.aP];
  }

  /** Swaps in the single-output material for the pick pass, and back. */
  setPicking(on: boolean): void {
    this.cells.material = on ? this.pickMaterial : this.cellMaterial;
    this.nuclei.material = on ? this.pickMaterial : this.nucleusMaterial;
  }

  /** Per-frame: the clock and the fade, nothing that needs a rebuild. */
  update(displayTick: number, fade: number): void {
    for (const m of [this.cellMaterial, this.nucleusMaterial]) {
      m.uniforms.uTick.value = displayTick;
      m.uniforms.uFade.value = fade;
    }
    this.cells.visible = fade > 0.01 && this.drawn > 0;
    this.nuclei.visible = this.cells.visible;
  }

  dispose(): void {
    this.cellGeometry.dispose();
    this.nucleusGeometry.dispose();
    this.cellMaterial.dispose();
    this.nucleusMaterial.dispose();
    this.pickMaterial.dispose();
  }
}

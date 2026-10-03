import * as THREE from 'three';
import type { ResolvedRules } from '../sim/rules.js';
import { growVasculature, type Vasculature, type VesselSegment } from '../sim/vasculature.js';
import { Grid } from '../sim/grid.js';
import {
  RBC_FRAGMENT,
  RBC_VERTEX,
  VESSEL_FRAGMENT,
  VESSEL_VERTEX,
} from './shaders/vessel.js';
import { linearFromHex, type Visuals } from './visuals.js';

/** Red cell diameter in micrometres. Real: 7-8 um. */
const RBC_MICRONS = 7.5;

/**
 * The vascular tree, drawn from the same network the simulator perfuses.
 *
 * The geometry is regenerated from rules.json by the identical function the
 * simulator uses, so the tubes sit exactly where the oxygen sources are - the
 * living cuff around a vessel is real structure, not a drawn highlight.
 */
export class VesselMesh {
  readonly group = new THREE.Group();
  readonly vasculature: Vasculature | undefined;
  readonly tubeMaterial: THREE.ShaderMaterial;
  readonly rbcMaterial: THREE.ShaderMaterial;
  private tubes: THREE.Mesh | undefined;
  private rbcs: THREE.Mesh | undefined;
  private rbcGeometry: THREE.InstancedBufferGeometry | undefined;
  triangleCount = 0;
  rbcCount = 0;

  constructor(
    private rules: ResolvedRules,
    private visuals: Visuals,
  ) {
    const g = rules.raw.grid;
    const grid = new Grid(g.nx, g.ny, g.nz, g.neighborhood ?? 26);
    this.vasculature = growVasculature(rules.raw, grid);

    const common = {
      uCutMode: { value: 0 },
      uCutPoint: { value: new THREE.Vector3() },
      uCutNormal: { value: new THREE.Vector3(0, 0, 1) },
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
    };

    this.tubeMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VESSEL_VERTEX,
      fragmentShader: VESSEL_FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: {
        ...structuredCloneUniforms(common),
        uWallColor: { value: new THREE.Vector3(0.84, 0.6, 0.55) },
        uBloodColor: { value: new THREE.Vector3(0.3, 0.02, 0.02) },
        uRoughness: { value: 0.3 },
      },
    });
    this.rbcMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: RBC_VERTEX,
      fragmentShader: RBC_FRAGMENT,
      uniforms: {
        ...structuredCloneUniforms(common),
        uBloodColor: { value: new THREE.Vector3(0.35, 0.02, 0.02) },
        uTime: { value: 0 },
        uRadius: { value: 0.25 },
      },
    });

    if (this.vasculature) {
      this.buildTubes(this.vasculature);
      this.buildRedCells(this.vasculature);
    }
  }

  /** Smooth polylines through the tree, so vessels are tortuous, not faceted. */
  private chains(segments: VesselSegment[]): { points: THREE.Vector3[]; radii: number[] }[] {
    const childrenOf = new Map<number, number[]>();
    for (let i = 0; i < segments.length; i++) {
      const p = segments[i].parent;
      if (p < 0) continue;
      const list = childrenOf.get(p) ?? [];
      list.push(i);
      childrenOf.set(p, list);
    }
    const out: { points: THREE.Vector3[]; radii: number[] }[] = [];
    const visited = new Uint8Array(segments.length);

    const walk = (start: number) => {
      const points: THREE.Vector3[] = [];
      const radii: number[] = [];
      let i = start;
      const first = segments[i];
      points.push(new THREE.Vector3(first.ax, first.ay, first.az));
      radii.push(first.ra);
      for (;;) {
        visited[i] = 1;
        const s = segments[i];
        points.push(new THREE.Vector3(s.bx, s.by, s.bz));
        radii.push(s.rb);
        const kids = childrenOf.get(i) ?? [];
        // Continue through the thickest child; the others start their own chain.
        let next = -1;
        let best = -1;
        for (const k of kids) {
          if (visited[k]) continue;
          if (segments[k].ra > best) {
            best = segments[k].ra;
            next = k;
          }
        }
        if (next < 0) break;
        i = next;
      }
      if (points.length >= 2) out.push({ points, radii });
    };

    for (let i = 0; i < segments.length; i++) if (segments[i].parent < 0) walk(i);
    for (let i = 0; i < segments.length; i++) if (!visited[i]) walk(i);
    return out;
  }

  private buildTubes(vasc: Vasculature): void {
    const g = this.rules.raw.grid;
    const cx = (g.nx - 1) / 2;
    const cy = (g.ny - 1) / 2;
    const cz = (g.nz - 1) / 2;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const SIDES = 10;

    for (const chain of this.chains(vasc.segments)) {
      const curve = new THREE.CatmullRomCurve3(chain.points, false, 'centripetal', 0.5);
      const divisions = Math.max(8, chain.points.length * 4);
      const frames = curve.computeFrenetFrames(divisions, false);
      const ringStart = positions.length / 3;

      for (let d = 0; d <= divisions; d++) {
        const t = d / divisions;
        const p = curve.getPoint(t);
        const n = frames.normals[d];
        const b = frames.binormals[d];
        // Radius follows the tree's own taper, with a little unevenness: real
        // vessels are not smooth pipes.
        const fi = t * (chain.radii.length - 1);
        const i0 = Math.floor(fi);
        const i1 = Math.min(chain.radii.length - 1, i0 + 1);
        const base = THREE.MathUtils.lerp(chain.radii[i0], chain.radii[i1], fi - i0);
        const uneven = 1 + 0.16 * Math.sin(t * 17.0 + chain.radii[0] * 9.0) + 0.09 * Math.sin(t * 41.0);
        const radius = base * uneven;

        for (let s = 0; s < SIDES; s++) {
          const a = (s / SIDES) * Math.PI * 2;
          const dx = Math.cos(a) * n.x + Math.sin(a) * b.x;
          const dy = Math.cos(a) * n.y + Math.sin(a) * b.y;
          const dz = Math.cos(a) * n.z + Math.sin(a) * b.z;
          positions.push(
            p.x + dx * radius - cx,
            p.y + dy * radius - cy,
            p.z + dz * radius - cz,
          );
          normals.push(dx, dy, dz);
        }
      }
      for (let d = 0; d < divisions; d++) {
        for (let s = 0; s < SIDES; s++) {
          const a = ringStart + d * SIDES + s;
          const b2 = ringStart + d * SIDES + ((s + 1) % SIDES);
          const c = a + SIDES;
          const e = b2 + SIDES;
          indices.push(a, c, b2, b2, c, e);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1));
    const span = Math.max(g.nx, g.ny, g.nz);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), span);
    this.tubes = new THREE.Mesh(geo, this.tubeMaterial);
    this.tubes.frustumCulled = false;
    this.triangleCount = indices.length / 3;
    this.group.add(this.tubes);
  }

  /**
   * Red cells. One instance per slot on a segment, sized from the real red cell
   * diameter against the voxel size. The motion is illustrative.
   */
  private buildRedCells(vasc: Vasculature): void {
    const g = this.rules.raw.grid;
    const cx = (g.nx - 1) / 2;
    const cy = (g.ny - 1) / 2;
    const cz = (g.nz - 1) / 2;
    const rbcVoxels = RBC_MICRONS / g.voxelMicrons;
    this.rbcMaterial.uniforms.uRadius.value = rbcVoxels / 2;

    const starts: number[] = [];
    const ends: number[] = [];
    const flow: number[] = [];
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (const s of vasc.segments) {
      const radius = (s.ra + s.rb) / 2;
      if (radius < rbcVoxels * 0.8) continue;
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay, s.bz - s.az);
      // Pack by lumen volume, not by length, so wide vessels carry more.
      const n = Math.max(1, Math.round((len * radius * radius) / (rbcVoxels * 1.4)));
      for (let k = 0; k < n; k++) {
        starts.push(s.ax - cx, s.ay - cy, s.az - cz);
        ends.push(s.bx - cx, s.by - cy, s.bz - cz);
        flow.push(rand(), 0.05 + rand() * 0.07, rand() * Math.max(0, radius - rbcVoxels * 0.55), rand() * 6.28);
      }
    }
    this.rbcCount = flow.length / 4;
    if (!this.rbcCount) return;

    // Detail 1 is 80 triangles: enough for a 7.5 um disc on screen, and at a
    // few thousand instances the difference from detail 2 is 600k triangles.
    const disc = new THREE.IcosahedronGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', disc.getAttribute('position'));
    geo.setAttribute('normal', disc.getAttribute('normal'));
    if (disc.index) geo.setIndex(disc.index);
    disc.dispose();
    geo.setAttribute('aStart', new THREE.InstancedBufferAttribute(new Float32Array(starts), 3));
    geo.setAttribute('aEnd', new THREE.InstancedBufferAttribute(new Float32Array(ends), 3));
    geo.setAttribute('aFlow', new THREE.InstancedBufferAttribute(new Float32Array(flow), 4));
    geo.instanceCount = this.rbcCount;
    const span = Math.max(g.nx, g.ny, g.nz);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), span);
    this.rbcGeometry = geo;
    this.rbcs = new THREE.Mesh(geo, this.rbcMaterial);
    this.rbcs.frustumCulled = false;
    this.group.add(this.rbcs);
  }

  applyView(name: string): void {
    const v = this.visuals.view(name);
    const vec = (hex: string) => {
      const [r, g, b] = linearFromHex(hex);
      return new THREE.Vector3(r, g, b);
    };
    const viewModeId = name === 'fluorescence' ? 1 : name === 'histology' ? 2 : 0;
    for (const m of [this.tubeMaterial, this.rbcMaterial]) {
      const u = m.uniforms;
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
      u.uBloodColor.value = vec(v.blood ?? '#8d1f1a');
    }
    this.tubeMaterial.uniforms.uWallColor.value = vec(v.vesselWall ?? '#e9c8be');
  }

  setCut(mode: number, point: THREE.Vector3, normal: THREE.Vector3): void {
    for (const m of [this.tubeMaterial, this.rbcMaterial]) {
      m.uniforms.uCutMode.value = mode;
      (m.uniforms.uCutPoint.value as THREE.Vector3).copy(point);
      (m.uniforms.uCutNormal.value as THREE.Vector3).copy(normal);
    }
  }

  update(seconds: number): void {
    this.rbcMaterial.uniforms.uTime.value = seconds;
  }

  dispose(): void {
    this.tubes?.geometry.dispose();
    this.rbcGeometry?.dispose();
    this.tubeMaterial.dispose();
    this.rbcMaterial.dispose();
  }
}

/** Uniform objects must not be shared between materials. */
function structuredCloneUniforms(
  src: Record<string, { value: unknown }>,
): Record<string, { value: unknown }> {
  const out: Record<string, { value: unknown }> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = { value: v.value instanceof THREE.Vector3 ? v.value.clone() : v.value };
  }
  return out;
}

import * as THREE from 'three';
import type { ResolvedRules } from '../sim/rules.js';
import type { World } from '../world/world.js';
import { OccupancyField, surfaceNets, type SurfaceBox } from './isosurface.js';
import { SURFACE_FRAGMENT, SURFACE_VERTEX } from './shaders/surface.js';
import { linearFromHex, type Visuals } from './visuals.js';

const MARGIN = 3;

/**
 * The smooth outer boundary of the mass.
 *
 * Occupancy is blurred and an isosurface extracted from it, which is what turns
 * a stack of voxels into the organic surface a cleared sample has. Rebuilt on a
 * throttle rather than every frame: at a few thousand divisions per tick the
 * boundary moves slowly, and the extraction costs milliseconds.
 */
export class SurfaceMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry = new THREE.BufferGeometry();
  private field: OccupancyField;
  private box: SurfaceBox = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 };
  private lastBuildTick = -1;
  triangleCount = 0;

  constructor(
    private world: World,
    private visuals: Visuals,
    rules: ResolvedRules,
  ) {
    void rules;
    this.field = new OccupancyField(world.nx, world.ny, world.nz);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: {
        uAlbedo: { value: new THREE.Vector3(0.6, 0.38, 0.33) },
        uSubsurface: { value: new THREE.Vector3(0.6, 0.2, 0.17) },
        uRoughness: { value: 0.45 },
        uClearcoat: { value: 0.3 },
        uSheen: { value: 0.35 },
        uThickness: { value: 0.7 },
        uMosaic: { value: 0.55 },
        uEmission: { value: 1 },
        uMosaicScale: { value: 1.0 },
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
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    const span = Math.max(world.nx, world.ny, world.nz);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), span);
  }

  applyView(name: string): void {
    const v = this.visuals.view(name);
    const u = this.material.uniforms;
    const vec = (hex: string) => {
      const [r, g, b] = linearFromHex(hex);
      return new THREE.Vector3(r, g, b);
    };
    u.uAlbedo.value = vec(v.surface ?? v.cloneColors['0'] ?? '#d6aa9d');
    u.uSubsurface.value = vec(v.surfaceSubsurface ?? v.material.subsurface);
    u.uRoughness.value = v.material.roughness;
    u.uClearcoat.value = v.material.clearcoat;
    u.uSheen.value = v.material.sheen;
    u.uThickness.value = v.material.thickness;
    u.uMosaic.value = v.post.mosaic ?? 0;
    u.uEmission.value = v.surfaceEmission ?? 1;
    u.uKeyDir.value = new THREE.Vector3(...v.lights.key.direction).normalize();
    u.uFillDir.value = new THREE.Vector3(...v.lights.fill.direction).normalize();
    u.uRimDir.value = new THREE.Vector3(...v.lights.rim.direction).normalize();
    u.uKeyColor.value = vec(v.lights.key.color).multiplyScalar(v.lights.key.intensity);
    u.uFillColor.value = vec(v.lights.fill.color).multiplyScalar(v.lights.fill.intensity);
    u.uRimColor.value = vec(v.lights.rim.color).multiplyScalar(v.lights.rim.intensity);
    u.uSkyColor.value = vec(v.lights.sky);
    u.uGroundColor.value = vec(v.lights.ground);
    u.uExposure.value = v.exposure ?? 1;
    u.uViewMode.value = name === 'fluorescence' ? 1 : name === 'histology' ? 2 : 0;
  }

  setCut(mode: number, point: THREE.Vector3, normal: THREE.Vector3): void {
    this.material.uniforms.uCutMode.value = mode;
    (this.material.uniforms.uCutPoint.value as THREE.Vector3).copy(point);
    (this.material.uniforms.uCutNormal.value as THREE.Vector3).copy(normal);
  }

  /** True when the surface was actually rebuilt. */
  rebuild(blurPasses = 2, iso = 0.42): boolean {
    const w = this.world;
    if (w.count === 0) {
      this.geometry.setDrawRange(0, 0);
      this.triangleCount = 0;
      this.lastBuildTick = w.tick;
      return true;
    }

    /* Occupancy over the tumour's own bounding box only. */
    let x0 = w.nx;
    let y0 = w.ny;
    let z0 = w.nz;
    let x1 = 0;
    let y1 = 0;
    let z1 = 0;
    for (let s = 0; s < w.count; s++) {
      const node = w.nodeOfSlot[s];
      const x = node % w.nx;
      const y = Math.floor(node / w.nx) % w.ny;
      const z = Math.floor(node / (w.nx * w.ny));
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (z > z1) z1 = z;
    }
    const box: SurfaceBox = {
      x0: Math.max(1, x0 - MARGIN),
      y0: Math.max(1, y0 - MARGIN),
      z0: Math.max(1, z0 - MARGIN),
      x1: Math.min(w.nx - 2, x1 + MARGIN),
      y1: Math.min(w.ny - 2, y1 + MARGIN),
      z1: Math.min(w.nz - 2, z1 + MARGIN),
    };

    // Clear the previous box as well, so a shrinking tumour leaves nothing behind.
    this.field.clear({
      x0: Math.min(box.x0, this.box.x0),
      y0: Math.min(box.y0, this.box.y0),
      z0: Math.min(box.z0, this.box.z0),
      x1: Math.max(box.x1, this.box.x1),
      y1: Math.max(box.y1, this.box.y1),
      z1: Math.max(box.z1, this.box.z1),
    });
    this.box = box;

    const f = this.field.value;
    for (let s = 0; s < w.count; s++) f[w.nodeOfSlot[s]] = 1;
    this.field.blur(box, blurPasses);

    const result = surfaceNets(this.field, box, iso);
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    // Surface-net vertices are in voxel coordinates; centre them like the cells.
    const cx = (w.nx - 1) / 2;
    const cy = (w.ny - 1) / 2;
    const cz = (w.nz - 1) / 2;
    for (let i = 0; i < result.positions.length; i += 3) {
      result.positions[i] -= cx;
      result.positions[i + 1] -= cy;
      result.positions[i + 2] -= cz;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    const span = Math.max(w.nx, w.ny, w.nz);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), span);
    this.mesh.geometry = this.geometry;
    this.triangleCount = result.triangleCount;
    this.lastBuildTick = w.tick;
    return true;
  }

  get builtAtTick(): number {
    return this.lastBuildTick;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

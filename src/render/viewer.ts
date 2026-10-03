import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { World } from '../world/world.js';
import { CellMesh, type ColorBy, type CutMode } from './cellMesh.js';
import {
  BLOOM_BLUR_FRAGMENT,
  BLOOM_PREFILTER_FRAGMENT,
  COMPOSITE_FRAGMENT,
  FULLSCREEN_VERTEX,
} from './shaders/composite.js';
import { SurfaceMesh } from './surfaceMesh.js';
import { VesselMesh } from './vesselMesh.js';
import { linearFromHex, type Visuals } from './visuals.js';

export type { ColorBy, CutMode };

export interface FrameStats {
  /** Wall-clock interval between presented frames, smoothed. */
  frameMs: number;
  /** Time this frame spent in the renderer on the CPU, smoothed. */
  cpuMs: number;
  cells: number;
  surfaceTriangles: number;
  vesselTriangles: number;
  redCells: number;
  drawCalls: number;
  triangles: number;
}

const BLOOM_SCALE = 0.25;

/**
 * The renderer.
 *
 * One geometry pass fills a G-buffer - colour, view normal and depth, and the
 * identity of whatever was drawn - and one later pass turns that into the
 * finished image: ambient occlusion in the crevices between packed cells,
 * membrane lines wherever the identity changes, depth cues, and the tone map.
 *
 * Nothing here knows any biology. What a cell is and what it looks like come
 * from rules.json and visuals.json; this decides only how light behaves.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly cells: CellMesh;
  readonly surface: SurfaceMesh;
  readonly vessels: VesselMesh;

  displayTick = 0;
  presentation = false;

  private gbuffer!: THREE.WebGLRenderTarget<THREE.Texture[]>;
  private bloomA!: THREE.WebGLRenderTarget;
  private bloomB!: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private compositeMaterial: THREE.ShaderMaterial;
  private prefilterMaterial: THREE.ShaderMaterial;
  private blurMaterial: THREE.ShaderMaterial;

  private viewName: string;
  private cutMode: CutMode = 'octant';
  private cutFraction = 0;
  private needsRebuild = true;
  private lastSurfaceTick = -1;
  private pickBuffer = new Uint8Array(4);
  private pickTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
  private frameMs = 16;
  private cpuMs = 1;
  private lastFrameAt = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private visuals: Visuals,
    rules: ResolvedRules,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    /* Three half-float G-buffer attachments are written every frame, so the
       drawing-buffer size is the dominant cost. 1.5 keeps a retina display
       sharp at roughly half the bandwidth of 2. */
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.autoClear = false;

    this.viewName = visuals.defaultViewName;

    const span = Math.max(world.nx, world.ny, world.nz);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, span * 12);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = span * 6;

    this.cells = new CellMesh(world, visuals);
    this.surface = new SurfaceMesh(world, visuals, rules);
    this.vessels = new VesselMesh(rules, visuals);
    this.scene.add(this.surface.mesh, this.vessels.group, this.cells.cells, this.cells.nuclei);

    const quadGeometry = new THREE.PlaneGeometry(1, 1);
    this.compositeMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tNormalDepth: { value: null },
        tIdentity: { value: null },
        tBloom: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uBackground: { value: new THREE.Vector3() },
        uTanHalfFov: { value: 0.35 },
        uAspect: { value: 1 },
        uNear: { value: 0.5 },
        uFar: { value: 1000 },
        uAoStrength: { value: 1 },
        uAoRadius: { value: 1.3 },
        uMembrane: { value: 0.55 },
        uMembraneDarkness: { value: 0.34 },
        uFogDensity: { value: 0.0042 },
        uFogStart: { value: 0 },
        uBloom: { value: 0 },
        uGrain: { value: 0.08 },
        uTime: { value: 0 },
        uDofStrength: { value: 0 },
        uDofFocus: { value: 40 },
        uDofRange: { value: 30 },
      },
    });
    this.prefilterMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLOOM_PREFILTER_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: { tColor: { value: null }, uThreshold: { value: 0.72 } },
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLOOM_BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: { tColor: { value: null }, uDirection: { value: new THREE.Vector2() } },
    });
    this.quad = new THREE.Mesh(quadGeometry, this.compositeMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.makeTargets(2, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.applyView(this.viewName);
    this.setCut(this.cutMode, this.cutFraction);
    this.frameTumour(1.0);
  }

  /* ---------------------------------------------------------------- *
   * Targets
   * ---------------------------------------------------------------- */

  private makeTargets(w: number, h: number): void {
    this.gbuffer?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    // Nearest filtering throughout: the identity target must never be
    // interpolated, because a blended id is not an id and the membrane pass
    // compares exact values.
    this.gbuffer = new THREE.WebGLRenderTarget<THREE.Texture[]>(w, h, {
      count: 3,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    const bw = Math.max(1, Math.floor(w * BLOOM_SCALE));
    const bh = Math.max(1, Math.floor(h * BLOOM_SCALE));
    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, opts);
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, opts);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const ratio = this.renderer.getPixelRatio();
    this.makeTargets(Math.floor(w * ratio), Math.floor(h * ratio));
  }

  /* ---------------------------------------------------------------- *
   * View, cut and camera
   * ---------------------------------------------------------------- */

  get view(): string {
    return this.viewName;
  }

  applyView(name: string): void {
    this.viewName = name;
    const v = this.visuals.view(name);
    this.cells.applyView(name);
    this.surface.applyView(name);
    this.vessels.applyView(name);
    // The section thickness is part of the view, so the cut has to be redone.
    this.setCut(this.cutMode, this.cutFraction);

    const [r, g, b] = linearFromHex(v.background);
    (this.compositeMaterial.uniforms.uBackground.value as THREE.Vector3).set(r, g, b);
    const u = this.compositeMaterial.uniforms;
    u.uAoStrength.value = v.post.ao;
    u.uAoRadius.value = v.post.aoRadius ?? 1.2;
    u.uMembrane.value = v.post.membrane;
    u.uMembraneDarkness.value = v.post.membraneDarkness ?? 0.34;
    u.uFogDensity.value = v.post.fogDensity;
    u.uBloom.value = v.post.bloom ?? 0;
    u.uGrain.value = v.post.grain ?? 0;
    this.prefilterMaterial.uniforms.uThreshold.value = v.post.bloomThreshold ?? 0.75;

    /* Fluorescence is emission, but the marks are still solid bodies: blending
       them additively with depth writes off turns a dense tumour into one white
       blob and multiplies the fill cost by the overdraw. The glow comes from
       the emission shading and a restrained bloom instead. */
    this.needsRebuild = true;
  }

  setColorBy(mode: ColorBy): void {
    this.cells.setColorBy(mode);
    this.needsRebuild = true;
  }

  /**
   * `fraction` runs 0 (cut at the centre, the default) to 1 (no cut), so the
   * control reads as "how much of the tumour is left whole".
   */
  setCut(mode: CutMode, fraction: number): void {
    this.cutMode = mode;
    this.cutFraction = fraction;
    const span = Math.max(this.world.nx, this.world.ny, this.world.nz) / 2;
    const offset = fraction * span;
    const point = new THREE.Vector3(offset, offset, offset);
    const normal = new THREE.Vector3(0, 0, 1);
    if (mode === 'plane') point.set(0, 0, offset);
    this.cells.setCut({ mode, point, normal });
    const modeId = mode === 'none' ? 0 : mode === 'plane' ? 1 : 2;

    /* The isosurface is cut back by the slab depth, so it begins exactly where
       the individual cells end. Otherwise the cells read as beads stuck to a
       skin that should not be there. */
    const slab =
      this.visuals.view(this.viewName).slabVoxels ?? this.visuals.raw.cell.slabVoxels ?? 4;
    const surfacePoint =
      mode === 'plane'
        ? point.clone().addScaledVector(normal, -slab)
        : point.clone().subScalar(slab);
    this.surface.setCut(modeId, surfacePoint, normal);
    this.vessels.setCut(modeId, point, normal);
    this.needsRebuild = true;
  }

  /**
   * Opens on the cut: about 30 degrees up, looking into the corner that was
   * removed, close enough that one cell spans a readable number of pixels.
   */
  frameTumour(zoom = 1): void {
    const radius = this.tumourRadius();
    const elevation = THREE.MathUtils.degToRad(30);
    // Along the diagonal of the removed octant, so all three cut faces show.
    const dir = new THREE.Vector3(1, 0, 1).normalize();
    dir.y = Math.tan(elevation) * Math.SQRT2;
    dir.normalize();

    /* Close enough that a cell is legible, far enough that it is a tissue
       sample rather than one cell filling the screen. The fit distance wins
       when the tumour is large; the cell-size bounds take over when it is not. */
    const fit = (radius * 2.2) / zoom;
    const distance = THREE.MathUtils.clamp(
      fit,
      this.distanceForCellPixels(30),
      this.distanceForCellPixels(12),
    );
    this.camera.position.copy(dir.multiplyScalar(distance));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Camera distance at which one cell spans `px` pixels. */
  private distanceForCellPixels(px: number): number {
    const h = this.renderer.domElement.clientHeight || 900;
    const diameter =
      2 * this.visuals.raw.cell.radiusFraction * (this.visuals.raw.cell.restingScale ?? 0.88);
    return (diameter * h) / (px * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  private tumourRadius(): number {
    const w = this.world;
    if (!w.count) return Math.max(w.nx, w.ny, w.nz) / 4;
    let r2 = 1;
    const cx = (w.nx - 1) / 2;
    const cy = (w.ny - 1) / 2;
    const cz = (w.nz - 1) / 2;
    for (let s = 0; s < w.count; s += Math.max(1, Math.floor(w.count / 2000))) {
      const node = w.nodeOfSlot[s];
      const x = (node % w.nx) - cx;
      const y = (Math.floor(node / w.nx) % w.ny) - cy;
      const z = Math.floor(node / (w.nx * w.ny)) - cz;
      const d = x * x + y * y + z * z;
      if (d > r2) r2 = d;
    }
    return Math.sqrt(r2);
  }

  /** Approximate on-screen size of one cell, in pixels. */
  cellPixels(): number {
    const h = this.renderer.domElement.clientHeight || 1;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const worldPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / h;
    const diameter = 2 * this.visuals.raw.cell.radiusFraction * (this.visuals.raw.cell.restingScale ?? 0.88);
    return diameter / worldPerPixel;
  }

  /** World units per screen pixel at the orbit target, for the scale bar. */
  worldPerPixel(): number {
    const h = this.renderer.domElement.clientHeight || 1;
    const distance = this.camera.position.distanceTo(this.controls.target);
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / h;
  }

  markDirty(): void {
    this.needsRebuild = true;
  }

  advance(dtSeconds: number, ticksPerSecond: number): void {
    const target = this.world.tick;
    const gap = target - this.displayTick;
    if (gap <= 0) return;
    const rate = Math.max(ticksPerSecond, gap * 2);
    this.displayTick = Math.min(target, this.displayTick + rate * dtSeconds);
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  render(seconds: number): FrameStats {
    const t0 = performance.now();
    /* Frame time is the interval between presented frames, not the time spent
       issuing the draw calls: WebGL is asynchronous, so timing the submission
       measures almost nothing. */
    if (this.lastFrameAt > 0) {
      this.frameMs = this.frameMs * 0.9 + (t0 - this.lastFrameAt) * 0.1;
    }
    this.lastFrameAt = t0;
    this.controls.update();

    if (this.world.rebuilt || this.needsRebuild) {
      this.cells.rebuild();
      this.needsRebuild = false;
      this.world.rebuilt = false;
      this.world.dirty.clear();
    } else if (this.world.dirty.size) {
      // A cell that changed state may have entered or left the slab, so the
      // selection is redone rather than patched.
      this.cells.rebuild();
      this.world.dirty.clear();
    }

    if (this.world.tick !== this.lastSurfaceTick) {
      this.surface.rebuild();
      this.lastSurfaceTick = this.world.tick;
    }

    /* Cells fade in as the camera closes on the cut; far away the mass is the
       isosurface alone, which is what keeps a distant tumour from reading as a
       cloud of dots. */
    const px = this.cellPixels();
    const fade = THREE.MathUtils.clamp((px - 2.5) / 5.5, 0, 1);
    this.cells.update(this.displayTick, fade);
    this.vessels.update(seconds);

    const v = this.visuals.view(this.viewName);
    const u = this.compositeMaterial.uniforms;
    u.uTime.value = seconds;
    u.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    u.uAspect.value = this.camera.aspect;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    const focus = this.camera.position.distanceTo(this.controls.target);
    // Haze begins at the near face of the sample, not at the lens.
    u.uFogStart.value = Math.max(0, focus - this.tumourRadius() * 1.15);
    u.uDofStrength.value = this.presentation ? 1 : 0;
    u.uDofFocus.value = focus;
    u.uDofRange.value = Math.max(4, this.tumourRadius() * 0.9);

    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    (u.uResolution.value as THREE.Vector2).copy(size);

    /* ---- geometry into the G-buffer ---- */
    const [br, bg, bb] = linearFromHex(v.background);
    this.renderer.setRenderTarget(this.gbuffer);
    this.renderer.setClearColor(new THREE.Color(br, bg, bb), 0);
    this.renderer.clear(true, true, false);
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    const info = { calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles };

    /* ---- bloom ---- */
    const bloom = v.post.bloom ?? 0;
    if (bloom > 0) {
      this.prefilterMaterial.uniforms.tColor.value = this.gbuffer.textures[0];
      this.blit(this.prefilterMaterial, this.bloomA);
      const texel = new THREE.Vector2(1 / this.bloomA.width, 1 / this.bloomA.height);
      this.blurMaterial.uniforms.tColor.value = this.bloomA.texture;
      (this.blurMaterial.uniforms.uDirection.value as THREE.Vector2).set(texel.x * 1.6, 0);
      this.blit(this.blurMaterial, this.bloomB);
      this.blurMaterial.uniforms.tColor.value = this.bloomB.texture;
      (this.blurMaterial.uniforms.uDirection.value as THREE.Vector2).set(0, texel.y * 1.6);
      this.blit(this.blurMaterial, this.bloomA);
      u.tBloom.value = this.bloomA.texture;
    } else {
      u.tBloom.value = this.bloomA.texture;
    }

    /* ---- composite to the screen ---- */
    u.tColor.value = this.gbuffer.textures[0];
    u.tNormalDepth.value = this.gbuffer.textures[1];
    u.tIdentity.value = this.gbuffer.textures[2];
    this.blit(this.compositeMaterial, null);

    this.cpuMs = this.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
    return {
      frameMs: this.frameMs,
      cpuMs: this.cpuMs,
      cells: this.cells.instanceCount,
      surfaceTriangles: this.surface.triangleCount,
      vesselTriangles: this.vessels.triangleCount,
      redCells: this.vessels.rbcCount,
      drawCalls: info.calls,
      triangles: info.tris,
    };
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.setRenderTarget(null);
  }

  /**
   * The node under the pointer, or -1.
   *
   * The identity target already holds a node id per pixel for the membrane
   * pass, so picking is one pixel read with no extra render.
   */
  pick(clientX: number, clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = this.renderer.getPixelRatio();
    const x = Math.floor((clientX - rect.left) * ratio);
    const y = Math.floor((clientY - rect.top) * ratio);
    const w = Math.max(1, Math.floor(rect.width * ratio));
    const h = Math.max(1, Math.floor(rect.height * ratio));
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;

    // Render a single pixel through the pointer, with only the cells present
    // and only their node id written.
    this.camera.setViewOffset(w, h, x, y, 1, 1);
    this.cells.setPicking(true);
    const surfaceWas = this.surface.mesh.visible;
    const vesselsWere = this.vessels.group.visible;
    this.surface.mesh.visible = false;
    this.vessels.group.visible = false;

    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickBuffer);
    this.renderer.setRenderTarget(null);

    this.surface.mesh.visible = surfaceWas;
    this.vessels.group.visible = vesselsWere;
    this.cells.setPicking(false);
    this.camera.clearViewOffset();

    const [r, g, b, a] = this.pickBuffer;
    if (a === 0) return -1;
    const node = r | (g << 8) | (b << 16);
    return node >= 0 && node < this.world.nodeCount ? node : -1;
  }

  dispose(): void {
    this.cells.dispose();
    this.surface.dispose();
    this.vessels.dispose();
    this.gbuffer.dispose();
    this.pickTarget.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

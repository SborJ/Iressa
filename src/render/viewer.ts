import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { World } from '../world/world.js';
import { CellMesh, type ViewMode } from './cellMesh.js';
import type { Visuals } from './visuals.js';

export type ClipAxis = 'none' | 'x' | 'y' | 'z';

const CLIP_NORMALS: Record<Exclude<ClipAxis, 'none'>, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/**
 * Camera, draw loop and picking. Knows nothing about biology: it draws what
 * the world holds, with the appearance visuals.json specifies.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly cells: CellMesh;

  /** Fractional tick the shader animates against, eased towards the world tick. */
  displayTick = 0;

  private pickTarget = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  private pickBuffer = new Uint8Array(4);
  private clipAxis: ClipAxis = 'none';
  private clipFraction = 1;

  constructor(canvas: HTMLCanvasElement, private world: World, visuals: Visuals) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(visuals.raw.scene.background).convertSRGBToLinear();

    const span = Math.max(world.nx, world.ny, world.nz);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, span * 12);
    this.camera.position.set(span * 0.85, span * 0.6, span * 1.05);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = span * 6;

    this.cells = new CellMesh(world, visuals);
    this.scene.add(this.cells.mesh);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setViewMode(mode: ViewMode): void {
    this.cells.setViewMode(mode);
  }

  setClip(axis: ClipAxis, fraction: number): void {
    this.clipAxis = axis;
    this.clipFraction = fraction;
    this.applyClip();
  }

  private applyClip(): void {
    if (this.clipAxis === 'none') {
      this.cells.setClip(CLIP_NORMALS.z, 1e9, false);
      return;
    }
    const normal = CLIP_NORMALS[this.clipAxis];
    const span =
      this.clipAxis === 'x' ? this.world.nx : this.clipAxis === 'y' ? this.world.ny : this.world.nz;
    // fraction 1 keeps everything, 0 cuts the whole half away.
    const offset = (this.clipFraction - 0.5) * span;
    this.cells.setClip(normal, offset, true);
  }

  /** Eases the display tick towards the world tick so animations stay smooth. */
  advance(dtSeconds: number, ticksPerSecond: number): void {
    const target = this.world.tick;
    const gap = target - this.displayTick;
    if (gap <= 0) return;
    const rate = Math.max(ticksPerSecond, gap * 2);
    this.displayTick = Math.min(target, this.displayTick + rate * dtSeconds);
  }

  render(): void {
    this.controls.update();
    this.cells.sync(this.displayTick, this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * The node under the pointer, or -1.
   *
   * Renders a one-pixel view through the pointer with the cells writing their
   * node index as colour, which is exact even where cells overlap and costs
   * one pixel of fill.
   */
  pick(clientX: number, clientY: number): number {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const ratio = this.renderer.getPixelRatio();
    const x = Math.floor((clientX - rect.left) * ratio);
    const y = Math.floor((clientY - rect.top) * ratio);
    const w = Math.floor(rect.width * ratio);
    const h = Math.floor(rect.height * ratio);
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;

    this.camera.setViewOffset(w, h, x, y, 1, 1);
    this.cells.setPicking(true);
    const prevTarget = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new THREE.Color()).clone();
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickBuffer);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.cells.setPicking(false);
    this.camera.clearViewOffset();

    const [r, g, b, a] = this.pickBuffer;
    if (a === 0) return -1;
    return r | (g << 8) | (b << 16);
  }

  dispose(): void {
    this.cells.dispose();
    this.pickTarget.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

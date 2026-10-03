import type { Grid } from './grid.js';
import { mulberry32 } from './rng.js';
import type { RulesFile } from './rules.js';

/**
 * A vascular tree, grown from rules.json.
 *
 * Vessels are part of the matrix, not decoration: their lumen voxels are where
 * oxygen and drug enter the tissue, and no cell may occupy a vessel. That is
 * what produces the structure the renderer shows - living cuffs of tissue
 * around vessels, necrosis in the ground between them.
 *
 * The whole network is a pure function of (rules.seed, rules.vasculature,
 * rules.grid), so the simulator and the renderer each derive the identical
 * network from rules.json. Nothing about it has to travel over the wire.
 */

export interface VesselSegment {
  /** Voxel-space endpoints. */
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** Lumen radius in voxels at each end. */
  ra: number;
  rb: number;
  depth: number;
  parent: number;
}

export interface Vasculature {
  segments: VesselSegment[];
  /** 0 empty, 1 lumen, 2 wall. A cell may occupy neither. */
  mask: Uint8Array;
  /** Lumen voxels: the Dirichlet sources for every transported field. */
  sources: Int32Array;
  /** Voxels a cell may not enter (lumen plus wall). */
  blockedCount: number;
}

interface Tip {
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  radius: number;
  depth: number;
  sinceBranch: number;
  parent: number;
}

const norm = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/** Any unit vector perpendicular to d. */
function perpendicular(dx: number, dy: number, dz: number): [number, number, number] {
  const ax = Math.abs(dx) < 0.9 ? 1 : 0;
  const ay = Math.abs(dx) < 0.9 ? 0 : 1;
  return norm(dy * 0 - dz * ay, dz * ax - dx * 0, dx * ay - dy * ax);
}

function rotateAbout(
  vx: number, vy: number, vz: number,
  kx: number, ky: number, kz: number,
  angle: number,
): [number, number, number] {
  // Rodrigues' rotation.
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = kx * vx + ky * vy + kz * vz;
  return norm(
    vx * c + (ky * vz - kz * vy) * s + kx * dot * (1 - c),
    vy * c + (kz * vx - kx * vz) * s + ky * dot * (1 - c),
    vz * c + (kx * vy - ky * vx) * s + kz * dot * (1 - c),
  );
}

export function growVasculature(rules: RulesFile, grid: Grid): Vasculature | undefined {
  const spec = rules.vasculature;
  if (!spec) return undefined;

  const murray = spec.murrayExponent ?? 3;
  const rng = mulberry32((rules.seed ^ 0x5bf03635) >>> 0);
  const cx = (grid.nx - 1) / 2;
  const cy = (grid.ny - 1) / 2;
  const cz = (grid.nz - 1) / 2;
  const radius = Math.min(grid.nx, grid.ny, grid.nz) / 2;

  const segments: VesselSegment[] = [];
  let tips: Tip[] = [];

  /* Trunks enter from the domain boundary, aimed past the centre so they run
     through the tissue rather than stopping in it. */
  for (let t = 0; t < spec.trunks; t++) {
    const theta = ((t + rng() * 0.5) / spec.trunks) * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    const sx = cx + Math.sin(phi) * Math.cos(theta) * radius * 0.98;
    const sy = cy + Math.cos(phi) * radius * 0.98;
    const sz = cz + Math.sin(phi) * Math.sin(theta) * radius * 0.98;
    const jitter = radius * 0.35;
    const [dx, dy, dz] = norm(
      cx + (rng() - 0.5) * jitter - sx,
      cy + (rng() - 0.5) * jitter - sy,
      cz + (rng() - 0.5) * jitter - sz,
    );
    tips.push({
      x: sx, y: sy, z: sz,
      dx, dy, dz,
      radius: spec.trunkRadiusVoxels,
      depth: 0,
      sinceBranch: 0,
      parent: -1,
    });
  }

  const inside = (x: number, y: number, z: number) =>
    x >= -2 && y >= -2 && z >= -2 && x <= grid.nx + 1 && y <= grid.ny + 1 && z <= grid.nz + 1;

  /* Breadth-first growth, so every branch gets the same number of chances. */
  let guard = 0;
  while (tips.length && guard++ < 20000) {
    const next: Tip[] = [];
    for (const tip of tips) {
      if (tip.depth > spec.maxDepth || tip.radius < spec.minRadiusVoxels) continue;

      // Wander: perturb the heading, which is what makes a vessel tortuous
      // rather than a straight pipe.
      const [px, py, pz] = perpendicular(tip.dx, tip.dy, tip.dz);
      const spin = rng() * Math.PI * 2;
      const [wx, wy, wz] = rotateAbout(px, py, pz, tip.dx, tip.dy, tip.dz, spin);
      const bend = spec.tortuosity * (0.5 + rng());
      const [dx, dy, dz] = norm(
        tip.dx + wx * bend,
        tip.dy + wy * bend,
        tip.dz + wz * bend,
      );

      const len = spec.segmentLengthVoxels * (0.7 + rng() * 0.6);
      const ex = tip.x + dx * len;
      const ey = tip.y + dy * len;
      const ez = tip.z + dz * len;
      if (!inside(ex, ey, ez)) continue;

      const index = segments.length;
      segments.push({
        ax: tip.x, ay: tip.y, az: tip.z,
        bx: ex, by: ey, bz: ez,
        ra: tip.radius,
        rb: tip.radius,
        depth: tip.depth,
        parent: tip.parent,
      });

      const shouldBranch =
        tip.sinceBranch + 1 >= spec.branchEverySegments && tip.depth + 1 <= spec.maxDepth;

      if (!shouldBranch) {
        next.push({
          x: ex, y: ey, z: ez,
          dx, dy, dz,
          radius: tip.radius,
          depth: tip.depth,
          sinceBranch: tip.sinceBranch + 1,
          parent: index,
        });
        continue;
      }

      /* Murray's law: the parent's cubed radius is shared between the children,
         which is why real vessels taper the way they do. */
      const split = 0.35 + rng() * 0.3;
      const total = Math.pow(tip.radius, murray);
      const r1 = Math.pow(total * split, 1 / murray);
      const r2 = Math.pow(total * (1 - split), 1 / murray);
      const [kx, ky, kz] = rotateAbout(
        ...perpendicular(dx, dy, dz),
        dx, dy, dz,
        rng() * Math.PI * 2,
      );
      for (const [childRadius, sign] of [
        [r1, 1],
        [r2, -1],
      ] as [number, number][]) {
        if (childRadius < spec.minRadiusVoxels) continue;
        const angle = spec.branchAngle * (0.6 + rng() * 0.8) * sign;
        const [bx2, by2, bz2] = rotateAbout(dx, dy, dz, kx, ky, kz, angle);
        next.push({
          x: ex, y: ey, z: ez,
          dx: bx2, dy: by2, dz: bz2,
          radius: childRadius,
          depth: tip.depth + 1,
          sinceBranch: 0,
          parent: index,
        });
      }
    }
    tips = next;
  }

  /* Taper each segment towards its children, so radius falls smoothly. */
  const childRadius = new Map<number, number>();
  for (const s of segments) {
    if (s.parent >= 0) {
      childRadius.set(s.parent, Math.max(childRadius.get(s.parent) ?? 0, s.ra));
    }
  }
  for (let i = 0; i < segments.length; i++) {
    segments[i].rb = childRadius.get(i) ?? segments[i].ra * 0.8;
  }

  /* Rasterise: lumen, then a wall shell around it. */
  const mask = new Uint8Array(grid.count);
  const stamp = (x: number, y: number, z: number, r: number, value: number) => {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(grid.nx - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(grid.ny - 1, Math.ceil(y + r));
    const z0 = Math.max(0, Math.floor(z - r));
    const z1 = Math.min(grid.nz - 1, Math.ceil(z + r));
    for (let vz = z0; vz <= z1; vz++) {
      const ddz = vz - z;
      for (let vy = y0; vy <= y1; vy++) {
        const ddy = vy - y;
        const row = vy * grid.strideY + vz * grid.strideZ;
        for (let vx = x0; vx <= x1; vx++) {
          const ddx = vx - x;
          if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue;
          const i = row + vx;
          // Lower is stronger: lumen (1) wins over wall (2), both over empty (0).
          if (mask[i] !== 0 && value >= mask[i]) continue;
          mask[i] = value;
        }
      }
    }
  };

  // Walls first (value 2), lumen second (value 1), so lumen wins where they meet.
  for (const pass of [2, 1] as const) {
    const extra = pass === 2 ? spec.wallThicknessVoxels : 0;
    for (const s of segments) {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const dz = s.bz - s.az;
      const len = Math.hypot(dx, dy, dz);
      const steps = Math.max(2, Math.ceil(len * 2));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        stamp(
          s.ax + dx * t,
          s.ay + dy * t,
          s.az + dz * t,
          s.ra + (s.rb - s.ra) * t + extra,
          pass,
        );
      }
    }
  }

  const sourceList: number[] = [];
  let blocked = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) sourceList.push(i);
    if (mask[i] !== 0) blocked++;
  }

  return {
    segments,
    mask,
    sources: Int32Array.from(sourceList),
    blockedCount: blocked,
  };
}

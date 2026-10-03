/**
 * The smooth outer surface of the tumour.
 *
 * Occupancy is a binary field - a node is either a cell or it is not - so
 * drawing it directly gives a staircase. Blurring it and extracting an
 * isosurface with surface nets gives the smooth organic boundary a cleared
 * tissue sample has, while still following the real occupied nodes exactly:
 * the surface moves only where cells are.
 *
 * Surface nets rather than marching cubes because the dual formulation puts one
 * vertex per cell of the dual grid, which is both cheaper and smoother.
 */

export interface SurfaceBox {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
}

export interface SurfaceResult {
  positions: Float32Array;
  normals: Float32Array;
  /** Per-vertex scalar in 0..1: how deep inside the mass the surface sits. */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/** Corner offsets of a dual cell, in the order the edge table expects. */
const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGE = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export class OccupancyField {
  readonly value: Float32Array;
  private scratch: Float32Array;

  constructor(
    readonly nx: number,
    readonly ny: number,
    readonly nz: number,
  ) {
    this.value = new Float32Array(nx * ny * nz);
    this.scratch = new Float32Array(nx * ny * nz);
  }

  /**
   * Separable box blur, repeated. Three passes of a 3-tap box approximate a
   * gaussian closely enough and cost three adds per voxel per axis.
   */
  blur(box: SurfaceBox, passes: number): void {
    const { nx, ny } = this;
    const strideY = nx;
    const strideZ = nx * ny;
    let src = this.value;
    let dst = this.scratch;
    for (let p = 0; p < passes; p++) {
      for (const stride of [1, strideY, strideZ]) {
        for (let z = box.z0; z <= box.z1; z++) {
          for (let y = box.y0; y <= box.y1; y++) {
            const row = y * strideY + z * strideZ;
            for (let x = box.x0; x <= box.x1; x++) {
              const i = row + x;
              dst[i] = (src[i - stride] + src[i] + src[i + stride]) / 3;
            }
          }
        }
        const t = src;
        src = dst;
        dst = t;
      }
    }
    if (src !== this.value) {
      this.value.set(src);
    }
  }

  clear(box: SurfaceBox): void {
    const strideY = this.nx;
    const strideZ = this.nx * this.ny;
    for (let z = box.z0; z <= box.z1; z++) {
      for (let y = box.y0; y <= box.y1; y++) {
        const row = y * strideY + z * strideZ;
        this.value.fill(0, row + box.x0, row + box.x1 + 1);
        this.scratch.fill(0, row + box.x0, row + box.x1 + 1);
      }
    }
  }
}

/**
 * Extracts the isosurface of `field` at `iso` inside `box`.
 *
 * The surface is built only where occupancy crosses the isolevel, so an empty
 * region costs one comparison per dual cell and nothing else.
 */
export function surfaceNets(
  field: OccupancyField,
  box: SurfaceBox,
  iso: number,
): SurfaceResult {
  const { nx, ny } = field;
  const strideY = nx;
  const strideZ = nx * ny;
  const f = field.value;

  const spanX = box.x1 - box.x0;
  const spanY = box.y1 - box.y0;
  const spanZ = box.z1 - box.z0;
  if (spanX < 2 || spanY < 2 || spanZ < 2) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      vertexCount: 0,
      triangleCount: 0,
    };
  }

  // Dual-cell vertex index, -1 where the surface does not cross.
  const dualX = spanX;
  const dualY = spanY;
  const dualZ = spanZ;
  const vertexAt = new Int32Array(dualX * dualY * dualZ).fill(-1);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const corners = new Float32Array(8);

  const gradient = (x: number, y: number, z: number): [number, number, number] => {
    const i = Math.round(x) + Math.round(y) * strideY + Math.round(z) * strideZ;
    return [
      f[i + 1] - f[i - 1],
      f[i + strideY] - f[i - strideY],
      f[i + strideZ] - f[i - strideZ],
    ];
  };

  for (let z = 0; z < dualZ; z++) {
    const wz = box.z0 + z;
    for (let y = 0; y < dualY; y++) {
      const wy = box.y0 + y;
      for (let x = 0; x < dualX; x++) {
        const wx = box.x0 + x;
        const base = wx + wy * strideY + wz * strideZ;

        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [ox, oy, oz] = CORNER[c];
          const v = f[base + ox + oy * strideY + oz * strideZ];
          corners[c] = v;
          if (v < iso) mask |= 1 << c;
        }
        if (mask === 0 || mask === 0xff) continue;

        // Vertex position: the mean of the crossings on the 12 edges.
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let crossings = 0;
        for (const [a, b] of EDGE) {
          const va = corners[a];
          const vb = corners[b];
          if (va < iso === vb < iso) continue;
          const t = (iso - va) / (vb - va || 1e-6);
          sx += CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * t;
          sy += CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * t;
          sz += CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * t;
          crossings++;
        }
        if (!crossings) continue;

        const px = wx + sx / crossings;
        const py = wy + sy / crossings;
        const pz = wz + sz / crossings;

        vertexAt[x + y * dualX + z * dualX * dualY] = positions.length / 3;
        positions.push(px, py, pz);
        // The field decreases outwards, so the outward normal is -grad.
        const [gx, gy, gz] = gradient(px, py, pz);
        const len = Math.hypot(gx, gy, gz) || 1;
        normals.push(-gx / len, -gy / len, -gz / len);
      }
    }
  }

  /* Quads: for each dual-grid edge that crosses, join the four dual cells
     around it. Winding follows the sign of the crossing so faces point out. */
  const vIndex = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= dualX || y >= dualY || z >= dualZ
      ? -1
      : vertexAt[x + y * dualX + z * dualX * dualY];

  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };

  for (let z = 1; z < dualZ; z++) {
    const wz = box.z0 + z;
    for (let y = 1; y < dualY; y++) {
      const wy = box.y0 + y;
      for (let x = 1; x < dualX; x++) {
        const wx = box.x0 + x;
        const i = wx + wy * strideY + wz * strideZ;
        const here = f[i] < iso;

        if (f[i + 1] < iso !== here) {
          quad(
            vIndex(x, y - 1, z - 1), vIndex(x, y, z - 1),
            vIndex(x, y, z), vIndex(x, y - 1, z),
            here,
          );
        }
        if (f[i + strideY] < iso !== here) {
          quad(
            vIndex(x - 1, y, z - 1), vIndex(x, y, z - 1),
            vIndex(x, y, z), vIndex(x - 1, y, z),
            !here,
          );
        }
        if (f[i + strideZ] < iso !== here) {
          quad(
            vIndex(x - 1, y - 1, z), vIndex(x, y - 1, z),
            vIndex(x, y, z), vIndex(x - 1, y, z),
            here,
          );
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: Uint32Array.from(indices),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

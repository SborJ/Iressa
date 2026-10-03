/** Voxel lattice. One node per voxel; at most one cell per node. */
export class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly count: number;
  readonly strideY: number;
  readonly strideZ: number;
  /** Flat index deltas for the chosen neighbourhood. */
  readonly offsets: Int32Array;
  readonly dx: Int8Array;
  readonly dy: Int8Array;
  readonly dz: Int8Array;
  readonly degree: number;

  constructor(nx: number, ny: number, nz: number, neighborhood: 6 | 18 | 26 = 26) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.count = nx * ny * nz;
    this.strideY = nx;
    this.strideZ = nx * ny;

    const dxs: number[] = [];
    const dys: number[] = [];
    const dzs: number[] = [];
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          const m = Math.abs(x) + Math.abs(y) + Math.abs(z);
          if (m === 0) continue;
          if (neighborhood === 6 && m !== 1) continue;
          if (neighborhood === 18 && m === 3) continue;
          dxs.push(x);
          dys.push(y);
          dzs.push(z);
        }
      }
    }
    this.dx = new Int8Array(dxs);
    this.dy = new Int8Array(dys);
    this.dz = new Int8Array(dzs);
    this.degree = dxs.length;
    this.offsets = new Int32Array(this.degree);
    for (let k = 0; k < this.degree; k++) {
      this.offsets[k] = dxs[k] + dys[k] * this.strideY + dzs[k] * this.strideZ;
    }
  }

  index(x: number, y: number, z: number): number {
    return x + y * this.strideY + z * this.strideZ;
  }

  x(i: number): number {
    return i % this.nx;
  }

  y(i: number): number {
    return Math.floor(i / this.strideY) % this.ny;
  }

  z(i: number): number {
    return Math.floor(i / this.strideZ);
  }

  isBoundary(x: number, y: number, z: number): boolean {
    return x === 0 || y === 0 || z === 0 || x === this.nx - 1 || y === this.ny - 1 || z === this.nz - 1;
  }

  /**
   * Fills `out` with the in-bounds neighbours of node `i` and returns how many
   * there are. `out` must hold at least `degree` entries.
   */
  neighbors(i: number, out: Int32Array): number {
    const x = i % this.nx;
    const y = Math.floor(i / this.strideY) % this.ny;
    const z = Math.floor(i / this.strideZ);
    let n = 0;
    for (let k = 0; k < this.degree; k++) {
      const nx2 = x + this.dx[k];
      if (nx2 < 0 || nx2 >= this.nx) continue;
      const ny2 = y + this.dy[k];
      if (ny2 < 0 || ny2 >= this.ny) continue;
      const nz2 = z + this.dz[k];
      if (nz2 < 0 || nz2 >= this.nz) continue;
      out[n++] = i + this.offsets[k];
    }
    return n;
  }
}

/** Axis-aligned box of active voxels, grown as the tumour grows. */
export class ActiveBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;

  constructor(private grid: Grid) {
    this.minX = grid.nx;
    this.minY = grid.ny;
    this.minZ = grid.nz;
    this.maxX = -1;
    this.maxY = -1;
    this.maxZ = -1;
  }

  get empty(): boolean {
    return this.maxX < this.minX;
  }

  include(i: number, margin = 0): void {
    const g = this.grid;
    const x = g.x(i);
    const y = g.y(i);
    const z = g.z(i);
    if (x - margin < this.minX) this.minX = Math.max(0, x - margin);
    if (y - margin < this.minY) this.minY = Math.max(0, y - margin);
    if (z - margin < this.minZ) this.minZ = Math.max(0, z - margin);
    if (x + margin > this.maxX) this.maxX = Math.min(g.nx - 1, x + margin);
    if (y + margin > this.maxY) this.maxY = Math.min(g.ny - 1, y + margin);
    if (z + margin > this.maxZ) this.maxZ = Math.min(g.nz - 1, z + margin);
  }
}

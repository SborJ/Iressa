import type { Grid, ActiveBox } from './grid.js';

/**
 * A diffusing, consumed scalar field on the lattice.
 *
 * The same relaxation serves oxygen (constant boundary = the vascular supply)
 * and each drug (boundary = the plasma concentration of the moment). All
 * parameters come from rules.json; nothing here chooses a number.
 */
export class DiffusiveField {
  readonly value: Float32Array;
  private scratch: Float32Array;

  constructor(private grid: Grid, initial = 0) {
    this.value = new Float32Array(grid.count).fill(initial);
    this.scratch = new Float32Array(grid.count);
  }

  /** Reset the whole field to the boundary value. */
  fill(v: number): void {
    this.value.fill(v);
  }

  /**
   * Jacobi relaxation towards a quasi-steady state.
   *
   * Only the active box is swept; everything outside it is held at the
   * boundary value, which is correct while the tumour is far from the faces
   * and is what keeps a 64^3 lattice interactive.
   *
   * `sources` are Dirichlet nodes pinned to `sourceValue` after every sweep.
   * With a vascular tree those are the lumen voxels, and they - not the domain
   * boundary - are where oxygen and drug enter the tissue.
   */
  relax(opts: {
    box: ActiveBox;
    boundary: number;
    maximum: number;
    diffusion: number;
    consumptionPerCell: number;
    weight: Float32Array;
    sweeps: number;
    sources?: Int32Array;
    sourceValue?: number;
  }): void {
    const g = this.grid;
    const { strideY, strideZ } = g;
    const cur = this.value;
    const next = this.scratch;
    const { box, boundary, maximum, diffusion, consumptionPerCell, weight, sweeps } = opts;
    const sources = opts.sources;
    const sourceValue = opts.sourceValue ?? 0;

    const pinSources = () => {
      if (!sources) return;
      for (let k = 0; k < sources.length; k++) cur[sources[k]] = sourceValue;
    };

    if (box.empty) {
      cur.fill(boundary);
      pinSources();
      return;
    }

    // One voxel of padding inside the box is clamped to the boundary value, so
    // the sweep has a Dirichlet condition to pull against.
    const x0 = Math.max(1, box.minX);
    const x1 = Math.min(g.nx - 2, box.maxX);
    const y0 = Math.max(1, box.minY);
    const y1 = Math.min(g.ny - 2, box.maxY);
    const z0 = Math.max(1, box.minZ);
    const z1 = Math.min(g.nz - 2, box.maxZ);

    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let y = y0 - 1; y <= y1 + 1; y++) {
        const row = y * strideY + z * strideZ;
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          const i = row + x;
          if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) cur[i] = boundary;
        }
      }
    }
    pinSources();

    for (let s = 0; s < sweeps; s++) {
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          const row = y * strideY + z * strideZ;
          for (let x = x0; x <= x1; x++) {
            const i = row + x;
            const c = cur[i];
            const lap =
              cur[i - 1] + cur[i + 1] +
              cur[i - strideY] + cur[i + strideY] +
              cur[i - strideZ] + cur[i + strideZ] -
              6 * c;
            let v = c + diffusion * lap - consumptionPerCell * weight[i];
            if (v < 0) v = 0;
            else if (v > maximum) v = maximum;
            next[i] = v;
          }
        }
      }
      // Copy the swept region back; the padding ring already holds the boundary value.
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          const row = y * strideY + z * strideZ;
          cur.set(next.subarray(row + x0, row + x1 + 1), row + x0);
        }
      }
      pinSources();
    }
  }
}

/**
 * One-compartment pharmacokinetics with first-order absorption, stepped a tick
 * at a time. Doses arrive from the schedule in rules.json.
 */
export class Pharmacokinetics {
  private gut = 0;
  private plasmaValue = 0;
  private readonly ke: number;

  constructor(
    private readonly ka: number,
    eliminationHalfLifeHours: number,
    private readonly bioavailability: number,
    private readonly volumeOfDistribution: number,
  ) {
    this.ke = Math.LN2 / eliminationHalfLifeHours;
  }

  get plasma(): number {
    return this.plasmaValue;
  }

  dose(amount: number): void {
    this.gut += amount * this.bioavailability;
  }

  step(hours: number): void {
    const absorbed = this.gut * (1 - Math.exp(-this.ka * hours));
    this.gut -= absorbed;
    this.plasmaValue = this.plasmaValue * Math.exp(-this.ke * hours) + absorbed / this.volumeOfDistribution;
  }

  reset(): void {
    this.gut = 0;
    this.plasmaValue = 0;
  }
}

/** Hill function: the standard concentration-response shape. */
export function hill(concentration: number, ic50: number, n: number): number {
  if (concentration <= 0) return 0;
  const r = Math.pow(concentration / ic50, n);
  return r / (1 + r);
}

/** Michaelis-Menten saturation, used for oxygen-limited cycle speed. */
export function michaelis(c: number, halfMax: number): number {
  return c <= 0 ? 0 : c / (c + halfMax);
}

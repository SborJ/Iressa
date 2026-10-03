import {
  EventType,
  EventWriter,
  NO_DRUG,
  NO_VALUE,
  packStateChange,
} from '../format/events.js';
import type { Keyframe, KeyframeNode } from '../format/keyframes.js';
import { encodeKeyframe } from '../format/keyframes.js';
import { DiffusiveField, Pharmacokinetics, hill, michaelis } from './fields.js';
import { ActiveBox, Grid } from './grid.js';
import { Channel, uniform, uniformInt } from './rng.js';
import { requireCause, requireState, type ResolvedRules } from './rules.js';

/** A named scalar the UI can display without knowing what it means. */
export interface ProbeReading {
  label: string;
  value: number;
  format?: 'fraction' | 'number';
}

export interface TickResult {
  tick: number;
  /** Packed 16-byte event records emitted this tick. The same bytes a socket would carry. */
  events: Uint8Array;
  /** Present on keyframe ticks. */
  keyframe?: Uint8Array;
  done: boolean;
}

export interface SimStats {
  tick: number;
  hours: number;
  living: number;
  dying: number;
  byClone: Map<number, number>;
  byState: Map<number, number>;
  plasma: Map<number, number>;
}

const FIELD_MARGIN = 8;

/**
 * The stand-in simulator.
 *
 * Every tick it reads each living node's local situation out of the matrix -
 * oxygen, drug concentration, free neighbours, its clone profile, how long it
 * has been in its state - turns that into per-cause probabilities using
 * rules.json, and emits the event with the cause that fired.
 *
 * There is not a single rate, threshold or probability in this file. They all
 * come from the rules. The same node can die of different causes in different
 * runs depending on where it sits and what treatment it has had.
 */
export class Simulator {
  readonly grid: Grid;
  readonly rules: ResolvedRules;

  tick = 0;

  /* Per-node state, structure-of-arrays over the node index. */
  private readonly occupied: Uint8Array;
  private readonly clone: Uint16Array;
  private readonly state: Uint8Array;
  private readonly cause: Uint8Array;
  private readonly causeDrug: Uint8Array;
  private readonly cycleProgress: Float32Array;
  private readonly stateSince: Uint32Array;
  private readonly hypoxicTicks: Uint16Array;

  /* Compact list of occupied nodes, with swap removal. */
  private readonly nodes: Int32Array;
  private readonly slotOf: Int32Array;
  private nodeCount = 0;

  /* Fields. */
  private readonly oxygen: DiffusiveField;
  private readonly drugFields = new Map<number, DiffusiveField>();
  private readonly pk = new Map<number, Pharmacokinetics>();
  private readonly weight: Float32Array;
  private box: ActiveBox;

  /* Resolved ids - looked up once from the rules, never written in code. */
  private readonly cNormal: number;
  private readonly cBaseline: number;
  private readonly cDrugDeath: number;
  private readonly cNecrosis: number;
  private readonly cRadiation: number;
  private readonly cCrowding: number;
  private readonly cHypoxiaArrest: number;
  private readonly cDrugArrest: number;
  private readonly cImmune: number;
  private readonly cMutation: number;
  private readonly sCycling: number;
  private readonly sArrested: number;
  private readonly sDamaged: number;
  private readonly sDying: number;
  private readonly aliveByState: Uint8Array;
  private readonly occupiesByState: Uint8Array;

  /* Scratch, reused every node to keep the tick allocation-free. */
  private readonly nbr: Int32Array;
  private readonly hazard: Float64Array;
  private readonly hazardCause: Int32Array;
  private readonly hazardDrug: Int32Array;
  private readonly freeSlots: Int32Array;
  private readonly writer = new EventWriter(8192);
  private readonly dosesGiven = new Map<number, number>();

  constructor(rules: ResolvedRules) {
    this.rules = rules;
    const g = rules.raw.grid;
    this.grid = new Grid(g.nx, g.ny, g.nz, g.neighborhood ?? 26);
    const n = this.grid.count;

    this.occupied = new Uint8Array(n);
    this.clone = new Uint16Array(n);
    this.state = new Uint8Array(n);
    this.cause = new Uint8Array(n);
    this.causeDrug = new Uint8Array(n);
    this.cycleProgress = new Float32Array(n);
    this.stateSince = new Uint32Array(n);
    this.hypoxicTicks = new Uint16Array(n);
    this.nodes = new Int32Array(n);
    this.slotOf = new Int32Array(n).fill(-1);
    this.weight = new Float32Array(n);

    this.oxygen = new DiffusiveField(this.grid, rules.raw.oxygen.boundary);
    for (const d of rules.raw.drugs ?? []) {
      this.drugFields.set(d.id, new DiffusiveField(this.grid, 0));
      this.pk.set(
        d.id,
        new Pharmacokinetics(
          d.pk.absorptionPerHour,
          d.pk.eliminationHalfLifeHours,
          d.pk.bioavailability ?? 1,
          d.pk.volumeOfDistribution ?? 1,
        ),
      );
    }
    this.box = new ActiveBox(this.grid);

    this.cNormal = requireCause(rules, 'normalCycle');
    this.cBaseline = requireCause(rules, 'baselineApoptosis');
    this.cNecrosis = requireCause(rules, 'hypoxicNecrosis');
    this.cCrowding = requireCause(rules, 'crowdingArrest');
    this.cHypoxiaArrest = requireCause(rules, 'hypoxiaArrest');
    this.cMutation = requireCause(rules, 'mutation');
    this.cDrugDeath = rules.causeByRole.get('drugApoptosis')?.id ?? -1;
    this.cDrugArrest = rules.causeByRole.get('drugArrest')?.id ?? -1;
    this.cRadiation = rules.causeByRole.get('radiation')?.id ?? -1;
    this.cImmune = rules.causeByRole.get('immuneKill')?.id ?? -1;

    this.sCycling = requireState(rules, 'cycling');
    this.sArrested = requireState(rules, 'arrested');
    this.sDying = requireState(rules, 'dying');
    this.sDamaged = rules.stateByRole.get('damaged')?.id ?? -1;

    this.aliveByState = new Uint8Array(256);
    this.occupiesByState = new Uint8Array(256);
    for (const s of rules.raw.states) {
      this.aliveByState[s.id] = (s.alive ?? true) ? 1 : 0;
      this.occupiesByState[s.id] = (s.occupies ?? true) ? 1 : 0;
    }

    this.nbr = new Int32Array(this.grid.degree);
    this.freeSlots = new Int32Array(this.grid.degree);
    const causeSlots = 3 + (rules.raw.drugs ?? []).length;
    this.hazard = new Float64Array(causeSlots);
    this.hazardCause = new Int32Array(causeSlots);
    this.hazardDrug = new Int32Array(causeSlots);

    this.reset();
  }

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  reset(): void {
    this.tick = 0;
    this.occupied.fill(0);
    this.state.fill(0);
    this.cause.fill(0);
    this.causeDrug.fill(NO_DRUG);
    this.cycleProgress.fill(0);
    this.stateSince.fill(0);
    this.hypoxicTicks.fill(0);
    this.slotOf.fill(-1);
    this.weight.fill(0);
    this.nodeCount = 0;
    this.dosesGiven.clear();
    this.box = new ActiveBox(this.grid);
    this.oxygen.fill(this.rules.raw.oxygen.boundary);
    for (const f of this.drugFields.values()) f.fill(0);
    for (const p of this.pk.values()) p.reset();

    const g = this.grid;
    const seeding = this.rules.raw.seeding;
    const [cx, cy, cz] = seeding.center ?? [
      Math.floor(g.nx / 2),
      Math.floor(g.ny / 2),
      Math.floor(g.nz / 2),
    ];
    const r = seeding.radiusVoxels;
    const r2 = r * r;
    const seed = this.rules.raw.seed;
    for (let z = Math.ceil(cz - r); z <= Math.floor(cz + r); z++) {
      for (let y = Math.ceil(cy - r); y <= Math.floor(cy + r); y++) {
        for (let x = Math.ceil(cx - r); x <= Math.floor(cx + r); x++) {
          if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
          const dx = x - cx;
          const dy = y - cy;
          const dz = z - cz;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const i = g.index(x, y, z);
          this.placeCell(i, seeding.clone, uniform(seed, 0, i, Channel.Seeding));
        }
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Node bookkeeping
   * ---------------------------------------------------------------- */

  private oxygenWeight(stateId: number): number {
    return this.aliveByState[stateId]
      ? 1
      : (this.rules.raw.oxygen.debrisConsumptionFactor ?? 0);
  }

  private placeCell(node: number, cloneId: number, progress: number): void {
    this.occupied[node] = 1;
    this.clone[node] = cloneId;
    this.state[node] = this.sCycling;
    this.cause[node] = this.cNormal;
    this.causeDrug[node] = NO_DRUG;
    this.cycleProgress[node] = progress;
    this.stateSince[node] = this.tick;
    this.hypoxicTicks[node] = 0;
    this.weight[node] = this.oxygenWeight(this.sCycling);
    this.slotOf[node] = this.nodeCount;
    this.nodes[this.nodeCount++] = node;
    this.box.include(node, FIELD_MARGIN);
  }

  private removeCell(node: number): void {
    const slot = this.slotOf[node];
    if (slot < 0) return;
    const last = this.nodes[--this.nodeCount];
    this.nodes[slot] = last;
    this.slotOf[last] = slot;
    this.slotOf[node] = -1;
    this.occupied[node] = 0;
    this.weight[node] = 0;
    this.hypoxicTicks[node] = 0;
  }

  private setState(node: number, stateId: number, causeId: number, drug: number): void {
    this.state[node] = stateId;
    this.cause[node] = causeId;
    this.causeDrug[node] = drug;
    this.stateSince[node] = this.tick;
    this.weight[node] = this.oxygenWeight(stateId);
  }

  /* ---------------------------------------------------------------- *
   * One tick
   * ---------------------------------------------------------------- */

  step(): TickResult {
    const rules = this.rules;
    const dt = rules.hoursPerTick;
    const tick = this.tick;
    const hours = tick * dt;
    this.writer.clear();

    // The keyframe is the state at the start of the tick, so a consumer can
    // apply it and then the tick's events without double-counting. The tick-0
    // keyframe is how the seeded population reaches anything downstream.
    const keyframe =
      tick % rules.keyframeEveryTicks === 0 ? encodeKeyframe(this.snapshot()) : undefined;

    this.applySchedule(hours, dt);
    this.relaxFields();
    if (this.cRadiation >= 0) this.applyRadiation(hours, dt);
    this.evaluateNodes();

    this.tick++;
    return {
      tick,
      events: this.writer.bytes(),
      keyframe,
      done: this.tick >= rules.maxTicks || this.nodeCount === 0,
    };
  }

  /** Doses due in [hours, hours + dt), then one PK step. */
  private applySchedule(hours: number, dt: number): void {
    for (const s of this.rules.raw.treatment?.schedule ?? []) {
      const pk = this.pk.get(s.drug);
      if (!pk) continue;
      const key = s.drug;
      for (let k = 0; k < s.doses; k++) {
        const at = s.startHour + k * s.everyHours;
        if (at >= hours && at < hours + dt) {
          pk.dose(s.amount);
          this.dosesGiven.set(key, (this.dosesGiven.get(key) ?? 0) + 1);
        }
      }
    }
    for (const pk of this.pk.values()) pk.step(dt);
  }

  private relaxFields(): void {
    const ox = this.rules.raw.oxygen;
    this.oxygen.relax(
      this.box,
      ox.boundary,
      ox.diffusion,
      ox.consumptionPerCell,
      this.weight,
      ox.relaxSweepsPerTick,
    );
    for (const d of this.rules.raw.drugs ?? []) {
      const field = this.drugFields.get(d.id);
      const pk = this.pk.get(d.id);
      if (!field || !pk) continue;
      field.relax(
        this.box,
        pk.plasma,
        d.penetration.diffusion,
        d.penetration.uptakePerCell,
        this.weight,
        d.penetration.relaxSweepsPerTick,
      );
    }
  }

  /**
   * Linear-quadratic kill with an oxygen enhancement ratio, applied on the tick
   * a fraction is delivered. Cells that survive the direct hit but are
   * lethally damaged become multinucleated and die at their next division
   * attempt - mitotic catastrophe.
   */
  private applyRadiation(hours: number, dt: number): void {
    const model = this.rules.raw.radiation;
    const schedule = this.rules.raw.treatment?.radiation ?? [];
    if (!model || schedule.length === 0) return;
    const seed = this.rules.raw.seed;
    const oer = model.oxygenEnhancementRatio ?? 1;
    const oHalf = model.oxygenHalfMax ?? 0.1;
    const catastropheFraction = model.mitoticCatastropheFraction ?? 1;

    for (let idx = 0; idx < schedule.length; idx++) {
      const fx = schedule[idx];
      if (!(fx.hour >= hours && fx.hour < hours + dt)) continue;
      const rollChannel = Channel.RadiationRoll * 1000 + idx;
      const pickChannel = Channel.RadiationCatastrophe * 1000 + idx;
      // Iterate backwards: nodes that die are rewritten in place by setState,
      // never removed here, so the list is stable, but keep it defensive.
      for (let s = this.nodeCount - 1; s >= 0; s--) {
        const i = this.nodes[s];
        if (!this.aliveByState[this.state[i]]) continue;
        const o = this.oxygen.value[i];
        const omf = oer - (oer - 1) * michaelis(o, oHalf);
        const dEff = fx.doseGy / omf;
        const survival = Math.exp(-(model.alphaPerGy * dEff + model.betaPerGy2 * dEff * dEff));
        if (uniform(seed, this.tick, i, rollChannel) <= survival) continue;
        if (
          this.sDamaged >= 0 &&
          uniform(seed, this.tick, i, pickChannel) < catastropheFraction
        ) {
          this.setState(i, this.sDamaged, this.cRadiation, NO_DRUG);
          this.writer.emit(
            this.tick,
            EventType.StateChange,
            this.cRadiation,
            this.clone[i],
            i,
            packStateChange(this.sDamaged),
          );
        } else {
          this.beginDeath(i, this.cRadiation, NO_DRUG);
        }
      }
    }
  }

  private beginDeath(node: number, causeId: number, drug: number): void {
    this.setState(node, this.sDying, causeId, drug);
    this.writer.emit(
      this.tick,
      EventType.DeathStart,
      causeId,
      this.clone[node],
      node,
      drug === NO_DRUG ? NO_VALUE : drug,
    );
  }

  /** The per-node evaluation. Everything it decides comes out of the rules. */
  private evaluateNodes(): void {
    const rules = this.rules;
    const raw = rules.raw;
    const ox = raw.oxygen;
    const dt = rules.hoursPerTick;
    const seed = raw.seed;
    const tick = this.tick;
    const drugs = raw.drugs ?? [];
    const immune = raw.immune;
    const immuneSurfaceOnly = immune?.surfaceOnly ?? true;

    // Backwards, because removals swap the tail into the current slot.
    for (let slot = this.nodeCount - 1; slot >= 0; slot--) {
      const i = this.nodes[slot];
      const stateId = this.state[i];

      /* Dying cells are only waiting to be cleared. */
      if (stateId === this.sDying) {
        const causeId = this.cause[i];
        const span = rules.dyingTicksByCause.get(causeId) ?? 0;
        if (tick - this.stateSince[i] >= span) {
          const drug = this.causeDrug[i];
          this.writer.emit(
            tick,
            EventType.Removed,
            causeId,
            this.clone[i],
            i,
            drug === NO_DRUG ? NO_VALUE : drug,
          );
          this.removeCell(i);
        }
        continue;
      }

      const profile = rules.clones[this.clone[i]];
      if (!profile) continue;

      /* --- local situation, read from the matrix --- */
      const o = this.oxygen.value[i];
      const nbrCount = this.grid.neighbors(i, this.nbr);
      let freeCount = 0;
      for (let k = 0; k < nbrCount; k++) {
        const j = this.nbr[k];
        if (!this.occupied[j] || !this.occupiesByState[this.state[j]]) {
          this.freeSlots[freeCount++] = j;
        }
      }

      if (o < ox.necrosisThreshold) {
        if (this.hypoxicTicks[i] < 0xffff) this.hypoxicTicks[i]++;
      } else {
        this.hypoxicTicks[i] = 0;
      }

      /* --- competing death hazards, per hour --- */
      let hazards = 0;
      let total = 0;

      if (profile.baselineDeathPerHour > 0) {
        this.hazard[hazards] = profile.baselineDeathPerHour;
        this.hazardCause[hazards] = this.cBaseline;
        this.hazardDrug[hazards] = NO_DRUG;
        total += profile.baselineDeathPerHour;
        hazards++;
      }

      if (this.cDrugDeath >= 0) {
        for (const d of drugs) {
          const sens = profile.drug[d.id];
          if (!sens || sens.killMaxPerHour <= 0) continue;
          const conc = this.drugFields.get(d.id)!.value[i];
          const h = sens.killMaxPerHour * hill(conc, sens.ic50, sens.hill);
          if (h <= 0) continue;
          this.hazard[hazards] = h;
          this.hazardCause[hazards] = this.cDrugDeath;
          this.hazardDrug[hazards] = d.id;
          total += h;
          hazards++;
        }
      }

      if (this.hypoxicTicks[i] >= ox.necrosisTicks) {
        const h = ox.necrosisHazardPerHour ?? 1;
        this.hazard[hazards] = h;
        this.hazardCause[hazards] = this.cNecrosis;
        this.hazardDrug[hazards] = NO_DRUG;
        total += h;
        hazards++;
      }

      if (this.cImmune >= 0 && immune && immune.killPerHour > 0) {
        const reachable = !immuneSurfaceOnly || freeCount > 0;
        const h = reachable ? immune.killPerHour * profile.immuneVisibility : 0;
        if (h > 0) {
          this.hazard[hazards] = h;
          this.hazardCause[hazards] = this.cImmune;
          this.hazardDrug[hazards] = NO_DRUG;
          total += h;
          hazards++;
        }
      }

      if (total > 0) {
        const pDeath = 1 - Math.exp(-total * dt);
        if (uniform(seed, tick, i, Channel.DeathRoll) < pDeath) {
          /* Which hazard fired: proportional to its share. */
          let r = uniform(seed, tick, i, Channel.DeathPick) * total;
          let pick = hazards - 1;
          for (let k = 0; k < hazards; k++) {
            r -= this.hazard[k];
            if (r <= 0) {
              pick = k;
              break;
            }
          }
          this.beginDeath(i, this.hazardCause[pick], this.hazardDrug[pick]);
          continue;
        }
      }

      /* --- cycle speed: oxygen scales it, drug slows it --- */
      const oxygenFactor = michaelis(o, ox.proliferationHalfMax);
      let slowdown = 0;
      let slowdownDrug = NO_DRUG;
      for (const d of drugs) {
        if (!d.cytostatic) continue;
        const conc = this.drugFields.get(d.id)!.value[i];
        const s = d.cytostatic.maxSlowdown * hill(conc, d.cytostatic.ic50, d.cytostatic.hill);
        if (s > slowdown) {
          slowdown = s;
          slowdownDrug = d.id;
        }
      }
      const speed = oxygenFactor * (1 - slowdown);

      /* --- arrests --- */
      let arrestCause = -1;
      let arrestDrug = NO_DRUG;
      if (o < ox.arrestThreshold) {
        arrestCause = this.cHypoxiaArrest;
      } else if (
        this.cDrugArrest >= 0 &&
        slowdownDrug !== NO_DRUG &&
        slowdown >= (rules.drugById.get(slowdownDrug)?.arrestThreshold ?? Infinity)
      ) {
        arrestCause = this.cDrugArrest;
        arrestDrug = slowdownDrug;
      } else if (freeCount === 0 && this.cycleProgress[i] >= 1) {
        arrestCause = this.cCrowding;
      }

      if (arrestCause >= 0) {
        if (stateId !== this.sArrested || this.cause[i] !== arrestCause || this.causeDrug[i] !== arrestDrug) {
          this.setState(i, this.sArrested, arrestCause, arrestDrug);
          this.writer.emit(
            tick,
            EventType.StateChange,
            arrestCause,
            this.clone[i],
            i,
            packStateChange(this.sArrested, arrestDrug),
          );
        }
        if (arrestCause !== this.cCrowding) continue;
      } else if (stateId === this.sArrested) {
        this.setState(i, this.sCycling, this.cNormal, NO_DRUG);
        this.writer.emit(
          tick,
          EventType.StateChange,
          this.cNormal,
          this.clone[i],
          i,
          packStateChange(this.sCycling),
        );
      }

      /* --- the cycle --- */
      let progress = this.cycleProgress[i] + (dt / profile.cycleHours) * speed;
      if (progress < 1) {
        this.cycleProgress[i] = progress;
        continue;
      }

      /* A radiation-damaged cell dies when it tries to divide. */
      if (this.sDamaged >= 0 && this.state[i] === this.sDamaged) {
        this.cycleProgress[i] = 1;
        this.beginDeath(i, this.cRadiation, NO_DRUG);
        continue;
      }

      if (freeCount === 0) {
        this.cycleProgress[i] = 1;
        continue;
      }

      /* --- divide --- */
      const target = this.freeSlots[uniformInt(seed, tick, i, Channel.DaughterPick, freeCount)];
      if (this.occupied[target]) {
        // A non-occupying node (debris) is cleared to make room.
        this.writer.emit(
          tick,
          EventType.Removed,
          this.cause[target],
          this.clone[target],
          target,
          NO_VALUE,
        );
        this.removeCell(target);
      }

      progress -= 1;
      this.cycleProgress[i] = progress;
      const parentClone = this.clone[i];
      const jitter = uniform(seed, tick, i, Channel.DivideJitter) * 0.15;
      this.placeCell(target, parentClone, jitter);
      this.writer.emit(tick, EventType.Divide, this.cNormal, parentClone, i, target);

      /* --- mutation, rolled at division --- */
      const edges = rules.mutationsByClone.get(parentClone);
      if (edges && edges.length) {
        let totalRate = 0;
        for (const e of edges) totalRate += e.ratePerDivision;
        if (totalRate > 0 && uniform(seed, tick, i, Channel.MutationRoll) < totalRate) {
          let r = uniform(seed, tick, i, Channel.MutationPick) * totalRate;
          let chosen = edges[edges.length - 1];
          for (const e of edges) {
            r -= e.ratePerDivision;
            if (r <= 0) {
              chosen = e;
              break;
            }
          }
          this.clone[target] = chosen.toClone;
          this.writer.emit(
            tick,
            EventType.Mutate,
            this.cMutation,
            parentClone,
            target,
            chosen.toClone,
          );
        }
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Read-out
   * ---------------------------------------------------------------- */

  snapshot(): Keyframe {
    const nodes: KeyframeNode[] = new Array(this.nodeCount);
    for (let s = 0; s < this.nodeCount; s++) {
      const i = this.nodes[s];
      nodes[s] = {
        node: i,
        clone: this.clone[i],
        state: this.state[i],
        cause: this.cause[i],
      };
    }
    return {
      tick: this.tick,
      grid: { nx: this.grid.nx, ny: this.grid.ny, nz: this.grid.nz },
      nodes,
    };
  }

  stats(): SimStats {
    const byClone = new Map<number, number>();
    const byState = new Map<number, number>();
    let living = 0;
    let dying = 0;
    for (let s = 0; s < this.nodeCount; s++) {
      const i = this.nodes[s];
      const st = this.state[i];
      byState.set(st, (byState.get(st) ?? 0) + 1);
      if (this.aliveByState[st]) {
        living++;
        byClone.set(this.clone[i], (byClone.get(this.clone[i]) ?? 0) + 1);
      } else {
        dying++;
      }
    }
    const plasma = new Map<number, number>();
    for (const [id, pk] of this.pk) plasma.set(id, pk.plasma);
    return { tick: this.tick, hours: this.tick * this.rules.hoursPerTick, living, dying, byClone, byState, plasma };
  }

  /**
   * What the UI shows in the hover card beneath the state and cause. These are
   * simulator read-outs, already labelled; the UI prints them without
   * interpreting them, so no threshold leaks into the renderer.
   */
  probe(node: number): ProbeReading[] {
    if (!this.occupied[node]) return [];
    const out: ProbeReading[] = [
      { label: 'Local oxygen', value: this.oxygen.value[node], format: 'fraction' },
    ];
    for (const d of this.rules.raw.drugs ?? []) {
      const f = this.drugFields.get(d.id);
      if (!f) continue;
      out.push({ label: d.displayName ?? d.name, value: f.value[node], format: 'number' });
    }
    out.push({
      label: 'Cycle progress',
      value: this.cycleProgress[node],
      format: 'fraction',
    });
    out.push({
      label: 'Ticks in state',
      value: this.tick - this.stateSince[node],
      format: 'number',
    });
    return out;
  }

  /** Field read-out for the slice/field overlays. */
  field(name: 'oxygen' | `drug:${number}`): Float32Array | undefined {
    if (name === 'oxygen') return this.oxygen.value;
    const id = Number(name.slice(5));
    return this.drugFields.get(id)?.value;
  }

  get livingCount(): number {
    return this.nodeCount;
  }
}

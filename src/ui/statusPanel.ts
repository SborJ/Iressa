import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { FrameStats } from '../render/viewer.js';
import type { SimulationSource } from '../source/types.js';
import type { World } from '../world/world.js';
import { chip, el } from './dom.js';
import { cloneName, formatDuration } from './labels.js';

export interface WorldCounts {
  living: number;
  dying: number;
  byClone: Map<number, number>;
}

/** Counted off the world, so it works for any source. */
export function countWorld(world: World, rules: ResolvedRules): WorldCounts {
  const alive = new Uint8Array(256);
  for (const s of rules.raw.states) alive[s.id] = (s.alive ?? true) ? 1 : 0;
  const byClone = new Map<number, number>();
  let living = 0;
  let dying = 0;
  for (let s = 0; s < world.count; s++) {
    if (alive[world.state[s]]) {
      living++;
      const c = world.clone[s];
      byClone.set(c, (byClone.get(c) ?? 0) + 1);
    } else {
      dying++;
    }
  }
  return { living, dying, byClone };
}

export class StatusPanel {
  private body = el('div');

  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
    sourceKind: string,
  ) {
    this.root.replaceChildren(
      el('p', { class: 'title', text: 'Iressa' }),
      el('p', {
        class: 'subtitle',
        text: `${rules.raw.grid.nx}×${rules.raw.grid.ny}×${rules.raw.grid.nz} voxels at ${rules.raw.grid.voxelMicrons} µm · ${sourceKind} source`,
      }),
      this.body,
    );
  }

  update(world: World, source: SimulationSource, frame?: FrameStats): void {
    const counts = countWorld(world, this.rules);
    const hours = world.tick * this.rules.hoursPerTick;
    const frag = document.createDocumentFragment();

    const dl = el('dl');
    const row = (label: string, value: string) =>
      el('div', { class: 'readout' }, [el('dt', { text: label }), el('dd', { text: value })]);
    dl.append(
      row('Time', formatDuration(hours)),
      row('Tick', `${world.tick} / ${this.rules.maxTicks}`),
      row('Living cells', counts.living.toLocaleString()),
      row('Dying cells', counts.dying.toLocaleString()),
    );

    const stats = source.stats?.();
    if (stats) {
      for (const [drugId, conc] of stats.plasma) {
        const drug = this.rules.drugById.get(drugId);
        dl.append(row(`${drug?.name ?? `drug ${drugId}`} plasma`, conc.toFixed(2)));
      }
    }
    frag.append(dl, el('div', { class: 'rule' }), el('h2', { text: 'Clones' }));

    const ordered = this.rules.raw.clones.map((c) => c.id);
    for (const id of ordered) {
      const n = counts.byClone.get(id) ?? 0;
      frag.append(
        el('div', { class: 'legend-row' }, [
          chip(this.visuals.cloneCss(id)),
          el('span', { class: 'name', text: cloneName(this.rules, id) }),
          el('span', { class: 'num', text: n.toLocaleString() }),
        ]),
      );
    }

    if (frame) {
      const fps = frame.frameMs > 0 ? 1000 / frame.frameMs : 0;
      frag.append(
        el('div', { class: 'rule' }),
        el('h2', { text: 'Render' }),
        el('dl', {}, [
          row('Frame', `${frame.frameMs.toFixed(1)} ms · ${fps.toFixed(0)} fps`),
          row('CPU', `${frame.cpuMs.toFixed(2)} ms`),
          row('Cells drawn', frame.cells.toLocaleString()),
          row('Triangles', `${(frame.triangles / 1000).toFixed(0)}k`),
          row('Draw calls', String(frame.drawCalls)),
          row('Red cells', frame.redCells.toLocaleString()),
        ]),
      );
    }
    this.body.replaceChildren(frag);
  }
}

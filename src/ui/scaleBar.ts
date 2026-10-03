import { el } from './dom.js';

/** Round lengths a microscope scale bar is allowed to take, in micrometres. */
const STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

/**
 * The scale bar.
 *
 * Its length is computed from the voxel size and the camera, never placed by
 * hand: the bar is whatever round number of micrometres comes closest to a
 * comfortable on-screen width at the current zoom.
 */
export class ScaleBar {
  private bar = el('div');
  private label = el('span');
  private lastText = '';

  constructor(private root: HTMLElement, private voxelMicrons: number) {
    this.bar.style.cssText =
      'height:3px;background:currentColor;border-radius:1px;opacity:0.85';
    this.label.style.cssText = 'font-family:var(--mono);font-size:11px;white-space:nowrap';
    this.root.append(el('div', { class: 'scalebar' }, [this.bar, this.label]));
  }

  update(worldPerPixel: number): void {
    const micronsPerPixel = worldPerPixel * this.voxelMicrons;
    const targetPx = 110;
    const wanted = micronsPerPixel * targetPx;
    let best = STEPS[0];
    for (const s of STEPS) {
      if (Math.abs(Math.log(s / wanted)) < Math.abs(Math.log(best / wanted))) best = s;
    }
    const px = best / micronsPerPixel;
    const text = best >= 1000 ? `${best / 1000} mm` : `${best} µm`;
    this.bar.style.width = `${Math.round(px)}px`;
    if (text !== this.lastText) {
      this.label.textContent = text;
      this.lastText = text;
    }
  }
}

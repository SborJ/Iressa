import { el } from './dom.js';

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  value: number;
  label: string;
  /** Marks drawn under the track, in value space. */
  ticks?: number[];
  /** How the current value reads out beside the label. */
  format?: (v: number) => string;
  onInput(value: number): void;
}

/**
 * A slider.
 *
 * Built rather than styled: a native range input exposes its track and thumb
 * only through vendor pseudo-elements, which cannot carry a fill, a hover ring,
 * a press state or tick marks together, and behave differently in every engine.
 * This keeps the native keyboard contract - arrows step, shift steps larger,
 * home and end jump to the ends - and the ARIA role, and adds the states the
 * rest of the interface has.
 */
export class Slider {
  readonly node: HTMLElement;
  private track = el('div', { class: 'sl-track' });
  private fill = el('div', { class: 'sl-fill' });
  private thumb = el('div', { class: 'sl-thumb' });
  private readout = el('span', { class: 'sl-value' });
  private ticks = el('div', { class: 'sl-ticks' });
  private value: number;
  private dragging = false;

  constructor(private o: SliderOptions) {
    this.value = o.value;

    for (const t of o.ticks ?? []) {
      const mark = el('i');
      mark.style.left = `${this.fraction(t) * 100}%`;
      this.ticks.append(mark);
    }

    this.track.append(this.fill, this.ticks, this.thumb);
    this.node = el('div', { class: 'sl' }, [
      el('div', { class: 'sl-head' }, [
        el('span', { class: 'sl-label', text: o.label }),
        this.readout,
      ]),
      this.track,
    ]);

    this.track.tabIndex = 0;
    this.track.setAttribute('role', 'slider');
    this.track.setAttribute('aria-label', o.label);
    this.track.setAttribute('aria-valuemin', String(o.min));
    this.track.setAttribute('aria-valuemax', String(o.max));

    this.track.addEventListener('pointerdown', (ev) => this.onDown(ev));
    this.track.addEventListener('keydown', (ev) => this.onKey(ev));
    this.sync(false);
  }

  private fraction(v: number): number {
    return (v - this.o.min) / (this.o.max - this.o.min || 1);
  }

  private quantise(v: number): number {
    const steps = Math.round((v - this.o.min) / this.o.step);
    const snapped = this.o.min + steps * this.o.step;
    return Math.min(this.o.max, Math.max(this.o.min, Number(snapped.toFixed(6))));
  }

  private fromPointer(clientX: number): number {
    const r = this.track.getBoundingClientRect();
    const f = (clientX - r.left) / (r.width || 1);
    return this.quantise(this.o.min + f * (this.o.max - this.o.min));
  }

  private onDown(ev: PointerEvent): void {
    ev.preventDefault();
    this.track.setPointerCapture(ev.pointerId);
    this.dragging = true;
    this.node.classList.add('dragging');
    this.set(this.fromPointer(ev.clientX));

    const move = (e: PointerEvent) => {
      if (this.dragging) this.set(this.fromPointer(e.clientX));
    };
    const up = (e: PointerEvent) => {
      this.dragging = false;
      this.node.classList.remove('dragging');
      this.track.releasePointerCapture(e.pointerId);
      this.track.removeEventListener('pointermove', move);
      this.track.removeEventListener('pointerup', up);
      this.track.removeEventListener('pointercancel', up);
    };
    this.track.addEventListener('pointermove', move);
    this.track.addEventListener('pointerup', up);
    this.track.addEventListener('pointercancel', up);
  }

  private onKey(ev: KeyboardEvent): void {
    const big = this.o.step * 5;
    const map: Record<string, number> = {
      ArrowRight: ev.shiftKey ? big : this.o.step,
      ArrowUp: ev.shiftKey ? big : this.o.step,
      ArrowLeft: -(ev.shiftKey ? big : this.o.step),
      ArrowDown: -(ev.shiftKey ? big : this.o.step),
      PageUp: big,
      PageDown: -big,
    };
    if (ev.key in map) {
      ev.preventDefault();
      this.set(this.quantise(this.value + map[ev.key]));
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      this.set(this.o.min);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      this.set(this.o.max);
    }
  }

  private set(v: number): void {
    if (v === this.value) return;
    this.value = v;
    this.sync(true);
  }

  /** Move the slider without calling back, for state set from elsewhere. */
  setValue(v: number): void {
    this.value = this.quantise(v);
    this.sync(false);
  }

  setDisabled(disabled: boolean): void {
    this.node.classList.toggle('disabled', disabled);
    this.track.tabIndex = disabled ? -1 : 0;
  }

  private sync(emit: boolean): void {
    const f = this.fraction(this.value);
    this.fill.style.width = `${f * 100}%`;
    this.thumb.style.left = `${f * 100}%`;
    this.readout.textContent = this.o.format ? this.o.format(this.value) : String(this.value);
    this.track.setAttribute('aria-valuenow', String(this.value));
    this.track.setAttribute('aria-valuetext', this.readout.textContent ?? '');
    if (emit) this.o.onInput(this.value);
  }
}

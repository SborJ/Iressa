import { el } from './dom.js';

/**
 * A number you type or step.
 *
 * A slider is wrong for a value someone wants to set exactly - "60 days", "a
 * dose of 0.9" - so these keep a real text field, and add the stepper and the
 * states the rest of the interface has.
 */
export class NumberField {
  readonly node: HTMLElement;
  private input: HTMLInputElement;

  constructor(
    private o: {
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
      unit?: string;
      title?: string;
      onInput(value: number): void;
    },
  ) {
    this.input = el('input', {
      type: 'number',
      min: String(o.min),
      max: String(o.max),
      step: String(o.step),
      value: String(o.value),
      'aria-label': o.label,
      // A number input renders its value in the page locale; without this a
      // dose of 0.9 shows as "0,9" in much of Europe.
      lang: 'en',
      inputmode: 'decimal',
    }) as HTMLInputElement;

    this.input.addEventListener('input', () => {
      const v = Number(this.input.value);
      if (Number.isFinite(v)) o.onInput(this.clamp(v));
    });
    // Only correct the text once the field is left, so it can be cleared to type.
    this.input.addEventListener('blur', () => {
      const v = this.clamp(Number(this.input.value));
      this.input.value = String(Number.isFinite(v) ? v : o.value);
      o.onInput(Number(this.input.value));
    });

    const wrap = el('div', { class: 'nf-input' }, [this.input]);
    if (o.unit) wrap.append(el('span', { class: 'nf-unit', text: o.unit }));

    this.node = el('label', { class: 'nf', title: o.title ?? '' }, [
      el('span', { class: 'nf-label', text: o.label }),
      wrap,
    ]);
  }

  private clamp(v: number): number {
    return Math.max(this.o.min, Math.min(this.o.max, v));
  }

  setValue(v: number): void {
    this.input.value = String(this.clamp(v));
  }

  get value(): number {
    return this.clamp(Number(this.input.value));
  }
}

/** A labelled group of segmented buttons, each with its own explanation. */
export class Choice<T extends string> {
  readonly node: HTMLElement;
  private buttons = new Map<T, HTMLButtonElement>();
  private value: T;

  constructor(
    label: string,
    options: { value: T; label: string; title?: string }[],
    value: T,
    private onPick: (value: T) => void,
    opts: { wrap?: boolean } = {},
  ) {
    this.value = value;
    const row = el('div', { class: `seg full${opts.wrap ? ' wrap' : ''}` });
    for (const o of options) {
      const b = el('button', { type: 'button', text: o.label, title: o.title ?? '' });
      b.addEventListener('click', () => this.set(o.value));
      this.buttons.set(o.value, b);
      row.append(b);
    }
    this.node = el('div', { class: 'choice' }, [
      el('div', { class: 'muted', style: 'margin-bottom:var(--s2)', text: label }),
      row,
    ]);
    this.sync();
  }

  set(value: T, silent = false): void {
    this.value = value;
    this.sync();
    if (!silent) this.onPick(value);
  }

  get current(): T {
    return this.value;
  }

  private sync(): void {
    for (const [v, b] of this.buttons) b.setAttribute('aria-pressed', String(v === this.value));
  }
}

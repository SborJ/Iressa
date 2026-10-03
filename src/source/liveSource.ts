import { EVENT_SIZE } from '../format/events.js';
import { KEYFRAME_HEADER_SIZE, KEYFRAME_MAGIC } from '../format/keyframes.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { MetricsRow } from '../ui/runMetrics.js';
import type { SimulationSource, TickPacket } from './types.js';

/**
 * A live, two-way session with the Python engine (scripts/serve_live.py).
 *
 * The server speaks the recorded-run stream (event-record frames and keyframes)
 * plus JSON control frames. This source is a *pull* source: the viewer's clock
 * asks for ticks, and when the buffered day runs out one more simulated day is
 * requested, so Play, Pause, Step and the speed slider all work as they do on a
 * recording while the engine computes only as far as the viewer has watched.
 *
 * Treatment is set here and applied from the next simulated day; in AI mode the
 * server's policy chooses instead.
 */

export interface LiveDrug {
  id: string;
  label: string;
  exposure: 'diffusing' | 'global';
  mechanism: string;
}

export interface LivePreset {
  id: string;
  label: string;
  exposures: Record<string, number>;
}

export interface LiveHello {
  type: 'hello';
  cancer: { id: string; name: string };
  drugs: LiveDrug[];
  presets: LivePreset[];
  policy: string | null;
  auto: boolean;
  exposures: Record<string, number>;
  days: number;
  ticks_per_day: number;
  rules: unknown;
}

export interface LiveReading extends MetricsRow {
  label?: string;
  auto?: boolean;
}

export interface LiveStartRequest {
  cancer: string;
  size?: number;
  depth?: number;
  cells?: number;
  days?: number;
  seed?: number;
  mutation_scale?: number;
  tick_minutes?: number;
  randomize?: boolean;
  eci_min?: number;
  auto?: boolean;
}

type Control = { type: 'day'; reading: LiveReading | null; done: boolean }
  | { type: 'treatment'; exposures: Record<string, number>; auto: boolean }
  | { type: 'error'; message: string }
  | LiveHello;

export class LiveSource implements SimulationSource {
  readonly kind = 'live' as const;
  rules!: ResolvedRules;
  hello!: LiveHello;
  private ws: WebSocket | undefined;
  private listeners = new Set<(p: TickPacket) => void>();
  private readingListeners = new Set<(r: LiveReading) => void>();
  private treatmentListeners = new Set<(exposures: Record<string, number>, auto: boolean) => void>();
  private errorListeners = new Set<(message: string) => void>();
  private buffer: TickPacket[] = [];
  private lastTick = 0;
  private finished = false;
  private awaitingDay = false;
  private dayPending: ((done: boolean) => void) | undefined;
  private resolveHello: ((h: LiveHello) => void) | undefined;
  private rejectHello: ((e: Error) => void) | undefined;
  private resetting: (() => void) | undefined;
  constructor(private url: string) {}

  /** Opens the socket, starts a session and resolves with the server's hello (which carries the rules). */
  open(request: LiveStartRequest): Promise<LiveHello> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.resolveHello = resolve;
      this.rejectHello = reject;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'start', ...request }));
      ws.onerror = () => reject(new Error(`cannot reach the live simulator at ${this.url}`));
      ws.onclose = () => {
        this.finished = true;
        this.dayPending?.(true);
        this.dayPending = undefined;
        this.rejectHello?.(new Error('the live simulator closed the connection'));
      };
      ws.onmessage = (ev) => this.handleFrame(ev.data);
    });
  }

  bind(rules: ResolvedRules): void {
    this.rules = rules;
  }

  /** Decodes one frame; separate from the socket so the protocol can be tested without one. */
  handleFrame(data: unknown): void {
    if (typeof data === 'string') {
      let msg: Control;
      try {
        msg = JSON.parse(data) as Control;
      } catch {
        console.warn('iressa live: control frame is not JSON', data);
        return;
      }
      if (msg.type === 'hello') {
        this.hello = msg;
        this.finished = false;
        const resolve = this.resolveHello;
        this.resolveHello = this.rejectHello = undefined;
        resolve?.(msg);
        this.resetting?.();
        this.resetting = undefined;
        return;
      }
      if (msg.type === 'day') {
        this.awaitingDay = false;
        if (msg.reading) for (const cb of this.readingListeners) cb(msg.reading);
        if (msg.done) this.finished = true;
        this.dayPending?.(msg.done);
        this.dayPending = undefined;
        return;
      }
      if (msg.type === 'treatment') {
        for (const cb of this.treatmentListeners) cb(msg.exposures, msg.auto);
        return;
      }
      if (msg.type === 'error') {
        console.warn('iressa live:', msg.message);
        for (const cb of this.errorListeners) cb(msg.message);
        this.awaitingDay = false;
        return;
      }
      return;
    }
    const buffer = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer : undefined;
    if (!buffer) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength >= KEYFRAME_HEADER_SIZE && view.getUint32(0, true) === KEYFRAME_MAGIC) {
      const tick = view.getUint32(4, true);
      const packet = { tick, events: new Uint8Array(0), keyframe: bytes, done: false };
      // the opening keyframe establishes the population at once; later ones queue behind their day's events
      if (this.buffer.length === 0 && this.lastTick === 0 && tick <= 1) this.emit(packet);
      else this.buffer.push(packet);
      return;
    }
    if (bytes.byteLength === 0 || bytes.byteLength % EVENT_SIZE !== 0) {
      console.warn(`iressa live: dropped a ${bytes.byteLength}-byte frame`);
      return;
    }
    this.buffer.push({ tick: view.getUint32(0, true), events: bytes, done: false });
  }

  private emit(p: TickPacket): void {
    this.lastTick = Math.max(this.lastTick, p.tick);
    for (const cb of this.listeners) cb(p);
  }

  get tick(): number { return this.lastTick; }
  get done(): boolean { return this.finished && this.buffer.length === 0; }

  onPacket(cb: (p: TickPacket) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onReading(cb: (r: LiveReading) => void): () => void {
    this.readingListeners.add(cb);
    return () => this.readingListeners.delete(cb);
  }

  onTreatment(cb: (exposures: Record<string, number>, auto: boolean) => void): () => void {
    this.treatmentListeners.add(cb);
    return () => this.treatmentListeners.delete(cb);
  }

  onError(cb: (message: string) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  /**
   * Plays up to ``n`` buffered packets. When the buffer is empty the next day is
   * requested from the server (once), and nothing is emitted until it arrives.
   */
  pump(n: number): void {
    let left = Math.max(1, n);
    while (left > 0 && this.buffer.length) {
      this.emit(this.buffer.shift()!);
      left--;
    }
    if (this.buffer.length === 0 && !this.finished) this.requestDay();
  }

  /** True while the engine is computing the next day. */
  get computing(): boolean { return this.awaitingDay; }

  private requestDay(): void {
    if (this.awaitingDay || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.awaitingDay = true;
    this.ws.send(JSON.stringify({ type: 'advance' }));
  }

  setExposures(exposures: Record<string, number>): void {
    this.ws?.send(JSON.stringify({ type: 'set_exposures', exposures }));
  }

  setAuto(auto: boolean): void {
    this.ws?.send(JSON.stringify({ type: 'auto', auto }));
  }

  /** A fresh session with the same request; the opening keyframe follows the new hello. */
  reset(): void {
    this.buffer = [];
    this.lastTick = 0;
    this.finished = false;
    this.awaitingDay = false;
    this.dayPending = undefined;
    this.ws?.send(JSON.stringify({ type: 'reset' }));
  }

  dispose(): void {
    this.ws?.close();
  }
}

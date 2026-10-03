import { EVENT_SIZE } from '../format/events.js';
import { KEYFRAME_HEADER_SIZE, KEYFRAME_MAGIC } from '../format/keyframes.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { SimulationSource, TickPacket } from './types.js';

/**
 * The same 16-byte records, streamed.
 *
 * The server sends binary frames. A frame beginning with the keyframe magic is
 * a keyframe; anything else is a whole number of event records, which must all
 * carry the same tick. That is the entire protocol - the Python simulation can
 * speak it by writing the records it already writes to a file.
 *
 * A text frame is accepted as a JSON control message: {"done": true}.
 */
export class SocketSource implements SimulationSource {
  readonly kind = 'socket' as const;
  private ws: WebSocket | undefined;
  private listeners = new Set<(p: TickPacket) => void>();
  private lastTick = 0;
  private finished = false;

  constructor(readonly rules: ResolvedRules, private url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`cannot reach ${this.url}`));
      ws.onclose = () => {
        this.finished = true;
      };
      ws.onmessage = (ev) => this.handleFrame(ev.data);
    });
  }

  /**
   * Decodes one frame. Separate from the socket so the protocol can be
   * exercised without one.
   */
  handleFrame(data: unknown): void {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data) as { done?: boolean };
        if (msg.done) this.finished = true;
      } catch {
        console.warn('iressa: control frame is not JSON', data);
      }
      return;
    }
    const buffer =
      data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer : undefined;
    if (!buffer) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.byteLength >= KEYFRAME_HEADER_SIZE && view.getUint32(0, true) === KEYFRAME_MAGIC) {
      this.lastTick = view.getUint32(4, true);
      this.emit({ tick: this.lastTick, events: new Uint8Array(0), keyframe: bytes, done: false });
      return;
    }

    if (bytes.byteLength === 0 || bytes.byteLength % EVENT_SIZE !== 0) {
      console.warn(`iressa: dropped a ${bytes.byteLength}-byte frame that is neither a keyframe nor whole event records`);
      return;
    }
    this.lastTick = view.getUint32(0, true);
    this.emit({ tick: this.lastTick, events: bytes, done: false });
  }

  private emit(p: TickPacket): void {
    for (const cb of this.listeners) cb(p);
  }

  get tick(): number {
    return this.lastTick;
  }

  get done(): boolean {
    return this.finished;
  }

  onPacket(cb: (p: TickPacket) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** A push source. The server sets the pace. */
  pump(): void {}

  dispose(): void {
    this.ws?.close();
  }
}

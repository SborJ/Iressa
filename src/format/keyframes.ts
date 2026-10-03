/**
 * Keyframes: a full snapshot of the matrix, so a viewer can seek without
 * replaying every event from tick 0.
 *
 * Header (little-endian):
 *   0   4  magic 'IKF1'
 *   4   4  tick            u32
 *   8   4  node count      u32
 *   12  4  grid nx         u32
 *   16  4  grid ny         u32
 *   20  4  grid nz         u32
 *   24  8  reserved
 * Then, per node: node u32, clone u16, state u8, cause u8   (8 bytes)
 */

export const KEYFRAME_MAGIC = 0x314b4649; // 'IKF1' little-endian
export const KEYFRAME_HEADER_SIZE = 32;
export const KEYFRAME_NODE_SIZE = 8;

export interface KeyframeNode {
  node: number;
  clone: number;
  state: number;
  cause: number;
}

export interface Keyframe {
  tick: number;
  grid: { nx: number; ny: number; nz: number };
  nodes: KeyframeNode[];
}

export function encodeKeyframe(kf: Keyframe): Uint8Array {
  const bytes = new Uint8Array(KEYFRAME_HEADER_SIZE + kf.nodes.length * KEYFRAME_NODE_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, KEYFRAME_MAGIC, true);
  view.setUint32(4, kf.tick, true);
  view.setUint32(8, kf.nodes.length, true);
  view.setUint32(12, kf.grid.nx, true);
  view.setUint32(16, kf.grid.ny, true);
  view.setUint32(20, kf.grid.nz, true);
  let o = KEYFRAME_HEADER_SIZE;
  for (const n of kf.nodes) {
    view.setUint32(o, n.node, true);
    view.setUint16(o + 4, n.clone, true);
    view.setUint8(o + 6, n.state);
    view.setUint8(o + 7, n.cause);
    o += KEYFRAME_NODE_SIZE;
  }
  return bytes;
}

export function decodeKeyframe(bytes: ArrayBuffer | Uint8Array): Keyframe {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== KEYFRAME_MAGIC) {
    throw new Error(`not a keyframe: magic 0x${magic.toString(16)}`);
  }
  const tick = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const grid = {
    nx: view.getUint32(12, true),
    ny: view.getUint32(16, true),
    nz: view.getUint32(20, true),
  };
  const nodes: KeyframeNode[] = new Array(count);
  let o = KEYFRAME_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    nodes[i] = {
      node: view.getUint32(o, true),
      clone: view.getUint16(o + 4, true),
      state: view.getUint8(o + 6),
      cause: view.getUint8(o + 7),
    };
    o += KEYFRAME_NODE_SIZE;
  }
  return { tick, grid, nodes };
}

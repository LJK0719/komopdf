export const FRAME_HEADER_BYTES = 16;
export const FRAME_PAYLOAD_LIMIT = 1024 * 1024;
export type FrameHeader = { type: 'control' | 'binary'; length: number; sequence: number };

/** Native IPC: PDFE | uint16 version | uint16 type | uint32 length | uint32 sequence，均小端。 */
export function decodeFrameHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < FRAME_HEADER_BYTES || bytes[0] !== 80 || bytes[1] !== 68 || bytes[2] !== 70 || bytes[3] !== 69) throw new Error('Invalid worker frame header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER_BYTES);
  const version = view.getUint16(4, true);
  const type = view.getUint16(6, true);
  const length = view.getUint32(8, true);
  if (version !== 1 || (type !== 1 && type !== 2) || length > FRAME_PAYLOAD_LIMIT) throw new Error('Invalid worker protocol, type, or frame length');
  return { type: type === 1 ? 'control' : 'binary', length, sequence: view.getUint32(12, true) };
}
export function encodeFrameHeader(header: FrameHeader): Uint8Array {
  if (!Number.isInteger(header.length) || header.length < 0 || header.length > FRAME_PAYLOAD_LIMIT ||
      !Number.isInteger(header.sequence) || header.sequence < 0 || header.sequence > 0xffffffff ||
      (header.type !== 'control' && header.type !== 'binary')) throw new Error('Invalid worker frame arguments');
  const bytes = new Uint8Array(FRAME_HEADER_BYTES);
  bytes.set([80, 68, 70, 69]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, header.type === 'control' ? 1 : 2, true);
  view.setUint32(8, header.length, true);
  view.setUint32(12, header.sequence, true);
  return bytes;
}

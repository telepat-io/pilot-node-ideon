/**
 * dxframe.ts — encode/decode dataexchange frames (peer <-> peer, port 1001).
 *
 * Wire format mirrors org/dataexchange/dataexchange.go exactly:
 *   header  = [4B type BE][4B len BE]
 *   payload = raw bytes; for TypeFile the payload is
 *             [2B nameLen BE][name][data]   (computed BEFORE the length).
 *
 * cite: org/dataexchange/dataexchange.go:64-93 (Frame, WriteFrame, ReadFrame)
 * cite: org/dataexchange/dataexchange.go:73-83  (TypeFile name prefix)
 * cite: org/sdk-node/src/client.ts:481-489,534-536 (sendMessage / sendFile framing)
 */

import { DxType } from './types.js';
import type { DxFrame } from './types.js';

/** 256 MiB cap. cite: org/dataexchange/dataexchange.go:62 (MaxFrameSize = 1<<28). */
export const DX_MAX_FRAME_SIZE = 1 << 28;
/** cite: org/dataexchange/dataexchange.go:58 (maxFilenameLen = 255). */
const MAX_FILENAME_LEN = 255;

/**
 * Build a FILE payload: [2B nameLen BE][name][data].
 * cite: org/dataexchange/dataexchange.go:76-83.
 */
export function encodeFilePayload(filename: string, data: Buffer): Buffer {
  const name = Buffer.from(filename, 'utf-8');
  if (name.length > MAX_FILENAME_LEN) {
    throw new Error(`dxframe: filename too long: ${name.length} bytes (max ${MAX_FILENAME_LEN})`);
  }
  const out = Buffer.alloc(2 + name.length + data.length);
  out.writeUInt16BE(name.length, 0);
  name.copy(out, 2);
  data.copy(out, 2 + name.length);
  return out;
}

/**
 * Build [4B type BE][4B len BE][payload].
 *
 * For DxType.FILE the caller MUST pass a payload already produced by
 * encodeFilePayload (mirrors how Go's WriteFrame pre-rewrites the payload
 * before measuring its length). cite: org/dataexchange/dataexchange.go:85-92.
 */
export function encodeFrame(type: DxType, payload: Buffer): Buffer {
  if (payload.length > DX_MAX_FRAME_SIZE) {
    throw new Error(`dxframe: payload too large: ${payload.length} (max ${DX_MAX_FRAME_SIZE})`);
  }
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(type >>> 0, 0);
  hdr.writeUInt32BE(payload.length, 4);
  return Buffer.concat([hdr, payload], 8 + payload.length);
}

/**
 * Parse one frame from a buffer that begins with the 8-byte header.
 * Returns the frame plus the number of bytes consumed (8 + len). The caller
 * must guarantee the full frame is present; if not, throws (use a length-prefix
 * reader / readExactly upstream). For FILE frames the [2B nameLen][name] prefix
 * is stripped and surfaced as `frame.filename`.
 *
 * cite: org/dataexchange/dataexchange.go:96-140 (ReadFrame + FILE strip/validate).
 */
export function decodeFrame(buf: Buffer): { frame: DxFrame; bytesRead: number } {
  if (buf.length < 8) {
    throw new Error(`dxframe: short header: have ${buf.length} bytes, need 8`);
  }
  const type = buf.readUInt32BE(0) as DxType;
  const len = buf.readUInt32BE(4);
  if (len > DX_MAX_FRAME_SIZE) {
    throw new Error(`dxframe: frame too large: ${len} (max ${DX_MAX_FRAME_SIZE})`);
  }
  if (buf.length < 8 + len) {
    throw new Error(`dxframe: truncated frame: have ${buf.length - 8} body bytes, need ${len}`);
  }
  let payload = buf.subarray(8, 8 + len);
  let filename: string | undefined;

  if (type === DxType.FILE && payload.length >= 2) {
    const nameLen = payload.readUInt16BE(0);
    if (2 + nameLen <= payload.length) {
      if (nameLen > MAX_FILENAME_LEN) {
        throw new Error(`dxframe: filename too long: ${nameLen} bytes (max ${MAX_FILENAME_LEN})`);
      }
      const nameBytes = payload.subarray(2, 2 + nameLen);
      const name = nameBytes.toString('utf-8');
      // round-trip check approximates Go's utf8.Valid guard.
      if (Buffer.from(name, 'utf-8').length !== nameBytes.length) {
        throw new Error('dxframe: filename contains invalid UTF-8');
      }
      if (/[/\\]/.test(name)) {
        throw new Error('dxframe: invalid filename: path traversal characters not allowed');
      }
      if (name !== '') {
        const base = baseName(name);
        if (base === '.' || base === '..') {
          throw new Error(`dxframe: invalid filename: path traversal name ${base} not allowed`);
        }
        filename = base;
      }
      payload = payload.subarray(2 + nameLen);
    }
  }

  // Copy out of the source buffer so callers own an independent Buffer.
  const frame: DxFrame = { type, payload: Buffer.from(payload) };
  if (filename !== undefined) frame.filename = filename;
  return { frame, bytesRead: 8 + len };
}

/** filepath.Base equivalent for the already-traversal-checked name. */
function baseName(name: string): string {
  const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return i >= 0 ? name.slice(i + 1) : name;
}

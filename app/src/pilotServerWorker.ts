/**
 * pilotServerWorker.ts — the blocking-IO half of pilotServer.ts.
 *
 * Runs on a worker thread because sdk-node's Driver.listen/accept and
 * Conn.read/write are SYNCHRONOUS FFI calls that block the calling thread
 * (cite: org/sdk-node/src/client.ts:78-115,158-173,328-333). Keeping them off
 * the main thread lets the wrapper's async wallet/Ideon work proceed.
 *
 * Per accepted conn: read the 8-byte dataexchange header [4B type BE][4B len BE],
 * read the body, post the JSON payload to the main thread, BLOCK on
 * Atomics.wait until the main thread posts the encoded reply frame back, then
 * write it.
 */

import { parentPort, workerData, receiveMessageOnPort } from 'node:worker_threads';
import { Driver } from 'pilotprotocol';
import type { Listener } from 'pilotprotocol';
import { decodeFrame } from './dxframe.js';
import { DxType } from './types.js';

interface WorkerData {
  daemonSocketPath: string;
  port: number;
}

interface ConnLike {
  read(size?: number): Buffer;
  write(data: Buffer | Uint8Array | string): number;
  close(): void;
}

const port = parentPort;
if (!port) {
  throw new Error('pilotServerWorker: must run as a worker thread');
}

const { daemonSocketPath, port: capPort } = workerData as WorkerData;

// We must NOT attach a 'message' listener: doing so makes Node auto-drain the
// port's queue to the listener, which would race receiveMessageOnPort(). Instead
// we poll the port synchronously with receiveMessageOnPort and use a timed
// Atomics.wait on a private latch purely as a cooperative sleep between polls.
// (Atomics.wait is permitted off the main thread.)
const sleepLatch = new Int32Array(new SharedArrayBuffer(4));

let closing = false;

/** Block the worker thread for up to `ms` without busy-spinning. */
function sleep(ms: number): void {
  Atomics.wait(sleepLatch, 0, 0, ms);
}

/** conn.read() may short-read; loop until n bytes are gathered.
 * */
function readExactly(conn: ConnLike, n: number): Buffer {
  if (n === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let got = 0;
  while (got < n) {
    const chunk = conn.read(n - got);
    if (chunk.length === 0) throw new Error('peer closed mid-frame');
    parts.push(chunk);
    got += chunk.length;
  }
  return Buffer.concat(parts, n);
}

/** Block until the main thread posts the reply frame for `id`. */
function awaitReplyFrame(id: number): Buffer {
  for (;;) {
    // Drain any queued messages first.
    let m = receiveMessageOnPort(port!);
    while (m) {
      const data = m.message as { kind?: string; id?: number; frameB64?: string };
      if (data?.kind === 'reply' && data.id === id && typeof data.frameB64 === 'string') {
        return Buffer.from(data.frameB64, 'base64');
      }
      if (data?.kind === 'close') closing = true;
      m = receiveMessageOnPort(port!);
    }
    if (closing) throw new Error('server closing');
    // No new message yet; sleep briefly then re-drain.
    sleep(20);
  }
}

let idSeq = 0;

function main(): void {
  let driver: Driver;
  try {
    driver = new Driver(daemonSocketPath);
  } catch (err) {
    port!.postMessage({ kind: 'error', fatal: true, message: `Driver connect ${daemonSocketPath}: ${(err as Error).message}` });
    return;
  }

  let listener: Listener;
  try {
    listener = driver.listen(capPort);
  } catch (err) {
    port!.postMessage({ kind: 'error', fatal: true, message: `listen(${capPort}): ${(err as Error).message}` });
    driver.close();
    return;
  }

  port!.postMessage({ kind: 'ready' });

  while (!closing) {
    let conn: ConnLike;
    try {
      conn = listener.accept() as unknown as ConnLike;
    } catch (err) {
      if (closing) break;
      port!.postMessage({ kind: 'error', fatal: false, message: `accept: ${(err as Error).message}` });
      continue;
    }

    try {
      // Read the 8-byte dataexchange header [4B type BE][4B len BE], then body.
      const hdr = readExactly(conn, 8);
      const len = hdr.readUInt32BE(4);
      const body = readExactly(conn, len);
      // Reassemble and decode so FILE/JSON discrimination matches the encoder.
      const frame = decodeFrame(Buffer.concat([hdr, body], 8 + len)).frame;

      if (frame.type !== DxType.JSON) {
        port!.postMessage({ kind: 'error', fatal: false, message: `unexpected frame type ${frame.type}` });
        conn.close();
        continue;
      }

      const id = ++idSeq;
      port!.postMessage({ kind: 'request', id, payloadB64: frame.payload.toString('base64') });
      const replyFrame = awaitReplyFrame(id);
      conn.write(replyFrame);
    } catch (err) {
      port!.postMessage({ kind: 'error', fatal: false, message: `conn handling: ${(err as Error).message}` });
    } finally {
      try {
        conn.close();
      } catch {
        /* already closed */
      }
    }
  }

  try {
    listener.close();
  } catch {
    /* ignore */
  }
  driver.close();
}

main();

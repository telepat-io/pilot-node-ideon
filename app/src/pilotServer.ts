/**
 * pilotServer.ts — bind the daemon data plane on the capability port and serve
 * the request-article capability to peers over dataexchange.
 *
 * We open our OWN sdk-node Driver to the daemon's data-plane unix socket
 * ($PILOT_SOCKET, default /tmp/pilot.sock) and listen(1001). The daemon must be
 * run with -no-dataexchange so port 1001 is free for us to own.
 * cite: org/sdk-node/src/client.ts:189-193,328-333.
 *
 * Request and response both travel as a single DxType.JSON frame.
 * cite: org/dataexchange/dataexchange.go:85-92.
 *
 * Driver.listen/accept/read/write are SYNCHRONOUS + BLOCKING (FFI). We run the
 * accept/read/write loop on a worker thread so the Node event loop (and our
 * async wallet/Ideon calls) stays responsive. Each accepted conn is handled by
 * shipping its request to the main thread, awaiting onRequest, and shipping the
 * encoded reply back to the worker which writes it.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DxType } from './types.js';
import type { GenerateRequest, GenerateResponse, CapabilityServerOpts, CapabilityServerHandle } from './types.js';
import { encodeFrame, decodeFrame } from './dxframe.js';
import { log } from './log.js';

/** Messages exchanged with the blocking-IO worker. */
interface WorkerReady {
  kind: 'ready';
}
interface WorkerRequest {
  kind: 'request';
  /** Correlates a request with the reply the main thread sends back. */
  id: number;
  /** Base64 of the decoded JSON-frame payload (the GenerateRequest bytes). */
  payloadB64: string;
}
interface WorkerError {
  kind: 'error';
  fatal: boolean;
  message: string;
}
type FromWorker = WorkerReady | WorkerRequest | WorkerError;

interface MainReply {
  kind: 'reply';
  id: number;
  /** Base64 of the full encoded dataexchange frame to write back. */
  frameB64: string;
}

/**
 * Start the capability server. Resolves once the worker has bound the listener.
 */
export function startCapabilityServer(opts: CapabilityServerOpts): Promise<CapabilityServerHandle> {
  return new Promise<CapabilityServerHandle>((resolve, reject) => {
    const workerPath = fileURLToPath(new URL('./pilotServerWorker.js', import.meta.url));
    const worker = new Worker(workerPath, {
      workerData: { daemonSocketPath: opts.daemonSocketPath, port: opts.port },
    });

    let settled = false;
    const onSpawnError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`pilotServer: worker failed before ready: ${err.message}`));
    };
    worker.once('error', onSpawnError);

    worker.on('message', (msg: FromWorker) => {
      switch (msg.kind) {
        case 'ready': {
          if (!settled) {
            settled = true;
            worker.removeListener('error', onSpawnError);
            worker.on('error', (err: Error) => log('error', 'pilotServer worker error', { error: err.message }));
            log('info', 'capability server listening', { port: opts.port });
            resolve({
              close(): void {
                worker.postMessage({ kind: 'close' });
                void worker.terminate();
              },
            });
          }
          return;
        }
        case 'request': {
          void handleRequest(worker, msg, opts).catch((err: Error) =>
            log('error', 'pilotServer: handler crashed', { id: msg.id, error: err.message }),
          );
          return;
        }
        case 'error': {
          log(msg.fatal ? 'error' : 'warn', 'pilotServer worker reported error', { message: msg.message });
          if (msg.fatal && !settled) {
            settled = true;
            reject(new Error(`pilotServer: ${msg.message}`));
          }
          return;
        }
      }
    });
  });
}

/**
 * Decode the inbound request, run the user handler, encode the reply as a JSON
 * dataexchange frame, and hand it back to the worker to write on the conn.
 */
async function handleRequest(worker: Worker, msg: WorkerRequest, opts: CapabilityServerOpts): Promise<void> {
  let response: GenerateResponse;
  try {
    const reqBytes = Buffer.from(msg.payloadB64, 'base64');
    const req = JSON.parse(reqBytes.toString('utf-8')) as GenerateRequest;
    log('info', 'capability request', { id: msg.id, op: req.op, idea: truncate(req.idea ?? '') });
    response = await opts.onRequest(req);
  } catch (err) {
    // Surface a well-formed error reply rather than dropping the conn.
    log('error', 'capability request failed', { id: msg.id, error: (err as Error).message });
    response = { op: 'error', ok: false, error: `bad request: ${(err as Error).message}` };
  }

  const replyBytes = Buffer.from(JSON.stringify(response), 'utf-8');
  const frame = encodeFrame(DxType.JSON, replyBytes);
  const reply: MainReply = { kind: 'reply', id: msg.id, frameB64: frame.toString('base64') };
  worker.postMessage(reply);
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Re-export the decode/encode helpers the worker pulls in via its own import,
// kept here so a single module owns the frame contract.
export { encodeFrame, decodeFrame };

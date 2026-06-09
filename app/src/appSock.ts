/**
 * appSock.ts — create the --socket unix listener the supervisor polls for
 * readiness, and serve a minimal app-store IPC responder.
 *
 * The supervisor stat()s our --socket up to 3s to consider us "ready"
 * (cite: org/app-store/plugin/appstore/supervisor.go:779-808). We expose no
 * callable methods in v1 (payee role), so every inbound `req` gets an `err`
 * reply ("method not found"); the socket exists purely as the readiness signal
 * plus a well-behaved IPC endpoint.
 *
 * Wire: [4B len BE][JSON Envelope], cap 1 MiB.
 * cite: org/app-store/pkg/ipc/frame.go:21-69, envelope.go:33-41.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import type { IpcEnvelope, AppSockHandle } from './types.js';
import { log } from './log.js';

/** cite: org/app-store/pkg/ipc/frame.go:15 (MaxFrameSize = 1<<20). */
const IPC_MAX_FRAME_SIZE = 1 << 20;

function writeFrame(sock: net.Socket, env: IpcEnvelope): void {
  const body = Buffer.from(JSON.stringify(env), 'utf-8');
  if (body.length > IPC_MAX_FRAME_SIZE) {
    log('error', 'appSock reply exceeds max frame size; dropping', { len: body.length });
    return;
  }
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  sock.write(Buffer.concat([hdr, body], 4 + body.length));
}

/**
 * Per-connection state machine that reads [4B len][json] frames and replies
 * with an `err` envelope (no methods exposed in v1).
 */
function handleConn(sock: net.Socket): void {
  let buf: Buffer = Buffer.alloc(0);
  sock.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    // Drain as many complete frames as are buffered.
    for (;;) {
      if (buf.length < 4) return;
      const n = buf.readUInt32BE(0);
      if (n === 0 || n > IPC_MAX_FRAME_SIZE) {
        log('error', 'appSock: bad frame length; closing conn', { n });
        sock.destroy();
        return;
      }
      if (buf.length < 4 + n) return;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);

      let env: IpcEnvelope;
      try {
        env = JSON.parse(body.toString('utf-8')) as IpcEnvelope;
      } catch (err) {
        log('error', 'appSock: malformed envelope; closing conn', { error: (err as Error).message });
        sock.destroy();
        return;
      }
      if (env.type !== 'req') {
        // Only requests are expected inbound; ignore stray replies/errs.
        continue;
      }
      writeFrame(sock, {
        type: 'err',
        req_id: env.req_id,
        error: `method not found: ${env.method ?? '(none)'}`,
      });
    }
  });
  sock.on('error', () => sock.destroy());
}

/**
 * Bind a unix listener at socketPath. Removes a stale socket file first so a
 * restart after an unclean exit can re-bind (EADDRINUSE otherwise).
 */
export function serveAppSocket(socketPath: string): Promise<AppSockHandle> {
  return new Promise<AppSockHandle>((resolve, reject) => {
    try {
      if (fs.existsSync(socketPath)) fs.rmSync(socketPath);
    } catch (err) {
      reject(new Error(`appSock: cannot clear stale socket ${socketPath}: ${(err as Error).message}`));
      return;
    }

    const server = net.createServer(handleConn);
    server.once('error', (err: Error) => reject(new Error(`appSock: listen ${socketPath}: ${err.message}`)));
    server.listen(socketPath, () => {
      // Match the wallet reference app: lock the socket to the owning UID.
      // cite: org/wallet/cmd/wallet/main.go:215,224 (chmod 0600).
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // best-effort; non-fatal on platforms that disallow it.
      }
      log('info', 'appSock listening (readiness signal)', { socketPath });
      resolve({
        close(): void {
          server.close();
          try {
            if (fs.existsSync(socketPath)) fs.rmSync(socketPath);
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}

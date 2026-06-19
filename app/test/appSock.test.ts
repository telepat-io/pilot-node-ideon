/**
 * appSock.test.ts — exercise the real --socket IPC dispatcher over the wire.
 * Pure node (node:test + node:assert); no pilotprotocol import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serveAppSocket } from '../src/appSock.js';
import type { Dispatcher, IpcEnvelope } from '../src/types.js';

function encodeFrame(env: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(env), 'utf-8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  return Buffer.concat([hdr, body]);
}

interface Client {
  call(env: Partial<IpcEnvelope>): Promise<IpcEnvelope>;
  close(): void;
}

function connect(socketPath: string): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    const pending = new Map<string, (env: IpcEnvelope) => void>();
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const n = buf.readUInt32BE(0);
        if (buf.length < 4 + n) return;
        const env = JSON.parse(buf.subarray(4, 4 + n).toString('utf-8')) as IpcEnvelope;
        buf = buf.subarray(4 + n);
        const w = pending.get(env.req_id);
        if (w) {
          pending.delete(env.req_id);
          w(env);
        }
      }
    });
    sock.once('error', reject);
    sock.once('connect', () =>
      resolve({
        call: (env) =>
          new Promise<IpcEnvelope>((res) => {
            pending.set(env.req_id as string, res);
            sock.write(encodeFrame(env));
          }),
        close: () => sock.end(),
      }),
    );
  });
}

test('appSock IPC dispatcher', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideon-appsock-'));
  const socketPath = path.join(dir, 'app.sock');

  // A generate/poll pair sharing one in-memory map proves the dispatcher's
  // handlers (and their state) are shared across connections.
  const jobs = new Map<string, string>();
  const dispatch: Dispatcher = new Map();
  dispatch.set('echo', async (payload) => ({ echoed: payload }));
  dispatch.set('boom', async () => {
    throw new Error('kaboom');
  });
  dispatch.set('generate', async () => {
    const jobId = 'job-1';
    jobs.set(jobId, 'done');
    return { jobId };
  });
  dispatch.set('poll', async (payload) => {
    const { jobId } = (payload ?? {}) as { jobId?: string };
    return jobId && jobs.has(jobId) ? { status: 'done' } : { status: 'error' };
  });

  const handle = await serveAppSocket(socketPath, dispatch);
  t.after(() => {
    handle.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  await t.test('registered method → reply with echoed req_id + payload', async () => {
    const c = await connect(socketPath);
    const r = await c.call({ type: 'req', req_id: 'r1', method: 'echo', payload: { hi: 1 } });
    assert.equal(r.type, 'reply');
    assert.equal(r.req_id, 'r1');
    assert.deepEqual(r.payload, { echoed: { hi: 1 } });
    c.close();
  });

  await t.test('unknown method → err', async () => {
    const c = await connect(socketPath);
    const r = await c.call({ type: 'req', req_id: 'r2', method: 'nope', payload: {} });
    assert.equal(r.type, 'err');
    assert.equal(r.req_id, 'r2');
    assert.match(String(r.error), /method not found/);
    c.close();
  });

  await t.test('throwing handler → err; connection survives', async () => {
    const c = await connect(socketPath);
    const r = await c.call({ type: 'req', req_id: 'r3', method: 'boom', payload: {} });
    assert.equal(r.type, 'err');
    assert.equal(r.req_id, 'r3');
    assert.equal(r.error, 'kaboom');
    // Same connection still serves the next request.
    const r2 = await c.call({ type: 'req', req_id: 'r4', method: 'echo', payload: 'ok' });
    assert.equal(r2.type, 'reply');
    assert.deepEqual(r2.payload, { echoed: 'ok' });
    c.close();
  });

  await t.test('shared state: poll on a separate connection finds the job', async () => {
    const a = await connect(socketPath);
    const gen = await a.call({ type: 'req', req_id: 'g1', method: 'generate', payload: { idea: 'x' } });
    assert.equal(gen.type, 'reply');
    const jobId = (gen.payload as { jobId: string }).jobId;
    a.close();

    const b = await connect(socketPath);
    const poll = await b.call({ type: 'req', req_id: 'p1', method: 'poll', payload: { jobId } });
    assert.equal(poll.type, 'reply');
    assert.deepEqual(poll.payload, { status: 'done' });
    b.close();
  });
});

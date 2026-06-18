/**
 * log.ts — structured logging to stderr (stdout is reserved; the supervisor
 * captures both, cite: org/app-store/plugin/appstore/supervisor.go:760-763,
 * but we keep stdout clean for any future protocol use).
 *
 * One JSON object per line: {ts, level, app, msg, ...fields}.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const APP_ID = 'io.telepat.ideon-free';

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    app: APP_ID,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) rec[k] = v;
  }
  // Always to stderr so it never collides with a protocol stdout.
  process.stderr.write(JSON.stringify(rec) + '\n');
}

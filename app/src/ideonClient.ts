/**
 * ideonClient.ts — drive the Ideon MCP HTTP server.
 *
 * Stateful StreamableHTTP transport:
 *   1. POST <endpoint> (Bearer key) `initialize` -> capture `Mcp-Session-Id`
 *      response header. cite: telepat/ideon/src/integrations/mcp/httpServer.ts:41,52-54.
 *   2. POST <endpoint> (Bearer key + Mcp-Session-Id) `notifications/initialized`.
 *   3. POST <endpoint> (Bearer key + Mcp-Session-Id) `tools/call` ideon_write.
 *      cite: telepat/ideon/src/integrations/mcp/tools.ts:360-369 (tool name + required idea).
 *
 * Result: structuredContent {slug,title,outputCount,markdownPath,markdownPaths,
 * generationDir,analyticsPath}. cite: telepat/ideon/src/integrations/mcp/server.ts:199-207.
 * ideon_write returns only a PATH (never the body inline — content[0] is a one-line
 * summary), so we read the body back over HTTPS from the backend's authenticated
 * file route (<origin>/files/<rel>), NOT a shared filesystem. The app therefore
 * needs no co-located volume and runs portably on any daemon that can dial the host.
 *
 * NOTE on maxImages: zod is `z.coerce.number().int().min(1)` in 0.1.38
 * (cite: tools.ts:22) so maxImages:0 is REJECTED. We OMIT maxImages and rely on
 * dryRun to suppress real image generation.
 */

import type { IdeonWriteOpts, IdeonWriteResult } from './types.js';
import { log } from './log.js';

/** The MCP responses come back either as JSON or as an SSE event stream
 *  ("text/event-stream"); StreamableHTTP may use either. We accept both. */
const ACCEPT = 'application/json, text/event-stream';

interface JsonRpcResult {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Partial<IdeonWriteResult>;
  isError?: boolean;
}

let rpcId = 0;

/** POST one JSON-RPC message; return parsed result + any session header. */
async function postRpc(
  endpoint: string,
  apiKey: string,
  body: unknown,
  sessionId?: string,
): Promise<{ json: JsonRpcResult | null; sessionId: string | undefined }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: ACCEPT,
    authorization: `Bearer ${apiKey}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const newSession = res.headers.get('mcp-session-id') ?? sessionId;
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`ideon mcp: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  const json = parseRpcPayload(text);
  if (json?.error) {
    throw new Error(`ideon mcp: rpc error ${json.error.code}: ${json.error.message}`);
  }
  return { json, sessionId: newSession ?? undefined };
}

/**
 * Parse either a plain JSON body or an SSE stream ("data: {...}" lines) into
 * the final JSON-RPC object. cite: MCP StreamableHTTP transport (httpServer.ts:41).
 */
function parseRpcPayload(text: string): JsonRpcResult | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as JsonRpcResult;
  }
  // SSE: take the LAST `data:` line carrying a JSON object.
  let last: JsonRpcResult | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    const payload = m[1].trim();
    if (!payload.startsWith('{')) continue;
    try {
      last = JSON.parse(payload) as JsonRpcResult;
    } catch {
      /* skip non-JSON data lines (keepalives etc.) */
    }
  }
  return last;
}

/**
 * Run ideon_write and return the structured result plus the markdown body.
 */
export async function ideonWrite(opts: IdeonWriteOpts): Promise<IdeonWriteResult> {
  const dryRun = opts.dryRun ?? true;

  // 1. initialize — capture the session id.
  const initId = ++rpcId;
  const init = await postRpc(opts.endpoint, opts.apiKey, {
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ideon-free-app', version: '0.3.0' },
    },
  });
  const sessionId = init.sessionId;
  if (!sessionId) {
    throw new Error('ideon mcp: server did not return an Mcp-Session-Id on initialize');
  }
  log('debug', 'ideon mcp initialized', { sessionId });

  // 2. notifications/initialized — required before tools/call by the MCP spec.
  await postRpc(opts.endpoint, opts.apiKey, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }, sessionId);

  // 3. tools/call ideon_write.
  // cite: tools.ts:8-23 input schema; primary:"article=1" -> one article output.
  const args: Record<string, unknown> = {
    idea: opts.idea,
    primary: 'article=1',
    dryRun,
    // maxImages OMITTED on purpose (0 is rejected; dryRun avoids real images).
  };
  if (opts.style !== undefined) args['style'] = opts.style;
  if (opts.intent !== undefined) args['intent'] = opts.intent;
  if (opts.length !== undefined) args['length'] = opts.length;

  const callId = ++rpcId;
  const call = await postRpc(opts.endpoint, opts.apiKey, {
    jsonrpc: '2.0',
    id: callId,
    method: 'tools/call',
    params: { name: 'ideon_write', arguments: args },
  }, sessionId);

  const result = call.json?.result as ToolCallResult | undefined;
  if (!result) {
    throw new Error('ideon mcp: tools/call returned no result');
  }
  if (result.isError) {
    const txt = result.content?.find((c) => c.type === 'text')?.text ?? 'unknown';
    throw new Error(`ideon mcp: ideon_write failed: ${txt}`);
  }

  const sc = result.structuredContent;
  if (!sc || !sc.markdownPath || !sc.slug || !sc.title) {
    throw new Error('ideon mcp: ideon_write missing structuredContent.{markdownPath,slug,title}');
  }

  // Read the markdown body back over HTTPS. ideon_write returns only a PATH
  // (cite: server.ts:199-207; result.content[0] is a one-line summary, not the
  // body), so the backend serves its Ideon output dir at <origin>/files/<rel>
  // (Bearer-gated). We map the absolute markdownPath to a URL by keying off the
  // ".ideon/" segment — independent of the backend's IDEON_HOME — so the app
  // needs no shared volume and runs portably on any daemon.
  const filesBase = opts.endpoint.replace(/\/mcp\/?$/, '/files');
  const marker = sc.markdownPath.indexOf('.ideon/');
  if (marker < 0) {
    throw new Error(`ideon mcp: unexpected markdownPath ${sc.markdownPath} (no .ideon/ segment)`);
  }
  const fileUrl = `${filesBase}/${sc.markdownPath.slice(marker)}`;
  const fileRes = await fetch(fileUrl, { headers: { authorization: `Bearer ${opts.apiKey}` } });
  if (!fileRes.ok) {
    const body = (await fileRes.text()).slice(0, 300);
    throw new Error(
      `ideon mcp: cannot fetch article body ${fileUrl}: HTTP ${fileRes.status} ${fileRes.statusText} ${body}`,
    );
  }
  const markdown = await fileRes.text();

  log('info', 'ideon_write complete', {
    slug: sc.slug,
    title: sc.title,
    generationDir: sc.generationDir,
    bytes: markdown.length,
  });

  return {
    slug: sc.slug,
    title: sc.title,
    outputCount: sc.outputCount ?? 1,
    markdownPath: sc.markdownPath,
    ...(sc.markdownPaths ? { markdownPaths: sc.markdownPaths } : {}),
    generationDir: sc.generationDir ?? '',
    ...(sc.analyticsPath ? { analyticsPath: sc.analyticsPath } : {}),
    markdown,
  };
}

/**
 * deliver.ts — package a generated article into the op:"deliver" response.
 *
 * The primary response carries the markdown body inline (DeliverResponse.article)
 * so a peer using Driver.sendMessage(target, json, 'json') gets the article in
 * one round-trip. cite: app/src/types.ts DeliverResponse.
 *
 * For a file-oriented transfer (peer pulling raw files), buildFileFrames() emits
 * one DxType.FILE frame per artifact (article-1.md + meta.json) using the
 * dataexchange FILE sub-format [2B nameLen][name][data].
 * cite: org/dataexchange/dataexchange.go:76-83; org/sdk-node/src/client.ts:534-536.
 */

import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { DxType } from './types.js';
import type { IdeonWriteResult, DeliverResponse } from './types.js';
import { encodeFrame, encodeFilePayload } from './dxframe.js';

/**
 * Build the inline DeliverResponse from an ideon_write result. The markdown
 * body was already read back from markdownPath by ideonClient.
 */
export function frameArticle(result: IdeonWriteResult): DeliverResponse {
  return {
    op: 'deliver',
    ok: true,
    article: result.markdown,
    title: result.title,
    slug: result.slug,
  };
}

/**
 * Read article-1.md + meta.json from the generation dir and encode each as a
 * DxType.FILE frame. Used when a caller wants the raw artifacts rather than the
 * inline body. Missing meta.json is tolerated (dry-run writes a placeholder, but
 * we don't hard-require it).
 */
export async function buildFileFrames(result: IdeonWriteResult): Promise<Buffer[]> {
  const frames: Buffer[] = [];

  // The markdown artifact: prefer the exact returned path.
  const mdPath = result.markdownPath;
  const mdName = basename(mdPath) || 'article-1.md';
  const mdData = Buffer.from(result.markdown, 'utf-8');
  frames.push(encodeFrame(DxType.FILE, encodeFilePayload(mdName, mdData)));

  // meta.json sits alongside the markdown in generationDir.
  if (result.generationDir) {
    const metaPath = join(result.generationDir, 'meta.json');
    try {
      const metaData = await readFile(metaPath);
      frames.push(encodeFrame(DxType.FILE, encodeFilePayload('meta.json', metaData)));
    } catch {
      // meta.json optional; omit if absent.
    }
  }

  return frames;
}

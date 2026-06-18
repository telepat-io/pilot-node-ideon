/**
 * deliver.ts — package a generated article into the op:"generate" response.
 *
 * The response carries the markdown body inline (GenerateResponse.article) so a
 * peer using Driver.sendMessage(target, json, 'json') gets the article in one
 * round-trip. cite: app/src/types.ts GenerateResponse.
 */

import type { IdeonWriteResult, GenerateResponse } from './types.js';

/**
 * Build the inline GenerateResponse from an ideon_write result. The markdown
 * body was already read back from markdownPath by ideonClient.
 */
export function frameArticle(result: IdeonWriteResult): GenerateResponse {
  return {
    op: 'generate',
    ok: true,
    article: result.markdown,
    title: result.title,
    slug: result.slug,
  };
}

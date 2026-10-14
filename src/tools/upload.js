/**
 * upload_document — content-safe document ingest.
 *
 * Why this exists: write_document carries raw text inline in the MCP call,
 * which mangles markdown-significant characters (apostrophes doubled,
 * backtick fences collapsed). upload_document carries the content as
 * base64, which is transport-safe: only A-Za-z0-9+/= travel, so nothing
 * gets corrupted on the way in. The Worker decodes it back to exact UTF-8.
 *
 * Single file per call. Batching (how many calls for N files) is the
 * caller's job, because the real size ceiling is the MCP tag itself,
 * above this tool — not anything the tool can enforce.
 */

import { ok, err, classifyError } from '../envelope.js';
import { chunkText, vectorId } from '../chunk.js';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Decode standard base64 to a UTF-8 string.
 * atob() alone returns latin1, which corrupts em-dashes and curly quotes.
 * TextDecoder fixes that — this is the whole reason we don't just atob().
 */
function base64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/* ------------------------------------------------------------------------ */
/* upload_document                                                           */
/* ------------------------------------------------------------------------ */

export async function uploadDocument(env, { path, content_b64 }) {
  if (!path || typeof path !== 'string') {
    return err('VALIDATION', 'path is required and must be a string');
  }
  if (!content_b64 || typeof content_b64 !== 'string') {
    return err('VALIDATION', 'content_b64 is required and must be a base64 string');
  }

  let content;
  try {
    content = base64ToUtf8(content_b64);
  } catch (e) {
    return err('VALIDATION', 'content_b64 is not valid base64', {
      detail: String(e.message || e)
    });
  }

  const phase = { decode: null, write: null, reindex: null, purge: null };
  phase.decode = { ok: true, bytes: content.length };
  const now = new Date().toISOString();

  // --- capture previous chunk_count BEFORE overwriting the row ---
  let prevCount = 0;
  try {
    const prev = await env.BDS_META.prepare(
      'SELECT chunk_count FROM documents WHERE path = ?1'
    ).bind(path).first();
    prevCount = prev ? (prev.chunk_count || 0) : 0;
  } catch (e) {
    // non-fatal: treat as new doc
    prevCount = 0;
  }

  // --- write phase ---
  try {
    await env.BDS_META.prepare(
      `INSERT INTO documents (path, content, size_bytes, chunk_count, indexed_at, updated_at)
       VALUES (?1, ?2, ?3, 0, NULL, ?4)
       ON CONFLICT(path) DO UPDATE SET
         content    = excluded.content,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`
    ).bind(path, content, content.length, now).run();
    phase.write = { ok: true, bytes: content.length };
  } catch (e) {
    return err(classifyError(e), `write phase failed: ${e.message || e}`, { path, phase: 'write' });
  }

  // --- reindex phase ---
  try {
    const chunks = chunkText(content);
    const newCount = chunks.length;

    if (newCount === 0) {
      phase.reindex = { ok: true, chunks: 0, note: 'empty content' };
    } else {
      const embedRes = await env.AI.run(EMBED_MODEL, { text: chunks });
      const vectors = embedRes?.data || [];
      if (vectors.length !== chunks.length) {
        throw new Error(`embedding count mismatch: got ${vectors.length}, expected ${chunks.length}`);
      }
      const upserts = chunks.map((text, i) => ({
        id: vectorId(path, i),
        values: vectors[i],
        metadata: { path, chunk_index: i, preview: text.slice(0, 240) }
      }));
      for (let i = 0; i < upserts.length; i += 100) {
        await env.BDS_INDEX.upsert(upserts.slice(i, i + 100));
      }
      phase.reindex = { ok: true, chunks: newCount };
    }

    // --- purge phase: delete stale vectors beyond the new count ---
    if (newCount < prevCount) {
      const stale = [];
      for (let i = newCount; i < prevCount; i++) {
        stale.push(vectorId(path, i));
      }
      for (let i = 0; i < stale.length; i += 100) {
        await env.BDS_INDEX.deleteByIds(stale.slice(i, i + 100));
      }
      phase.purge = { ok: true, deleted: stale.length };
    } else {
      phase.purge = { ok: true, deleted: 0 };
    }

    await env.BDS_META.prepare(
      'UPDATE documents SET chunk_count = ?1, indexed_at = ?2 WHERE path = ?3'
    ).bind(newCount || 0, new Date().toISOString(), path).run();
  } catch (e) {
    return ok({
      partial: true, path, phase,
      warning: 'document saved but index is stale — search may not reflect this change'
    }, { note: 'reindex failed' });
  }

  return ok({ path, phase });
}

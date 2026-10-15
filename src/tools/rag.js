import { ok, err, classifyError } from '../envelope.js';
import { chunkText, vectorId } from '../chunk.js';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const MAX_DOC_BYTES = 64 * 1024;

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------ */

/** SHA-256 hex of a UTF-8 string. */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Persist content: D1 write -> re-embed -> upsert -> purge stale tail.
 * Shared by writeDocument, uploadDocument, and editDocument.
 * Returns the phase record; throws on reindex failure.
 */
export async function persistDocument(env, path, content, prevCount) {
  const phase = { write: null, reindex: null, purge: null };
  const now = new Date().toISOString();

  await env.BDS_META.prepare(
    `INSERT INTO documents (path, content, size_bytes, chunk_count, indexed_at, updated_at)
     VALUES (?1, ?2, ?3, 0, NULL, ?4)
     ON CONFLICT(path) DO UPDATE SET
       content    = excluded.content,
       size_bytes = excluded.size_bytes,
       updated_at = excluded.updated_at`
  ).bind(path, content, content.length, now).run();
  phase.write = { ok: true, bytes: content.length };

  const chunks = chunkText(content);
  const newCount = chunks.length;

  if (newCount > 0) {
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
  }
  phase.reindex = { ok: true, chunks: newCount };

  if (newCount < prevCount) {
    const stale = [];
    for (let i = newCount; i < prevCount; i++) {
      stale.push(vectorId(path, i));
    }
    for (let i = 0; i < stale.length; i += 100) {
      await env.BDS_INDEX.deleteByIds(stale.slice(i, i + 100));
    }
    phase.purge = { ok: true, deleted: stale.length };
  }

  await env.BDS_META.prepare(
    'UPDATE documents SET chunk_count = ?1, indexed_at = ?2 WHERE path = ?3'
  ).bind(newCount, new Date().toISOString(), path).run();

  return phase;
}

export async function searchDocuments(env, { query, top_k = 5 }) {
  if (!query || typeof query !== 'string') {
    return err('VALIDATION', 'query is required and must be a string');
  }
  const k = Math.max(1, Math.min(20, Number(top_k) || 5));

  try {
    const embedRes = await env.AI.run(EMBED_MODEL, { text: [query] });
    const vector = embedRes?.data?.[0];

    console.log('EMBED_DEBUG', JSON.stringify({
      dataIsArray: Array.isArray(embedRes?.data),
      dataLength: embedRes?.data?.length,
      firstIsArray: Array.isArray(vector),
      firstLength: Array.isArray(vector) ? vector.length : null
    }));

    if (!vector) {
      return err('INTERNAL', 'Embedding model returned no vector', { embedRes });
    }

    const matches = await env.BDS_INDEX.query(vector, {
      topK: k,
      returnMetadata: 'all'
    });

    console.log('VECTORIZE_DEBUG', JSON.stringify({
      topLevelType: typeof matches,
      topLevelKeys: matches ? Object.keys(matches) : null,
      matchesIsArray: Array.isArray(matches?.matches),
      matchesLength: matches?.matches?.length,
      firstMatchKeys: matches?.matches?.[0] ? Object.keys(matches.matches[0]) : null
    }));

    const rawMatches = matches?.matches || [];
    const results = rawMatches.map((m) => ({
      path: m.metadata?.path ?? m.id,
      score: m.score,
      preview: (m.metadata?.preview || '').slice(0, 240),
      chunk_index: m.metadata?.chunk_index ?? null
    }));

    return ok(
      { query, count: results.length, results },
      { note: results.length === 0 ? 'no matches' : undefined }
    );
  } catch (e) {
    return err(classifyError(e), String(e.message || e), { query });
  }
}

export async function getDocument(env, { path }) {
  if (!path || typeof path !== 'string') {
    return err('VALIDATION', 'path is required and must be a string');
  }
  try {
    const row = await env.BDS_META.prepare(
      'SELECT content, size_bytes, chunk_count, updated_at FROM documents WHERE path = ?1'
    ).bind(path).first();
    if (!row) return err('NOT_FOUND', `No document at path: ${path}`, { path });
    const text = row.content || '';
    const sha256 = await sha256Hex(text);
    const truncated = text.length > MAX_DOC_BYTES;
    return ok({
      path,
      size_bytes: row.size_bytes,
      chunk_count: row.chunk_count,
      updated_at: row.updated_at,
      sha256,
      truncated,
      content: truncated ? text.slice(0, MAX_DOC_BYTES) : text,
      truncation_note: truncated ? `[…truncated at ${MAX_DOC_BYTES} bytes of ${text.length}]` : null
    });
  } catch (e) {
    return err(classifyError(e), String(e.message || e), { path });
  }
}

export async function writeDocument(env, { path, content }) {
  if (!path || typeof path !== 'string') {
    return err('VALIDATION', 'path is required and must be a string');
  }
  if (typeof content !== 'string') {
    return err('VALIDATION', 'content is required and must be a string');
  }
  const phase = { write: null, reindex: null, purge: null };

  // capture prevCount BEFORE the write
  let prevCount = 0;
  try {
    const prev = await env.BDS_META.prepare(
      'SELECT chunk_count FROM documents WHERE path = ?1'
    ).bind(path).first();
    prevCount = prev ? (prev.chunk_count || 0) : 0;
  } catch (_) { prevCount = 0; }

  try {
    const p = await persistDocument(env, path, content, prevCount);
    phase.write = p.write;
    phase.reindex = p.reindex;
    phase.purge = p.purge;
  } catch (e) {
    return ok({
      partial: true, path, phase,
      warning: 'document saved but index is stale — search may not reflect this change'
    }, { note: 'reindex failed' });
  }

  return ok({ path, phase });
}

/* ------------------------------------------------------------------------ */
/* edit_document — surgical string replacement on an existing document       */
/* ------------------------------------------------------------------------ */

export async function editDocument(env, { path, old_str, new_str, count = 1 }) {
  if (!path || typeof path !== 'string') {
    return err('VALIDATION', 'path is required and must be a string');
  }
  if (typeof old_str !== 'string' || old_str.length === 0) {
    return err('VALIDATION', 'old_str is required and must be a non-empty string');
  }
  if (typeof new_str !== 'string') {
    return err('VALIDATION', 'new_str is required and must be a string');
  }
  if (old_str === new_str) {
    return err('VALIDATION', 'old_str and new_str are identical — nothing to do');
  }

  const phase = { read: null, replace: null, write: null, reindex: null, purge: null };

  // 1. read current content
  let row;
  try {
    row = await env.BDS_META.prepare(
      'SELECT content, size_bytes, chunk_count FROM documents WHERE path = ?1'
    ).bind(path).first();
  } catch (e) {
    return err(classifyError(e), `read failed: ${e.message || e}`, { path });
  }
  if (!row) return err('NOT_FOUND', `No document at path: ${path}`, { path });

  const before = row.content || '';
  const prevCount = Math.max(0, Number(row.chunk_count) || 0);
  const sha_before = await sha256Hex(before);
  phase.read = { ok: true, bytes: before.length, sha256: sha_before };

  // 2. count occurrences BEFORE any write
  const occurrences = countOccurrences(before, old_str);

  if (occurrences === 0) {
    return err('VALIDATION', `old_str not found in ${path}`, {
      path, occurrences: 0, sha256_before: sha_before
    });
  }

  const expected = count === 'all' ? occurrences : Number(count);
  if (!Number.isFinite(expected) || expected < 1) {
    return err('VALIDATION', `invalid count: ${JSON.stringify(count)}`, { path, occurrences });
  }
  if (occurrences !== expected) {
    return err(
      'VALIDATION',
      `old_str occurs ${occurrences} time(s), expected ${expected}. ` +
      `Pass count=${occurrences} or count="all" to proceed.`,
      { path, occurrences, expected, sha256_before: sha_before }
    );
  }

  // 3. apply
  const after = count === 'all'
    ? before.split(old_str).join(new_str)
    : before.replace(old_str, new_str);

  const sha_after = await sha256Hex(after);
  phase.replace = { ok: true, occurrences: expected };

  if (after === before) {
    return ok({
      path, changed: false,
      occurrences: expected,
      sha256_before: sha_before,
      sha256_after: sha_after,
      phase
    });
  }

  // 4. persist
  try {
    const p = await persistDocument(env, path, after, prevCount);
    phase.write = p.write;
    phase.reindex = p.reindex;
    phase.purge = p.purge;
  } catch (e) {
    return ok({
      partial: true, path, phase,
      warning: 'edit computed but persist failed — storage may be stale'
    }, { note: 'persist failed' });
  }

  return ok({
    path,
    changed: true,
    occurrences: expected,
    bytes_before: before.length,
    bytes_after: after.length,
    sha256_before: sha_before,
    sha256_after: sha_after,
    phase
  });
}

export async function renameDocument(env, { from, to, force = false }) {
  if (!from || typeof from !== 'string') {
    return err('VALIDATION', 'from is required and must be a string');
  }
  if (!to || typeof to !== 'string') {
    return err('VALIDATION', 'to is required and must be a string');
  }
  if (from === to) {
    return err('VALIDATION', 'from and to are identical — nothing to do');
  }

  const phase = { source: null, destination: null, write: null, reindex: null, purge: null };

  // 1. Read the source row.
  let src;
  try {
    src = await env.BDS_META.prepare(
      'SELECT content, size_bytes, chunk_count FROM documents WHERE path = ?1'
    ).bind(from).first();
  } catch (e) {
    return err(classifyError(e), `source lookup failed: ${e.message || e}`, { from });
  }
  if (!src) {
    return err('NOT_FOUND', `No document at path: ${from}`, { from });
  }
  const content = src.content || '';
  const srcChunks = Math.max(0, Number(src.chunk_count) || 0);
  phase.source = { ok: true, chunks: srcChunks, bytes: content.length };

  // 2. Check the destination.
  let dst;
  try {
    dst = await env.BDS_META.prepare(
      'SELECT chunk_count FROM documents WHERE path = ?1'
    ).bind(to).first();
  } catch (e) {
    return err(classifyError(e), `destination lookup failed: ${e.message || e}`, { to });
  }
  const dstExists = !!dst;
  const dstChunks = dstExists ? Math.max(0, Number(dst.chunk_count) || 0) : 0;

  if (dstExists && !force) {
    return err(
      'VALIDATION',
      `Destination already exists: ${to}. Re-call with force=true to overwrite.`,
      { from, to, destination_chunks: dstChunks }
    );
  }
  phase.destination = { ok: true, existed: dstExists, chunks: dstChunks, force: !!force };

  // 3. Write source content to the new path.
  const now = new Date().toISOString();
  try {
    await env.BDS_META.prepare(
      `INSERT INTO documents (path, content, size_bytes, chunk_count, indexed_at, updated_at)
       VALUES (?1, ?2, ?3, 0, NULL, ?4)
       ON CONFLICT(path) DO UPDATE SET
         content    = excluded.content,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`
    ).bind(to, content, content.length, now).run();
    phase.write = { ok: true, bytes: content.length };
  } catch (e) {
    return err(classifyError(e), `destination write failed: ${e.message || e}`, { from, to, phase: 'write' });
  }

  // 4. Reindex under the NEW path's deterministic IDs.
  const fromIds = [];
  try {
    const chunks = chunkText(content);
    const newCount = chunks.length;

    // PATCH: debug log mirroring searchDocuments, so the tail shows embed state.
    console.log('RENAME_EMBED_DEBUG', JSON.stringify({
      from, to,
      contentBytes: content.length,
      chunkCount: newCount,
      chunksIsArray: Array.isArray(chunks)
    }));

    if (newCount > 0) {
      const embedRes = await env.AI.run(EMBED_MODEL, { text: chunks });
      const vectors = embedRes?.data || [];

      // PATCH: log what the embed actually returned before we judge it.
      console.log('RENAME_EMBED_RESULT', JSON.stringify({
        from, to,
        dataIsArray: Array.isArray(embedRes?.data),
        vectorsLength: vectors.length,
        expectedLength: chunks.length
      }));

      if (vectors.length !== chunks.length) {
        throw new Error(`embedding count mismatch: got ${vectors.length}, expected ${chunks.length}`);
      }
      const upserts = chunks.map((text, i) => ({
        id: vectorId(to, i),
        values: vectors[i],
        metadata: { path: to, chunk_index: i, preview: text.slice(0, 240) }
      }));
      for (let i = 0; i < upserts.length; i += 100) {
        await env.BDS_INDEX.upsert(upserts.slice(i, i + 100));
      }
    }
    phase.reindex = { ok: true, chunks: newCount };

    // 5. Purge the DESTINATION's old tail, if it was longer than the new content.
    if (dstExists && newCount < dstChunks) {
      const stale = [];
      for (let i = newCount; i < dstChunks; i++) {
        stale.push(vectorId(to, i));
      }
      for (let i = 0; i < stale.length; i += 100) {
        await env.BDS_INDEX.deleteByIds(stale.slice(i, i + 100));
      }
      phase.purge = { ok: true, deleted: stale.length };
    }

    await env.BDS_META.prepare(
      'UPDATE documents SET chunk_count = ?1, indexed_at = ?2 WHERE path = ?3'
    ).bind(newCount, new Date().toISOString(), to).run();
  } catch (e) {
    // PATCH: log the swallowed error so the tail captures it.
    console.error('RENAME_REINDEX_FAILED', JSON.stringify({
      from, to,
      error: String(e && e.message ? e.message : e),
      stack: String(e && e.stack ? e.stack : '')
    }));

    // PATCH: structured error instead of null (fix #3).
    phase.reindex = { ok: false, error: String(e && e.message ? e.message : e) };

    // PATCH: roll back the destination write so no ghost survives (fix #2).
    try {
      await env.BDS_META.prepare('DELETE FROM documents WHERE path = ?1').bind(to).run();
      phase.rollback = { ok: true, removed: to };
    } catch (re) {
      phase.rollback = { ok: false, error: String(re.message || re) };
    }

    return ok({
      partial: true, from, to, phase,
      warning: 'reindex failed — destination rolled back, old path NOT removed'
    }, { note: 'reindex failed' });
  }

  // 6. Delete the SOURCE's vectors, then the source row.
  try {
    for (let i = 0; i < srcChunks; i++) {
      fromIds.push(vectorId(from, i));
    }
    for (let i = 0; i < fromIds.length; i += 100) {
      await env.BDS_INDEX.deleteByIds(fromIds.slice(i, i + 100));
    }
    phase.purge = { ok: true, deleted: fromIds.length };
  } catch (e) {
    phase.purge = { ok: false, error: String(e.message || e) };
  }

  try {
    await env.BDS_META.prepare('DELETE FROM documents WHERE path = ?1').bind(from).run();
  } catch (e) {
    return err(classifyError(e), `source delete failed: ${e.message || e}`, { from, to, phase });
  }

  return ok({ from, to, phase });
}

export async function deleteDocument(env, { path }) {
  if (!path || typeof path !== 'string') {
    return err('VALIDATION', 'path is required and must be a string');
  }

  const phase = { lookup: null, vectors: null, storage: null };

  // 1. Look up the doc to learn how many vectors to remove.
  let row;
  try {
    row = await env.BDS_META.prepare(
      'SELECT chunk_count FROM documents WHERE path = ?1'
    ).bind(path).first();
  } catch (e) {
    return err(classifyError(e), `lookup failed: ${e.message || e}`, { path, phase: 'lookup' });
  }

  if (!row) {
    return err('NOT_FOUND', `No document at path: ${path}`, { path });
  }
  phase.lookup = { ok: true, chunk_count: row.chunk_count || 0 };

  // 2. Remove vectors. IDs are deterministic via vectorId().
  //    Tolerate stale chunk_count (a failed reindex leaves it at 0).
  try {
    const n = Math.max(0, Number(row.chunk_count) || 0);
    const ids = Array.from({ length: n }, (_, i) => vectorId(path, i));
    if (ids.length > 0) {
      for (let i = 0; i < ids.length; i += 100) {
        await env.BDS_INDEX.deleteByIds(ids.slice(i, i + 100));
      }
    }
    phase.vectors = { ok: true, deleted: ids.length };
  } catch (e) {
    // Vector cleanup is best-effort; still remove the D1 row so the doc
    // disappears from list_folder / get_document.
    phase.vectors = { ok: false, error: String(e.message || e) };
  }

  // 3. Remove the document row.
  try {
    await env.BDS_META.prepare(
      'DELETE FROM documents WHERE path = ?1'
    ).bind(path).run();
    phase.storage = { ok: true };
  } catch (e) {
    return err(classifyError(e), `storage delete failed: ${e.message || e}`, { path, phase: 'storage' });
  }

  const clean = phase.vectors.ok;
  return ok(
    { path, phase },
    clean ? {} : { note: 'document removed but some vectors may remain — re-run or purge manually' }
  );
}

export async function listFolder(env, { prefix = '', limit = 100 }) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 100));
  const likePattern = `${prefix}%`;
  try {
    const result = await env.BDS_META.prepare(
      `SELECT path, size_bytes, chunk_count, updated_at
         FROM documents
        WHERE path LIKE ?1
        ORDER BY path
        LIMIT ?2`
    ).bind(likePattern, n).all();
    const items = (result.results || []).map((r) => ({
      path: r.path,
      size_bytes: r.size_bytes,
      chunk_count: r.chunk_count,
      updated_at: r.updated_at
    }));
    return ok({ prefix, count: items.length, truncated: items.length === n, items });
  } catch (e) {
    return err(classifyError(e), String(e.message || e), { prefix });
  }
}
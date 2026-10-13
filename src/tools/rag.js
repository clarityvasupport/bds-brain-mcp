import { ok, err, classifyError } from '../envelope.js';
import { chunkText } from '../chunk.js';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const MAX_DOC_BYTES = 64 * 1024;

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
    const truncated = text.length > MAX_DOC_BYTES;
    return ok({
      path,
      size_bytes: row.size_bytes,
      chunk_count: row.chunk_count,
      updated_at: row.updated_at,
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
  const phase = { write: null, reindex: null };
  const now = new Date().toISOString();

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

  try {
    const chunks = chunkText(content);
    if (chunks.length === 0) {
      phase.reindex = { ok: true, chunks: 0, note: 'empty content' };
    } else {
      const embedRes = await env.AI.run(EMBED_MODEL, { text: chunks });
      const vectors = embedRes?.data || [];
      if (vectors.length !== chunks.length) {
        throw new Error(`embedding count mismatch: got ${vectors.length}, expected ${chunks.length}`);
      }
      const upserts = chunks.map((text, i) => ({
        id: `${path.replace(/[^a-zA-Z0-9._-]/g, '_')}__${i}`,
        values: vectors[i],
        metadata: { path, chunk_index: i, preview: text.slice(0, 240) }
      }));
      for (let i = 0; i < upserts.length; i += 100) {
        await env.BDS_INDEX.upsert(upserts.slice(i, i + 100));
      }
      phase.reindex = { ok: true, chunks: chunks.length };
    }
    await env.BDS_META.prepare(
      'UPDATE documents SET chunk_count = ?1, indexed_at = ?2 WHERE path = ?3'
    ).bind(phase.reindex.chunks || 0, new Date().toISOString(), path).run();
  } catch (e) {
    return ok({
      partial: true, path, phase,
      warning: 'document saved but index is stale — search may not reflect this change'
    }, { note: 'reindex failed' });
  }

  return ok({ path, phase });
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
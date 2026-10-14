/**
 * Simple character-based chunker with overlap.
 *
 * Not semantically aware — just splits on character boundaries
 * near word breaks. Good enough for v1; swap for a token-aware
 * chunker when retrieval quality matters more.
 */

const DEFAULT_SIZE = 1200;   // ~300 tokens of English
const DEFAULT_OVERLAP = 200;

export function chunkText(text, size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP) {
  if (!text || text.length === 0) return [];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + size, text.length);

    // Try to end on a paragraph or sentence boundary within the last 20%
    if (end < text.length) {
      const window = text.slice(Math.floor(start + size * 0.8), end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('\n')
      );
      if (breakAt > 0) {
        end = Math.floor(start + size * 0.8) + breakAt + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;

    start = end - overlap;
    if (start < 0) start = 0;
  }

  return chunks.filter((c) => c.length > 0);
}

/* ------------------------------------------------------------------------ */
/* Vector ID construction                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Vectorize caps vector IDs at 64 bytes. The old scheme used the full
 * sanitized path, which overflows for deep paths (moving a file to
 * Projects/facility-prep/ pushed a 62-byte ID to 67 bytes → error 40008).
 *
 * Strategy: if the sanitized path + suffix fits in 64 bytes, use it as-is
 * (preserves existing IDs for short paths). If not, truncate and append a
 * stable base-36 hash of the FULL path so uniqueness is kept.
 *
 * FNV-1a — deterministic, synchronous, no crypto import needed.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0);
}

export function vectorId(path, index) {
  const sanitized = String(path).replace(/[^a-zA-Z0-9._-]/g, '_');
  const suffix = `__${index}`;
  const full = `${sanitized}${suffix}`;

  if (full.length <= 64) return full;

  const hash = fnv1a(sanitized).toString(36);
  const head = sanitized.slice(0, 64 - suffix.length - hash.length - 1);
  return `${head}_${hash}${suffix}`;
}
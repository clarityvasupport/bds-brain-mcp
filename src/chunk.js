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

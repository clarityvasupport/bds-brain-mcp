/**
 * Structured response envelope.
 *
 * Every tool returns one of these, wrapped in MCP content format.
 * Codes marked retriable should be retried by the caller; terminal
 * codes should not be.
 */

const RETRIABLE_CODES = new Set([
  'TIMEOUT',
  'NETWORK',
  'RATE_LIMIT',
  'UPSTREAM',
  'INTERNAL'
]);

export function ok(data, meta = {}) {
  return {
    status: 'ok',
    data,
    meta: { ...meta, at: new Date().toISOString() }
  };
}

export function err(code, message, details = {}) {
  const retriable = RETRIABLE_CODES.has(code);
  return {
    status: 'error',
    error: {
      code,
      message,
      retriable,
      details
    },
    meta: { at: new Date().toISOString() }
  };
}

/**
 * Wrap an envelope in MCP content format.
 * The envelope itself is JSON-stringified so it survives
 * any downstream text handling intact.
 */
export function toMcpContent(envelope, toolName, startedAt) {
  const duration = Date.now() - startedAt;
  envelope.meta = { ...(envelope.meta || {}), tool: toolName, duration_ms: duration };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(envelope, null, 2)
      }
    ],
    isError: envelope.status === 'error'
  };
}

/**
 * Classify a thrown error into our envelope code vocabulary.
 * Used to translate upstream exceptions without inventing causes.
 */
export function classifyError(error) {
  const msg = String(error && error.message ? error.message : error);

  if (/timeout|timed out|etimedout/i.test(msg)) return 'TIMEOUT';
  if (/fetch failed|network|econnrefused|enotfound/i.test(msg)) return 'NETWORK';
  if (/rate.?limit|429/i.test(msg)) return 'RATE_LIMIT';
  if (/5\d\d|internal server|upstream/i.test(msg)) return 'UPSTREAM';
  if (/dimension|mismatch|invalid|bad request|400/i.test(msg)) return 'VALIDATION';
  if (/not found|404/i.test(msg)) return 'NOT_FOUND';
  if (/forbidden|unauthorized|401|403/i.test(msg)) return 'FORBIDDEN';

  return 'INTERNAL';
}

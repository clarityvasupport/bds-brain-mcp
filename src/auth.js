/**
 * API key check.
 *
 * Accepts the key in either header:
 *   Authorization: Bearer <key>
 *   X-API-Key: <key>
 *
 * Returns null if authorized, or a Response if not.
 */

export function checkAuth(request, env) {
  // If no API_KEY is configured, refuse to run — better to fail loud
  // than to accidentally expose an open server.
  if (!env.API_KEY) {
    return new Response(
      JSON.stringify({
        error: 'server misconfigured',
        detail: 'API_KEY is not set. Run: npx wrangler secret put API_KEY'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const authHeader = request.headers.get('authorization') || '';
  const apiKeyHeader = request.headers.get('x-api-key') || '';

  let provided = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    provided = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    provided = apiKeyHeader.trim();
  }

  if (!provided || provided !== env.API_KEY) {
    return new Response(
      JSON.stringify({
        error: 'unauthorized',
        detail: 'Missing or invalid API key'
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return null;
}

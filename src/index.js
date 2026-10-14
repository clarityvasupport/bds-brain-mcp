/**
 * BDS Brain MCP — Worker entry point.
 *
 * Routes:
 *   GET  /            landing / health check
 *   GET  /health      JSON health + configured bindings
 *   ANY  /mcp         MCP endpoint (auth required)
 *
 * Every incoming request has its headers logged to stdout so you can
 * verify what BDS actually sends (see README → "Verifying what BDS sends").
 */

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { checkAuth } from './auth.js';
import { toMcpContent } from './envelope.js';
import {
  searchDocuments,
  getDocument,
  writeDocument,
  listFolder,
  deleteDocument,
  renameDocument
} from './tools/rag.js';
import { generateImage, transformImage } from './tools/image.js';
import { uploadDocument } from './tools/upload.js';

/* ========================================================================== */
/* MCP agent                                                                  */
/* ========================================================================== */

export class BdsBrainMCP extends McpAgent {
  server = new McpServer({
    name: 'bds-brain',
    version: '1.0.0'
  });

  async init() {
    /* ---- RAG / files --------------------------------------------------- */

    this.server.tool(
      'search_documents',
      'Semantic search across indexed documents. Returns the top_k most relevant chunks with their source paths and a short preview.',
      {
        query: z.string().describe('Natural-language search query'),
        top_k: z.number().min(1).max(20).optional()
          .describe('How many results to return (default 5)')
      },
      async (args) => {
        const t = Date.now();
        const env = this.env;
        const envelope = await searchDocuments(env, args);
        return toMcpContent(envelope, 'search_documents', t);
      }
    );

    this.server.tool(
      'get_document',
      'Fetch a document by its full path. Returns the text content, truncated at 64 KB with a visible marker if longer.',
      {
        path: z.string().describe('Full document path, e.g. "projects/alpha.md"')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await getDocument(this.env, args);
        return toMcpContent(envelope, 'get_document', t);
      }
    );

    this.server.tool(
      'write_document',
      'Save a document and re-index it for search. Two-phase: writes to storage, then updates the search index. Reports partial success if the index step fails.',
      {
        path: z.string().describe('Where to save, e.g. "notes/idea.md"'),
        content: z.string().describe('Full document text')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await writeDocument(this.env, args);
        return toMcpContent(envelope, 'write_document', t);
      }
    );

    this.server.tool(
      'upload_document',
      'Save a document from base64-encoded content and re-index it. Transport-safe: use this instead of write_document when the content contains markdown-significant characters (backticks, apostrophes, quotes, em-dashes). Single file per call. Two-phase: writes to storage, then re-indexes; reports partial success if the index step fails.',
      {
        path: z.string().describe('Where to save, e.g. "notes/idea.md"'),
        content_b64: z.string().describe('The file content, base64-encoded (standard base64, UTF-8)')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await uploadDocument(this.env, args);
        return toMcpContent(envelope, 'upload_document', t);
      }
    );

    this.server.tool(
      'list_folder',
      'List document paths under a prefix. Use an empty prefix to list everything.',
      {
        prefix: z.string().optional().describe('Path prefix, e.g. "projects/"'),
        limit: z.number().min(1).max(1000).optional()
          .describe('Max results (default 100)')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await listFolder(this.env, args);
        return toMcpContent(envelope, 'list_folder', t);
      }
    );

    this.server.tool(
      'delete_document',
      'Delete a document from storage and remove its vectors from the search index. Irreversible. Use list_folder first to confirm the path.',
      {
        path: z.string().describe('Full document path, e.g. "test/hello.md"')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await deleteDocument(this.env, args);
        return toMcpContent(envelope, 'delete_document', t);
      }
    );
    
    this.server.tool(
      'rename_document',
      'Rename or move a document by changing its path. Copies content to the new path, re-indexes under the new path, removes the old path and its vectors. Refuses if the destination exists unless force=true.',
      {
        from: z.string().describe('Current full path, e.g. "notes/old.md"'),
        to: z.string().describe('New full path, e.g. "notes/new.md"'),
        force: z.boolean().optional().describe('Overwrite destination if it exists (default false)')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await renameDocument(this.env, args);
        return toMcpContent(envelope, 'rename_document', t);
      }
    );

    /* ---- image --------------------------------------------------------- */

    this.server.tool(
      'generate_image',
      'Generate an image from a text prompt using Workers AI. Returns base64 PNG data. Available models: flux (default), sdxl, dreamshaper.',
      {
        prompt: z.string().describe('What to draw'),
        model: z.enum(['flux', 'sdxl', 'dreamshaper']).optional()
          .describe('Which model to use (default flux)'),
        steps: z.number().min(1).max(8).optional()
          .describe('Diffusion steps for flux (default 4)')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await generateImage(this.env, args);
        return toMcpContent(envelope, 'generate_image', t);
      }
    );

    this.server.tool(
      'transform_image',
      'Placeholder. Resize/crop/watermark requires Cloudflare Images (paid) or a bundled WASM image library. Returns an explanatory error until implemented.',
      {
        url: z.string().describe('Source image URL'),
        ops: z.string().optional().describe('Operations to apply, e.g. "resize:800x600"')
      },
      async (args) => {
        const t = Date.now();
        const envelope = await transformImage(this.env, args);
        return toMcpContent(envelope, 'transform_image', t);
      }
    );
  }
}

/* ========================================================================== */
/* Worker fetch handler                                                       */
/* ========================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* ---- Log every request's headers so BDS's wire format is visible --- */
    const headerObj = Object.fromEntries(request.headers.entries());
    console.log(
      'INCOMING',
      JSON.stringify({
        method: request.method,
        path: url.pathname,
        headers: headerObj
      })
    );

    /* ---- Health check (no auth) ---------------------------------------- */
    if (url.pathname === '/health') {
      return json({
        ok: true,
        name: 'bds-brain-mcp',
        version: '1.0.0',
        bindings: {
          ai: !!env.AI,
          vectorize: !!env.BDS_INDEX,
          d1: !!env.BDS_META,
          kv: !!env.BDS_BRAIN_KV
        }
      });
    }

    /* ---- Landing (no auth) --------------------------------------------- */
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(
        `BDS Brain MCP is running.\n\n` +
          `MCP endpoint: ${url.origin}/mcp\n` +
          `Health check: ${url.origin}/health\n`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    /* ---- Public image serving (no auth — must be fetchable by renderer) */
    if (url.pathname.startsWith('/image/') && request.method === 'GET') {
      const id = url.pathname.slice('/image/'.length);
      if (!id) return new Response('Missing id', { status: 400 });
      try {
        const row = await env.BDS_META.prepare(
          'SELECT base64, mime FROM images WHERE id = ?1'
        ).bind(id).first();
        if (!row) return new Response('Not found', { status: 404 });
        const bytes = Uint8Array.from(atob(row.base64), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          headers: {
            'Content-Type': row.mime || 'image/png',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      } catch (e) {
        return new Response('Server error: ' + String(e.message || e), { status: 500 });
      }
    }

    /* ---- MCP endpoint (auth required) ---------------------------------- */
    if (url.pathname.startsWith('/mcp')) {
      const authFail = checkAuth(request, env);
      if (authFail) return authFail;

      return BdsBrainMCP.serve('/mcp').fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  }
};

/* ========================================================================== */
/* helpers                                                                    */
/* ========================================================================== */

function json(body) {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

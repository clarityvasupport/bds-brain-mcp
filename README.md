# BDS Brain MCP

Your own MCP server — the "brain" in the BDS architecture. Built from scratch on Cloudflare Workers.

**Seven tools** across RAG, files, and image generation. Thin proxy over R2, Vectorize, D1, and Workers AI. Structured envelope on every response. Static API key auth.

---

## Architecture

```

BDS (browser)  →  bds-brain-mcp (Worker)  →  R2        (documents)
→  Vectorize (embeddings)
→  D1        (metadata)
→  Workers AI (models)

```

BDS connects to one URL. The Worker exposes six tools. Every call returns a structured envelope with status, error code, and retriability.

---

## The six tools

| Tool | Purpose |
|---|---|
| `search_documents` | Semantic search across indexed documents |
| `get_document` | Fetch a document by path |
| `write_document` | Save + re-index (two-phase, reports partial success) |
| `list_folder` | List documents under a prefix |
| `delete_document` | Delete a document + its vectors (irreversible) |
| `generate_image` | Text-to-image via Workers AI |
| `transform_image` | Placeholder — needs Cloudflare Images (paid) |

---

## Setup

### Prerequisites

- Cloudflare account (free tier is enough for v1)
- Node.js 18+
- `wrangler` CLI (installed locally via `npm install`)

### 1. Install

```bash
npm install
```

### 2. Log in to Cloudflare

```
npx wrangler login
```

### 3. Create the resources

**R2 bucket** (document storage):

```
npx wrangler r2 bucket create bds-brain-docs
```

**Vectorize index** (embedding search). The `bge-base-en-v1.5` model produces 768-dimensional vectors, so the index must match:

```
npx wrangler vectorize create bds-brain-index --dimensions=768 --metric=cosine
```

**D1 database** (metadata, job logs):

```
npx wrangler d1 create bds-brain-meta
```

Copy the `database_id` it prints into `wrangler.toml`.

**KV namespace** (job logs, small cache):

```
npx wrangler kv namespace create BDS_BRAIN_KV
```

Copy the `id` into `wrangler.toml`.

### 4. Set the API key

Edit `.dev.vars` (created from `.dev.vars.example`):

```
API_KEY=your-long-random-string-here
```

Generate something long and random. This is the only secret protecting your server.

**For production**, set it as a Worker secret instead of a file:

```
npx wrangler secret put API_KEY
```

### 5. Run the D1 migration

```
npx wrangler d1 execute bds-brain-meta --file=./schema.sql
```

### 6. Deploy

```
npm run deploy
```

Wrangler prints your URL:

```
https://bds-brain-mcp.your-subdomain.workers.dev
```

### 7. Wire into BDS

1. Open the BDS drawer → **Settings → MCP Servers**
2. **URL:** `https://bds-brain-mcp.your-subdomain.workers.dev/mcp`
3. **API key:** the value you set as `API_KEY`
4. Click **Test** — you should see all six tools listed

---

## Verifying what BDS sends

The Worker logs every incoming request's headers to stdout. To watch live:

```
npm run tail
```

Then click **Test** in BDS. The output shows the exact headers BDS sends — including `authorization`, `accept`, and any custom headers. That's how you confirm the auth format and settle the "SSE vs. plain JSON" question empirically.

---

## The envelope

Every tool returns the same shape:

```
{
  "status": "ok",
  "data": { ... },
  "meta": {
    "tool": "search_documents",
    "duration_ms": 142
  }
}
```

Or on failure:

```
{
  "status": "error",
  "error": {
    "code": "UPSTREAM",
    "message": "Vectorize query rejected: dimension mismatch (expected 768, got 1536)",
    "retriable": true,
    "details": { ... }
  },
  "meta": { "tool": "search_documents", "attempt": 1, "duration_ms": 88 }
}
```

Error codes: `TIMEOUT`, `NETWORK`, `RATE_LIMIT`, `UPSTREAM`, `INTERNAL` (retriable); `VALIDATION`, `NOT_FOUND`, `FORBIDDEN` (terminal).

---

## File layout

```
.
├── README.md
├── package.json
├── wrangler.toml
├── schema.sql
├── .dev.vars.example
├── .gitignore
└── src/
    ├── index.js         Worker entry + McpAgent class
    ├── auth.js          API key check
    ├── envelope.js      ok() / err() helpers
    ├── chunk.js         text chunking for indexing
    └── tools/
        ├── rag.js       search_documents, get_document,
        │                write_document, list_folder
        └── image.js     generate_image, transform_image
```

---

## Troubleshooting

**`Test` fails in BDS** → run `npm run tail` in a terminal. The Worker logs every request. If headers arrive, the request got through and the failure is in the response shape.

**Auth rejected** → confirm the API key in BDS matches `API_KEY` exactly. The Worker accepts it as `Authorization: Bearer <key>` or `X-API-Key: <key>`.

**Vectorize dimension mismatch** → the index must be created with `--dimensions=768` to match the embedding model. Delete and recreate if wrong.

**Durable Object errors on deploy** → the free tier supports SQLite-backed DOs. If it complains, ensure the `[[migrations]]` block in `wrangler.toml` is present and unmodified.

**`agents/mcp` import error** → run `npm install agents@latest`. The package evolves; if the API surface has changed, the error message names the missing export.

---

## What this is not

- **Not a fork** of the GitHub MCP server. Different purpose, no GitHub tools.
- **Not multi-tenant.** One API key, one user. Good enough for personal use.
- **Not vector-perfect.** Chunking is character-based. Swap in something smarter when it matters.

</BDS:create_file>

<BDS:create_file fileName="package.json">

```json
{
  "name": "bds-brain-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Personal RAG + file + image MCP server for Better DeepSeek",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "migrate": "wrangler d1 execute bds-brain-meta --file=./schema.sql"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "agents": "^0.0.90",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "wrangler": "^3.80.0"
  }
}


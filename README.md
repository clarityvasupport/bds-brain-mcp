# BDS Brain MCP

Your own MCP server — the "brain" in the BDS architecture. Built from scratch on Cloudflare Workers.

**Ten tools** across RAG, file management, and image generation. Thin proxy over D1, Vectorize, and Workers AI. Structured envelope on every response. Static API key auth. Fork-friendly — see below to deploy your own.

---

## Architecture

```
BDS (browser)  →  bds-brain-mcp (Worker)  →  D1         (documents + metadata + images)
                                          →  Vectorize  (embeddings)
                                          →  Workers AI (embeddings + image models)
                                          →  KV         (bound; reserved, unused by current tools)
```

BDS connects to one URL. The Worker exposes ten tools. Every call returns a structured envelope with status, error code, and retriability.

---

## Using this as a template

This repo is meant to be forked. Fork it, wire it to your own Cloudflare account, and you have your own Brain.

### What to change after forking

- **`wrangler.local.toml`** — fill in `database_id` (D1) and `id` (KV) from your own `wrangler d1 create` and `wrangler kv namespace create` runs. This file is gitignored; never commit it.
- **`.dev.vars`** — set your own `API_KEY`. Copy from `.dev.vars.example` first. Also gitignored.
- **`PUBLIC_BASE_URL`** in `wrangler.toml` — the public origin of your Worker. Used by `generate_image` to build absolute image URLs. Set it to your own Worker URL after first deploy.

### What to leave alone

- **Tool names and argument schemas.** Better DeepSeek and any existing clients call them by exact name.
- **The response envelope.** BDS parses the `status` / `data` / `meta` / `error` shape.
- **`schema.sql`.** The D1 migration is written against an empty database. If you need to change the schema, add a new migration file rather than editing this one.

### Inherited rough edges

- The Worker logs **all** incoming request headers to stdout, including `Authorization`. See the Security note below before exposing your fork publicly.
- `transform_image` is a placeholder that returns an error.
- `schema-v2.sql` is currently identical to `schema.sql`.

---

## The ten tools

| Tool | Purpose |
|---|---|
| `search_documents` | Semantic search across indexed documents |
| `get_document` | Fetch a document by path (truncated at 64 KB) |
| `write_document` | Save + re-index (raw text; two-phase, reports partial success) |
| `edit_document` | Surgical exact-string replacement on an existing doc; returns SHA-256 before/after |
| `upload_document` | Save from base64 — transport-safe for markdown-heavy content (two-phase) |
| `list_folder` | List documents under a prefix |
| `delete_document` | Delete a document + its vectors (irreversible) |
| `rename_document` | Move/rename a doc: re-index under the new path, remove old path and vectors |
| `generate_image` | Text-to-image via Workers AI (flux, sdxl, dreamshaper) |
| `transform_image` | Placeholder — needs Cloudflare Images (paid) |

Documents live in D1 as text. There is no R2 binding. Vectorize holds only the embeddings; D1 is the source of truth for content and metadata.

---

## Setup

### Prerequisites

- Cloudflare account (free tier is enough)
- **Node.js 22+** (wrangler 4.149 requires Node 22)
- `wrangler` CLI (installed locally via `npm install`)

### 1. Install

```bash
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

### 3. Create the resources

**D1 database** (documents, metadata, images):

```bash
npx wrangler d1 create bds-brain-meta
```

**Vectorize index** (embedding search). The `bge-base-en-v1.5` model produces 768-dimensional vectors, so the index must match:

```bash
npx wrangler vectorize create bds-brain-index --dimensions=768 --metric=cosine
```

**KV namespace** (bound in `wrangler.toml`; reserved for future use — no current tool reads it):

```bash
npx wrangler kv namespace create BDS_BRAIN_KV
```

### 4. Create `wrangler.local.toml`

The committed `wrangler.toml` ships with placeholder IDs and is the template, not the deploy config. The `package.json` scripts run against `wrangler.local.toml`, which is gitignored.

```bash
cp wrangler.toml wrangler.local.toml
```

Then edit `wrangler.local.toml` and paste in:
- `database_id` from the `d1 create` output
- `id` from the `kv namespace create` output

### 5. Set the API key

For local dev, copy the example and fill it in:

```bash
cp .dev.vars.example .dev.vars
```

Then open `.dev.vars` and set `API_KEY` to a long random string. This is the only secret protecting your server.

**For production**, set it as a Worker secret instead of a file:

```bash
npx wrangler secret put API_KEY --config wrangler.local.toml
```

### 6. Run the D1 migration

```bash
npm run migrate
```

This applies `schema.sql` to the remote D1 database. For a local-only run, drop `--remote` from the script or run it manually:

```bash
npx wrangler d1 execute bds-brain-meta --file=./schema.sql --local --config wrangler.local.toml
```

### 7. Deploy

```bash
npm run deploy
```

Wrangler prints your URL:

```
https://bds-brain-mcp.<your-subdomain>.workers.dev
```

### 8. Wire into BDS

1. Open the BDS drawer → **Settings → MCP Servers**
2. **URL:** `https://bds-brain-mcp.<your-subdomain>.workers.dev/mcp`
3. **API key:** the value you set as `API_KEY`
4. Click **Test** — you should see all ten tools listed

---

## The envelope

Every tool returns the same shape:

```json
{
  "status": "ok",
  "data": { },
  "meta": {
    "tool": "search_documents",
    "duration_ms": 142
  }
}
```

Or on failure:

```json
{
  "status": "error",
  "error": {
    "code": "UPSTREAM",
    "message": "Vectorize query rejected: dimension mismatch (expected 768, got 1536)",
    "retriable": true,
    "details": { }
  },
  "meta": { "tool": "search_documents", "attempt": 1, "duration_ms": 88 }
}
```

Error codes: `TIMEOUT`, `NETWORK`, `RATE_LIMIT`, `UPSTREAM`, `INTERNAL` (retriable); `VALIDATION`, `NOT_FOUND`, `FORBIDDEN` (terminal).

Two-phase writes (`write_document`, `upload_document`, `edit_document`, `rename_document`) can return `"partial": true` when the storage write succeeded but the search-index update failed. The `phase` object shows which step failed.

---

## File layout

```
.
├── README.md
├── package.json
├── package-lock.json
├── wrangler.toml          template; placeholders for IDs
├── schema.sql             D1 schema (documents, jobs, images)
├── schema-v2.sql          (currently identical to schema.sql)
├── .dev.vars.example      template for local secrets; copy to .dev.vars
├── .gitignore
└── src/
    ├── index.js           Worker entry + McpAgent class
    ├── auth.js            API key check
    ├── envelope.js        ok() / err() / classifyError() helpers
    ├── chunk.js           text chunking + deterministic vector IDs
    └── tools/
        ├── rag.js         search/get/write/edit/list/delete/rename
        ├── upload.js      upload_document (base64 ingest)
        └── image.js       generate_image, transform_image
```

---

## Security note on request logging

Earlier versions of this README suggested running `npm run tail` to inspect incoming headers. The Worker currently logs **all** request headers to stdout, including `authorization` and `x-api-key`. That means:

- **Do not** run `npm run tail` and share the output publicly.
- If you have already shared a tail log, **rotate the API key** (`npx wrangler secret put API_KEY`).

A future change should allowlist diagnostic headers before logging. Until then, treat tail output as secret material.

---

## Troubleshooting

**`Test` fails in BDS** → confirm the URL ends in `/mcp`, the API key matches `API_KEY` exactly, and the request actually reaches the Worker. (Do not paste tail output into a public channel — see the security note above.)

**Auth rejected** → the Worker accepts the key as `Authorization: Bearer <key>` or `X-API-Key: <key>`. Confirm the value in BDS matches `API_KEY` exactly.

**Vectorize dimension mismatch** → the index must be created with `--dimensions=768` to match the embedding model. Delete and recreate if wrong.

**Durable Object errors on deploy** → the free tier supports SQLite-backed DOs. Ensure the `[[migrations]]` block in `wrangler.toml` is present and unmodified.

**`agents/mcp` import error** → run `npm install agents@latest`. The package evolves; if the API surface has changed, the error message names the missing export.

**`npm run dev` says config file not found** → you skipped step 4. Create `wrangler.local.toml` from `wrangler.toml` and fill in the IDs.

---

## What this is not

- **Not a fork** of the GitHub MCP server. Different purpose, no GitHub tools.
- **Not multi-tenant.** One API key, one user. Good enough for personal use.
- **Not vector-perfect.** Chunking is character-based. Swap in something smarter when it matters.

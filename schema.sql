CREATE TABLE IF NOT EXISTS documents (
  path        TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at  TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type    TEXT NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_updated ON documents(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_indexed ON documents(indexed_at);

CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  base64      TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'image/png',
  prompt      TEXT,
  model       TEXT,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
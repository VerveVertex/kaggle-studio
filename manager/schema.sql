CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_hash TEXT NOT NULL, requested REAL NOT NULL,
  started REAL, heartbeat REAL, service TEXT NOT NULL DEFAULT 'submitted',
  kaggle_state TEXT NOT NULL DEFAULT 'SUBMITTING', version TEXT,
  url TEXT NOT NULL DEFAULT '', stop INTEGER NOT NULL DEFAULT 0,
  ended REAL, active INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(active) WHERE active = 1;
CREATE INDEX IF NOT EXISTS runs_recent ON runs(requested DESC);

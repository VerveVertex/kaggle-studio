CREATE TABLE IF NOT EXISTS studio_installation (
 id TEXT PRIMARY KEY, manifest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_credentials (
 provider TEXT PRIMARY KEY, sealed TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 refresh_state TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS studio_options (
 name TEXT PRIMARY KEY, value TEXT NOT NULL
);

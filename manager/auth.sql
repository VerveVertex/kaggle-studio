-- Additive migration: does not modify runs or existing Secrets.
CREATE TABLE IF NOT EXISTS device_pairings (
 id TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, pkce TEXT NOT NULL,
 browser_hash TEXT, ip_hash TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', language TEXT NOT NULL DEFAULT 'en'
);
CREATE INDEX IF NOT EXISTS pairings_ip ON device_pairings(ip_hash,created);
CREATE TABLE IF NOT EXISTS studio_devices (
 id TEXT PRIMARY KEY, manager_hash TEXT NOT NULL UNIQUE, model_hash TEXT NOT NULL UNIQUE,
 created REAL NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);

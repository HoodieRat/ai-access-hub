import Database from 'better-sqlite3';
import * as path from 'path';
import { getConfig } from './config';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const cfg = getConfig();
  const dbPath = path.join(cfg.dataDir, 'hub.db');

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  applySchema(_db);
  return _db;
}

function applySchema(db: Database.Database): void {
  db.exec(`
    -- Secrets: encrypted provider credentials and hub tokens
    CREATE TABLE IF NOT EXISTS secrets (
      key     TEXT PRIMARY KEY,
      value   TEXT NOT NULL,
      updated INTEGER NOT NULL
    );

    -- Client tokens for local apps
    CREATE TABLE IF NOT EXISTS client_tokens (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,
      project_id  TEXT NOT NULL,
      read_only   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      last_used   INTEGER
    );

    -- Per-provider usage windows (rolling counters)
    CREATE TABLE IF NOT EXISTS usage_windows (
      id           TEXT PRIMARY KEY,
      provider_id  TEXT NOT NULL,
      model_id     TEXT,
      window_type  TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      token_count   INTEGER NOT NULL DEFAULT 0,
      provider_unit_count INTEGER NOT NULL DEFAULT 0,
      updated      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_quota_snapshots (
      id              TEXT PRIMARY KEY,
      provider_id     TEXT NOT NULL,
      model_id        TEXT,
      metric_kind     TEXT NOT NULL,
      window_scope    TEXT NOT NULL,
      limit_value     INTEGER NOT NULL,
      remaining_value INTEGER NOT NULL,
      reset_at        INTEGER,
      observed_at     INTEGER NOT NULL,
      confidence      TEXT NOT NULL,
      usage_coverage  TEXT NOT NULL,
      reset_policy    TEXT NOT NULL,
      pool_scope      TEXT NOT NULL,
      pool_key        TEXT,
      metric_label    TEXT,
      source_label    TEXT
    );

    -- Provider health state
    CREATE TABLE IF NOT EXISTS provider_health (
      provider_id          TEXT PRIMARY KEY,
      healthy              INTEGER NOT NULL DEFAULT 1,
      last_check_at        INTEGER NOT NULL DEFAULT 0,
      latency_ms           INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      last_failure_type    TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      circuit_open         INTEGER NOT NULL DEFAULT 0,
      cooldown_until       INTEGER,
      quarantine_until     INTEGER
    );

    CREATE TABLE IF NOT EXISTS model_health (
      provider_id          TEXT NOT NULL,
      model_id             TEXT NOT NULL,
      healthy              INTEGER NOT NULL DEFAULT 1,
      last_check_at        INTEGER NOT NULL DEFAULT 0,
      latency_ms           INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      last_failure_type    TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      circuit_open         INTEGER NOT NULL DEFAULT 0,
      cooldown_until       INTEGER,
      quarantine_until     INTEGER,
      PRIMARY KEY (provider_id, model_id)
    );

    -- Exact request cache
    CREATE TABLE IF NOT EXISTS exact_cache (
      cache_key  TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id   TEXT NOT NULL,
      response   TEXT NOT NULL,
      usage      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      hit_count  INTEGER NOT NULL DEFAULT 0
    );

    -- Semantic cache (embedding vectors stored as JSON)
    CREATE TABLE IF NOT EXISTS semantic_cache (
      id          TEXT PRIMARY KEY,
      prompt_hash TEXT NOT NULL,
      embedding   TEXT NOT NULL,
      response    TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id    TEXT NOT NULL,
      usage       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      hit_count   INTEGER NOT NULL DEFAULT 0
    );

    -- Request logs
    CREATE TABLE IF NOT EXISTS request_logs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT,
      classified_as   TEXT NOT NULL,
      selected_provider TEXT NOT NULL,
      selected_model  TEXT NOT NULL,
      quality_tier    TEXT NOT NULL,
      cache_hit       INTEGER NOT NULL DEFAULT 0,
      prompt_tokens   INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms      INTEGER NOT NULL DEFAULT 0,
      success         INTEGER NOT NULL DEFAULT 1,
      error_code      TEXT,
      fallback_chain  TEXT NOT NULL DEFAULT '[]',
      downgraded      INTEGER NOT NULL DEFAULT 0,
      timestamp       INTEGER NOT NULL
    );

    -- Downgrade warnings and approval history
    CREATE TABLE IF NOT EXISTS warnings (
      id                      TEXT PRIMARY KEY,
      provider_id             TEXT NOT NULL,
      level                   TEXT NOT NULL,
      message                 TEXT NOT NULL,
      same_tier_alternatives  TEXT NOT NULL DEFAULT '[]',
      lower_tier_alternatives TEXT NOT NULL DEFAULT '[]',
      approval_token          TEXT,
      created_at              INTEGER NOT NULL,
      resolved_at             INTEGER
    );

    -- Hub mode settings (persisted overrides of env config)
    CREATE TABLE IF NOT EXISTS hub_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Indices
    CREATE INDEX IF NOT EXISTS idx_usage_windows_provider ON usage_windows(provider_id, window_type, window_start);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_snapshots_lookup ON provider_quota_snapshots(provider_id, metric_kind, window_scope, observed_at);
    CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(selected_provider);
    CREATE INDEX IF NOT EXISTS idx_model_health_provider ON model_health(provider_id);
    CREATE INDEX IF NOT EXISTS idx_exact_cache_expires ON exact_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires ON semantic_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_warnings_provider ON warnings(provider_id, created_at);
  `);

  ensureColumn(db, 'provider_health', 'last_failure_type', 'TEXT');
  ensureColumn(db, 'usage_windows', 'provider_unit_count', 'INTEGER NOT NULL DEFAULT 0');
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some(row => row.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ─── Settings helpers ─────────────────────────────────────────────────────────
export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO hub_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// ─── Request log helpers ──────────────────────────────────────────────────────
export function insertRequestLog(entry: {
  id: string;
  projectId: string | null;
  classifiedAs: string;
  selectedProvider: string;
  selectedModel: string;
  qualityTier: string;
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  fallbackChain: string[];
  downgraded: boolean;
  timestamp: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO request_logs
      (id, project_id, classified_as, selected_provider, selected_model,
       quality_tier, cache_hit, prompt_tokens, completion_tokens, latency_ms,
       success, error_code, fallback_chain, downgraded, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.projectId,
    entry.classifiedAs,
    entry.selectedProvider,
    entry.selectedModel,
    entry.qualityTier,
    entry.cacheHit ? 1 : 0,
    entry.promptTokens,
    entry.completionTokens,
    entry.latencyMs,
    entry.success ? 1 : 0,
    entry.errorCode ?? null,
    JSON.stringify(entry.fallbackChain),
    entry.downgraded ? 1 : 0,
    entry.timestamp,
  );
}

export function getRecentLogs(limit = 100): unknown[] {
  const db = getDb();
  return db.prepare('SELECT * FROM request_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
}

// ─── Usage aggregates ─────────────────────────────────────────────────────────
export interface UsageSummary {
  provider: string;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  cacheHits: number;
  errors: number;
}

export function getUsageSummary(sinceTs?: number): UsageSummary[] {
  const db = getDb();
  const since = sinceTs ?? 0;
  return db.prepare(`
    SELECT
      selected_provider as provider,
      COUNT(*) as totalRequests,
      SUM(prompt_tokens) as totalPromptTokens,
      SUM(completion_tokens) as totalCompletionTokens,
      SUM(cache_hit) as cacheHits,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors
    FROM request_logs
    WHERE timestamp >= ?
    GROUP BY selected_provider
    ORDER BY totalRequests DESC
  `).all(since) as UsageSummary[];
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Health and stability engine.
 *
 * - Circuit breaker state machine (CLOSED → OPEN → HALF_OPEN → CLOSED)
 * - Background health checks
 * - Quarantine windows
 * - Latency scoring
 */

import type { FailureType, ProviderHealth } from './types';
import { getDb } from './db';
import { registry } from './registry';
import { inferFailureTypeFromError } from './adapters/base';
import {
  CIRCUIT_HALF_OPEN_AFTER_MS,
  CIRCUIT_OPEN_THRESHOLD,
  HEALTH_CHECK_INTERVAL_MS,
  QUARANTINE_DURATION_MS,
} from './health-policy';
import { recordCooldown } from './limits';

// ─── State management ─────────────────────────────────────────────────────────

export function recordSuccess(providerId: string, latencyMs: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO provider_health (provider_id, healthy, last_check_at, latency_ms, consecutive_failures, circuit_open, cooldown_until)
    VALUES (?, 1, ?, ?, 0, 0, NULL)
    ON CONFLICT(provider_id) DO UPDATE SET
      healthy = 1,
      last_check_at = excluded.last_check_at,
      latency_ms = (latency_ms * 7 + excluded.latency_ms) / 8,
      consecutive_failures = 0,
      circuit_open = 0,
      cooldown_until = NULL,
      quarantine_until = NULL,
      last_failure_type = NULL,
      last_error = NULL
  `).run(providerId, Date.now(), latencyMs);
}

    export function recordFailure(providerId: string, error: string, errorType: FailureType): void {
  const db = getDb();

  const current = db.prepare('SELECT consecutive_failures, circuit_open FROM provider_health WHERE provider_id = ?').get(providerId) as
    | { consecutive_failures: number; circuit_open: number }
    | undefined;

  const prevFailures = current?.consecutive_failures ?? 0;
  const newFailures = prevFailures + 1;
  const shouldOpenCircuit = newFailures >= CIRCUIT_OPEN_THRESHOLD;

  // For auth failures, quarantine immediately
  const isAuth = errorType === 'auth_failure';
  const quarantineUntil = isAuth ? Date.now() + QUARANTINE_DURATION_MS : null;

  db.prepare(`
    INSERT INTO provider_health (provider_id, healthy, last_check_at, latency_ms, last_error, last_failure_type, consecutive_failures, circuit_open, cooldown_until, quarantine_until)
    VALUES (?, 0, ?, 0, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      healthy = 0,
      last_check_at = excluded.last_check_at,
      last_error = excluded.last_error,
      last_failure_type = excluded.last_failure_type,
      consecutive_failures = excluded.consecutive_failures,
      circuit_open = excluded.circuit_open,
      quarantine_until = COALESCE(excluded.quarantine_until, quarantine_until)
  `).run(
    providerId, Date.now(), error.slice(0, 500), errorType, newFailures,
    shouldOpenCircuit ? 1 : (current?.circuit_open ?? 0),
    quarantineUntil,
  );
}

export function isCircuitOpen(providerId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT circuit_open, last_check_at FROM provider_health WHERE provider_id = ?').get(providerId) as
    | { circuit_open: number; last_check_at: number }
    | undefined;

  if (!row || row.circuit_open === 0) return false;

  // Check if we should move to half-open
  const timeSinceLastCheck = Date.now() - row.last_check_at;
  if (timeSinceLastCheck >= CIRCUIT_HALF_OPEN_AFTER_MS) {
    // Allow a probe attempt (half-open)
    return false;
  }
  return true;
}

export function isQuarantined(providerId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT quarantine_until FROM provider_health WHERE provider_id = ?').get(providerId) as
    | { quarantine_until: number | null }
    | undefined;
  if (!row?.quarantine_until) return false;
  return row.quarantine_until > Date.now();
}

export function getProviderHealth(providerId: string): ProviderHealth | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM provider_health WHERE provider_id = ?').get(providerId) as
    | {
        provider_id: string;
        healthy: number;
        last_check_at: number;
        latency_ms: number;
        last_error: string | null;
        last_failure_type: FailureType | null;
        consecutive_failures: number;
        circuit_open: number;
        cooldown_until: number | null;
        quarantine_until: number | null;
      }
    | undefined;

  if (!row) return null;

  return {
    providerId: row.provider_id,
    healthy: row.healthy === 1,
    lastCheckAt: row.last_check_at,
    latencyMs: row.latency_ms,
    lastError: row.last_error,
    lastFailureType: row.last_failure_type,
    consecutiveFailures: row.consecutive_failures,
    circuitOpen: row.circuit_open === 1,
    cooldownUntil: row.cooldown_until,
    quarantineUntil: row.quarantine_until,
  };
}

export function getAllProviderHealth(): ProviderHealth[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM provider_health').all() as Array<{
    provider_id: string;
    healthy: number;
    last_check_at: number;
    latency_ms: number;
    last_error: string | null;
    last_failure_type: FailureType | null;
    consecutive_failures: number;
    circuit_open: number;
    cooldown_until: number | null;
    quarantine_until: number | null;
  }>;

  return rows.map(row => ({
    providerId: row.provider_id,
    healthy: row.healthy === 1,
    lastCheckAt: row.last_check_at,
    latencyMs: row.latency_ms,
    lastError: row.last_error,
    lastFailureType: row.last_failure_type,
    consecutiveFailures: row.consecutive_failures,
    circuitOpen: row.circuit_open === 1,
    cooldownUntil: row.cooldown_until,
    quarantineUntil: row.quarantine_until,
  }));
}

// ─── Routing availability ─────────────────────────────────────────────────────
export function isProviderRoutable(providerId: string): boolean {
  if (isCircuitOpen(providerId)) return false;
  if (isQuarantined(providerId)) return false;

  const db = getDb();
  const row = db.prepare('SELECT cooldown_until FROM provider_health WHERE provider_id = ?').get(providerId) as
    | { cooldown_until: number | null }
    | undefined;

  if (row?.cooldown_until && row.cooldown_until > Date.now()) return false;

  return true;
}

// ─── Latency score (lower latency = higher score) ────────────────────────────
export function getLatencyScore(providerId: string): number {
  const health = getProviderHealth(providerId);
  if (!health || health.latencyMs === 0) return 0.5; // Unknown: neutral
  // Normalize: 100ms = 1.0, 2000ms = 0.0
  const score = Math.max(0, 1 - (health.latencyMs - 100) / 1900);
  return Math.min(1, score);
}

// ─── Background health check worker ──────────────────────────────────────────
let _healthTimer: NodeJS.Timeout | null = null;

export function startHealthCheckWorker(): void {
  if (_healthTimer) return;

  const runChecks = async () => {
    const adapters = registry.getReadyAdapters();
    for (const adapter of adapters) {
      try {
        const result = await adapter.healthCheck();
        if (result.healthy) {
          recordSuccess(adapter.providerId, result.latencyMs);
        } else {
          const error = result.error ?? 'health check failed';
          const failureType = result.failureType ?? inferFailureTypeFromError(error);
          recordFailure(adapter.providerId, error, failureType);
          if (failureType === 'rate_limit' || failureType === 'quota_exhausted') {
            recordCooldown(adapter.providerId, HEALTH_CHECK_INTERVAL_MS);
          }
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const failureType = adapter.classifyFailure(e);
        recordFailure(adapter.providerId, error, failureType);
        if (failureType === 'rate_limit' || failureType === 'quota_exhausted') {
          recordCooldown(adapter.providerId, HEALTH_CHECK_INTERVAL_MS);
        }
      }
    }
  };

  // Run immediately, then on interval
  runChecks().catch(() => {});
  _healthTimer = setInterval(() => runChecks().catch(() => {}), HEALTH_CHECK_INTERVAL_MS);
  _healthTimer.unref(); // Don't prevent process exit
}

export function stopHealthCheckWorker(): void {
  if (_healthTimer) {
    clearInterval(_healthTimer);
    _healthTimer = null;
  }
}

// ─── Manual force-clear a circuit ─────────────────────────────────────────────
export function resetProviderHealth(providerId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE provider_health SET
      healthy = 1,
      consecutive_failures = 0,
      circuit_open = 0,
      cooldown_until = NULL,
      quarantine_until = NULL,
      last_failure_type = NULL,
      last_error = NULL
    WHERE provider_id = ?
  `).run(providerId);
}

// ─── Jittered exponential backoff ────────────────────────────────────────────
export function calcBackoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const exp = Math.min(attempt, 8);
  const base = Math.min(baseMs * Math.pow(2, exp), maxMs);
  // Add ±20% jitter
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

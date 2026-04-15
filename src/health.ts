/**
 * Health and stability engine.
 *
 * - Circuit breaker state machine (CLOSED → OPEN → HALF_OPEN → CLOSED)
 * - Background health checks
 * - Quarantine windows
 * - Latency scoring
 */

import type { FailureType, ModelHealth, ProviderHealth } from './types';
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

export type RoutingFailureScope = 'provider' | 'model';

interface HealthRow {
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

interface HealthRecord extends HealthRow {
  provider_id: string;
  model_id?: string;
}

function shouldOpenProviderCircuit(errorType: FailureType): boolean {
  return errorType === 'auth_failure'
    || errorType === 'timeout'
    || errorType === 'server_error'
    || errorType === 'network_error';
}

function shouldOpenModelCircuit(errorType: FailureType): boolean {
  return errorType === 'timeout'
    || errorType === 'server_error'
    || errorType === 'network_error'
    || errorType === 'unknown';
}

function looksPersistentFailure(error: string, errorType: FailureType): boolean {
  const haystack = error.toLowerCase();
  if (errorType === 'auth_failure') return true;
  if (errorType === 'content_filter' || errorType === 'context_too_long') return false;

  return haystack.includes('404')
    || haystack.includes('not found')
    || haystack.includes('unsupported')
    || haystack.includes('invalid model')
    || haystack.includes('unknown model')
    || haystack.includes('does not exist')
    || haystack.includes('permission denied')
    || haystack.includes('forbidden')
    || haystack.includes('compatibility');
}

function getQuarantineUntil(
  currentUntil: number | null | undefined,
  error: string,
  errorType: FailureType,
  newFailures: number,
): number | null {
  if (errorType === 'auth_failure') {
    return Math.max(currentUntil ?? 0, Date.now() + QUARANTINE_DURATION_MS);
  }

  if (!looksPersistentFailure(error, errorType) && !(errorType === 'unknown' && newFailures >= 3)) {
    return currentUntil ?? null;
  }

  const multiplier = errorType === 'unknown' && newFailures >= 5 ? 2 : 1;
  return Math.max(currentUntil ?? 0, Date.now() + QUARANTINE_DURATION_MS * multiplier);
}

function getProviderHealthRow(providerId: string): HealthRow | undefined {
  const db = getDb();
  return db.prepare('SELECT healthy, last_check_at, latency_ms, last_error, last_failure_type, consecutive_failures, circuit_open, cooldown_until, quarantine_until FROM provider_health WHERE provider_id = ?').get(providerId) as HealthRow | undefined;
}

function getModelHealthRow(providerId: string, modelId: string): HealthRow | undefined {
  const db = getDb();
  return db.prepare('SELECT healthy, last_check_at, latency_ms, last_error, last_failure_type, consecutive_failures, circuit_open, cooldown_until, quarantine_until FROM model_health WHERE provider_id = ? AND model_id = ?').get(providerId, modelId) as HealthRow | undefined;
}

function isCircuitEffectivelyOpen(row: Pick<HealthRow, 'circuit_open' | 'last_check_at'> | undefined): boolean {
  if (!row || row.circuit_open === 0) return false;
  const timeSinceLastCheck = Date.now() - row.last_check_at;
  return timeSinceLastCheck < CIRCUIT_HALF_OPEN_AFTER_MS;
}

function isUntilActive(until: number | null | undefined): boolean {
  return !!until && until > Date.now();
}

function getRoutingBlockReason(row: Pick<HealthRow, 'circuit_open' | 'last_check_at' | 'quarantine_until' | 'cooldown_until'> | undefined): 'circuit_open' | 'quarantined' | 'cooling_down' | null {
  if (!row) return null;
  if (isCircuitEffectivelyOpen(row)) return 'circuit_open';
  if (isUntilActive(row.quarantine_until)) return 'quarantined';
  if (isUntilActive(row.cooldown_until)) return 'cooling_down';
  return null;
}

export function getFailureScope(errorType: FailureType): RoutingFailureScope {
  switch (errorType) {
    case 'auth_failure':
    case 'timeout':
    case 'server_error':
    case 'network_error':
      return 'provider';
    default:
      return 'model';
  }
}

export function recordProviderSuccess(providerId: string, latencyMs: number): void {
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

export function recordModelSuccess(providerId: string, modelId: string, latencyMs: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO model_health (provider_id, model_id, healthy, last_check_at, latency_ms, consecutive_failures, circuit_open, cooldown_until)
    VALUES (?, ?, 1, ?, ?, 0, 0, NULL)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      healthy = 1,
      last_check_at = excluded.last_check_at,
      latency_ms = (latency_ms * 7 + excluded.latency_ms) / 8,
      consecutive_failures = 0,
      circuit_open = 0,
      cooldown_until = NULL,
      quarantine_until = NULL,
      last_failure_type = NULL,
      last_error = NULL
  `).run(providerId, modelId, Date.now(), latencyMs);
}

export function recordSuccess(providerId: string, latencyMs: number): void {
  recordProviderSuccess(providerId, latencyMs);
}

export function recordProviderFailure(providerId: string, error: string, errorType: FailureType): void {
  const db = getDb();

  const current = getProviderHealthRow(providerId);

  const prevFailures = current?.consecutive_failures ?? 0;
  const newFailures = prevFailures + 1;
  const shouldOpenCircuit = shouldOpenProviderCircuit(errorType) && newFailures >= CIRCUIT_OPEN_THRESHOLD;
  const quarantineUntil = getQuarantineUntil(current?.quarantine_until, error, errorType, newFailures);

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

export function recordModelFailure(providerId: string, modelId: string, error: string, errorType: FailureType): void {
  const db = getDb();
  const current = getModelHealthRow(providerId, modelId);

  const prevFailures = current?.consecutive_failures ?? 0;
  const newFailures = prevFailures + 1;
  const shouldOpenCircuit = shouldOpenModelCircuit(errorType) && newFailures >= CIRCUIT_OPEN_THRESHOLD;
  const quarantineUntil = getQuarantineUntil(current?.quarantine_until, error, errorType, newFailures);

  db.prepare(`
    INSERT INTO model_health (provider_id, model_id, healthy, last_check_at, latency_ms, last_error, last_failure_type, consecutive_failures, circuit_open, cooldown_until, quarantine_until)
    VALUES (?, ?, 0, ?, 0, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      healthy = 0,
      last_check_at = excluded.last_check_at,
      last_error = excluded.last_error,
      last_failure_type = excluded.last_failure_type,
      consecutive_failures = excluded.consecutive_failures,
      circuit_open = excluded.circuit_open,
      quarantine_until = COALESCE(excluded.quarantine_until, quarantine_until)
  `).run(
    providerId,
    modelId,
    Date.now(),
    error.slice(0, 500),
    errorType,
    newFailures,
    shouldOpenCircuit ? 1 : (current?.circuit_open ?? 0),
    quarantineUntil,
  );
}

export function recordFailure(providerId: string, error: string, errorType: FailureType): void {
  recordProviderFailure(providerId, error, errorType);
}

export function recordModelCooldown(providerId: string, modelId: string, durationMs: number): void {
  const db = getDb();
  const until = Date.now() + durationMs;
  db.prepare(`
    INSERT INTO model_health (provider_id, model_id, healthy, last_check_at, latency_ms, consecutive_failures, circuit_open, cooldown_until)
    VALUES (?, ?, 0, ?, 0, 1, 0, ?)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      healthy = 0,
      consecutive_failures = consecutive_failures + 1,
      cooldown_until = CASE
        WHEN cooldown_until IS NULL THEN excluded.cooldown_until
        ELSE MAX(cooldown_until, excluded.cooldown_until)
      END
  `).run(providerId, modelId, Date.now(), until);
}

export function isCircuitOpen(providerId: string): boolean {
  return isCircuitEffectivelyOpen(getProviderHealthRow(providerId));
}

export function isQuarantined(providerId: string): boolean {
  const row = getProviderHealthRow(providerId);
  return isUntilActive(row?.quarantine_until);
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

export function getModelHealth(providerId: string, modelId: string): ModelHealth | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM model_health WHERE provider_id = ? AND model_id = ?').get(providerId, modelId) as HealthRecord | undefined;

  if (!row?.model_id) return null;

  return {
    providerId: row.provider_id,
    modelId: row.model_id,
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
  return getProviderRoutingBlockReason(providerId) === null;
}

export function getProviderRoutingBlockReason(providerId: string): 'circuit_open' | 'quarantined' | 'cooling_down' | null {
  return getRoutingBlockReason(getProviderHealthRow(providerId));
}

export function isModelRoutable(providerId: string, modelId: string): boolean {
  return getModelRoutingBlockReason(providerId, modelId) === null;
}

export function getModelRoutingBlockReason(providerId: string, modelId: string): 'circuit_open' | 'quarantined' | 'cooling_down' | null {
  return getRoutingBlockReason(getModelHealthRow(providerId, modelId));
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
          recordProviderSuccess(adapter.providerId, result.latencyMs);
        } else {
          const error = result.error ?? 'health check failed';
          const failureType = result.failureType ?? inferFailureTypeFromError(error);
          recordProviderFailure(adapter.providerId, error, failureType);
          if (failureType === 'rate_limit' || failureType === 'quota_exhausted') {
            recordCooldown(adapter.providerId, HEALTH_CHECK_INTERVAL_MS);
          }
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const failureType = adapter.classifyFailure(e);
        recordProviderFailure(adapter.providerId, error, failureType);
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
  db.prepare('DELETE FROM model_health WHERE provider_id = ?').run(providerId);
}

// ─── Jittered exponential backoff ────────────────────────────────────────────
export function calcBackoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const exp = Math.min(attempt, 8);
  const base = Math.min(baseMs * Math.pow(2, exp), maxMs);
  // Add ±20% jitter
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

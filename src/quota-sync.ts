import type {
  LimitConfidence,
  ProviderQuotaSnapshot,
  QuotaMetricKind,
  QuotaPoolScope,
  QuotaResetPolicy,
  QuotaUsageCoverage,
  QuotaWindowScope,
} from './types';
import { getDb } from './db';

interface StoredProviderQuotaSnapshot {
  id: string;
  providerId: string;
  modelId?: string;
  metricKind: QuotaMetricKind;
  windowScope: QuotaWindowScope;
  limit: number;
  remaining: number;
  resetAt: number | null;
  observedAt: number;
  confidence: LimitConfidence;
  usageCoverage: QuotaUsageCoverage;
  resetPolicy: QuotaResetPolicy;
  poolScope: QuotaPoolScope;
  poolKey: string | null;
  metricLabel: string | null;
  sourceLabel: string | null;
}

const SNAPSHOT_STALE_MS = 15 * 60_000;
const PROVIDER_POOL_PROVIDERS = new Set(['github-models', 'groq', 'sambanova']);

function snapshotId(snapshot: ProviderQuotaSnapshot): string {
  return [
    snapshot.providerId,
    snapshot.modelId ?? '*',
    snapshot.metricKind,
    snapshot.windowScope,
    snapshot.poolScope ?? 'model',
    snapshot.poolKey ?? '*',
  ].join(':');
}

function asHeaderMap(headers: Headers | Record<string, string | undefined>): Record<string, string> {
  const map: Record<string, string> = {};

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      map[key.toLowerCase()] = value;
    });
    return map;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.trim()) {
      map[key.toLowerCase()] = value.trim();
    }
  }

  return map;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function inferWindowScope(
  suffix: '' | '-day' | '-month',
  renewalPeriod: string | undefined,
): QuotaWindowScope {
  if (suffix === '-day') return 'day';
  if (suffix === '-month') return 'month';

  const renewalValue = parsePositiveInt(renewalPeriod);
  if (renewalValue != null) {
    if (renewalValue >= 2_592_000) return 'month';
    if (renewalValue >= 86_400) return 'day';
  }

  return 'minute';
}

function parseDurationMs(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  const simpleNumber = Number(value);
  if (Number.isFinite(simpleNumber)) {
    if (simpleNumber > 1_000_000_000_000) return Math.round(simpleNumber - Date.now());
    if (simpleNumber > 1_000_000_000) return Math.round(simpleNumber * 1000 - Date.now());
    return Math.round(simpleNumber * 1000);
  }

  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (!parts.length) return null;

  let total = 0;
  for (const [, amountRaw, unit] of parts) {
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) return null;
    if (unit === 'ms') total += amount;
    else if (unit === 's') total += amount * 1000;
    else if (unit === 'm') total += amount * 60_000;
    else if (unit === 'h') total += amount * 3_600_000;
    else if (unit === 'd') total += amount * 86_400_000;
  }

  return Math.round(total);
}

function parseResetAt(raw: string | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const deltaMs = parseDurationMs(raw);
  if (deltaMs == null) return null;
  if (deltaMs > 1_000_000_000_000) return deltaMs;
  return now + Math.max(0, deltaMs);
}

function defaultPoolScope(providerId: string, modelId?: string): QuotaPoolScope {
  if (PROVIDER_POOL_PROVIDERS.has(providerId)) return 'provider';
  return modelId ? 'model' : 'provider';
}

function defaultMetricLabel(metricKind: QuotaMetricKind): string {
  if (metricKind === 'tokens') return 'tokens';
  if (metricKind === 'provider_units') return 'provider units';
  return 'requests';
}

function defaultSourceLabel(providerId: string): string {
  return `${providerId} rate-limit headers`;
}

function normalizeSnapshot(snapshot: ProviderQuotaSnapshot): ProviderQuotaSnapshot | null {
  if (!Number.isFinite(snapshot.limit) || snapshot.limit <= 0) return null;
  if (!Number.isFinite(snapshot.remaining) || snapshot.remaining < 0) return null;

  const limit = Math.round(snapshot.limit);
  const remaining = Math.max(0, Math.min(limit, Math.round(snapshot.remaining)));
  const observedAt = snapshot.observedAt ?? Date.now();
  const poolScope = snapshot.poolScope ?? defaultPoolScope(snapshot.providerId, snapshot.modelId);

  return {
    ...snapshot,
    limit,
    remaining,
    observedAt,
    confidence: snapshot.confidence ?? 'official',
    usageCoverage: snapshot.usageCoverage ?? 'provider_synced',
    resetPolicy: snapshot.resetPolicy ?? 'provider_reported',
    poolScope,
    poolKey: snapshot.poolKey ?? (poolScope === 'provider' ? snapshot.providerId : null),
    metricLabel: snapshot.metricLabel ?? defaultMetricLabel(snapshot.metricKind),
    sourceLabel: snapshot.sourceLabel ?? defaultSourceLabel(snapshot.providerId),
  };
}

export function extractProviderQuotaSnapshots(
  providerId: string,
  headers: Headers | Record<string, string | undefined>,
  modelId?: string,
): ProviderQuotaSnapshot[] {
  const headerMap = asHeaderMap(headers);
  const now = Date.now();
  const snapshots: ProviderQuotaSnapshot[] = [];
  const metricKinds: Array<{ metricKind: QuotaMetricKind; headerKey: 'requests' | 'tokens' }> = [
    { metricKind: 'requests', headerKey: 'requests' },
    { metricKind: 'tokens', headerKey: 'tokens' },
  ];
  const suffixes: Array<'' | '-day' | '-month'> = ['', '-day', '-month'];

  for (const { metricKind, headerKey } of metricKinds) {
    for (const suffix of suffixes) {
      const limit = parsePositiveInt(headerMap[`x-ratelimit-limit-${headerKey}${suffix}`]);
      const remaining = parsePositiveInt(headerMap[`x-ratelimit-remaining-${headerKey}${suffix}`]);
      if (limit == null || remaining == null) continue;

      const renewalHeader = headerMap[`x-ratelimit-renewalperiod-${headerKey}${suffix}`];
      const resetHeader = headerMap[`x-ratelimit-reset-${headerKey}${suffix}`];
      const windowScope = inferWindowScope(suffix, renewalHeader);
      const poolScope = defaultPoolScope(providerId, modelId);

      snapshots.push({
        providerId,
        modelId: poolScope === 'model' ? modelId : undefined,
        metricKind,
        windowScope,
        limit,
        remaining,
        resetAt: parseResetAt(resetHeader, now),
        observedAt: now,
        confidence: 'official',
        usageCoverage: 'provider_synced',
        resetPolicy: 'provider_reported',
        poolScope,
        poolKey: poolScope === 'provider' ? providerId : null,
        metricLabel: defaultMetricLabel(metricKind),
        sourceLabel: defaultSourceLabel(providerId),
      });
    }
  }

  const deduped = new Map<string, ProviderQuotaSnapshot>();
  for (const snapshot of snapshots) {
    const normalized = normalizeSnapshot(snapshot);
    if (!normalized) continue;
    deduped.set(`${normalized.metricKind}:${normalized.windowScope}:${normalized.poolKey ?? normalized.modelId ?? '*'}`, normalized);
  }

  return [...deduped.values()];
}

export function recordProviderQuotaSnapshots(snapshots: ProviderQuotaSnapshot[]): void {
  const normalized = snapshots
    .map(normalizeSnapshot)
    .filter((snapshot): snapshot is ProviderQuotaSnapshot => snapshot !== null);

  if (!normalized.length) return;

  const db = getDb();
  db.transaction(() => {
    for (const snapshot of normalized) {
      db.prepare(`
        INSERT INTO provider_quota_snapshots (
          id, provider_id, model_id, metric_kind, window_scope,
          limit_value, remaining_value, reset_at, observed_at,
          confidence, usage_coverage, reset_policy, pool_scope,
          pool_key, metric_label, source_label
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          limit_value = excluded.limit_value,
          remaining_value = excluded.remaining_value,
          reset_at = excluded.reset_at,
          observed_at = excluded.observed_at,
          confidence = excluded.confidence,
          usage_coverage = excluded.usage_coverage,
          reset_policy = excluded.reset_policy,
          pool_scope = excluded.pool_scope,
          pool_key = excluded.pool_key,
          metric_label = excluded.metric_label,
          source_label = excluded.source_label
      `).run(
        snapshotId(snapshot),
        snapshot.providerId,
        snapshot.modelId ?? null,
        snapshot.metricKind,
        snapshot.windowScope,
        snapshot.limit,
        snapshot.remaining,
        snapshot.resetAt ?? null,
        snapshot.observedAt ?? Date.now(),
        snapshot.confidence ?? 'official',
        snapshot.usageCoverage ?? 'provider_synced',
        snapshot.resetPolicy ?? 'provider_reported',
        snapshot.poolScope ?? defaultPoolScope(snapshot.providerId, snapshot.modelId),
        snapshot.poolKey ?? null,
        snapshot.metricLabel ?? defaultMetricLabel(snapshot.metricKind),
        snapshot.sourceLabel ?? defaultSourceLabel(snapshot.providerId),
      );
    }
  })();
}

export function getProviderQuotaSnapshot(params: {
  providerId: string;
  metricKind: QuotaMetricKind;
  windowScope: QuotaWindowScope;
  modelId?: string;
}): StoredProviderQuotaSnapshot | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      id,
      provider_id,
      model_id,
      metric_kind,
      window_scope,
      limit_value,
      remaining_value,
      reset_at,
      observed_at,
      confidence,
      usage_coverage,
      reset_policy,
      pool_scope,
      pool_key,
      metric_label,
      source_label
    FROM provider_quota_snapshots
    WHERE provider_id = ?
      AND metric_kind = ?
      AND window_scope = ?
      AND (model_id IS NULL OR model_id = ?)
    ORDER BY CASE WHEN model_id = ? THEN 0 ELSE 1 END, observed_at DESC
  `).all(
    params.providerId,
    params.metricKind,
    params.windowScope,
    params.modelId ?? null,
    params.modelId ?? null,
  ) as Array<{
    id: string;
    provider_id: string;
    model_id: string | null;
    metric_kind: QuotaMetricKind;
    window_scope: QuotaWindowScope;
    limit_value: number;
    remaining_value: number;
    reset_at: number | null;
    observed_at: number;
    confidence: LimitConfidence;
    usage_coverage: QuotaUsageCoverage;
    reset_policy: QuotaResetPolicy;
    pool_scope: QuotaPoolScope;
    pool_key: string | null;
    metric_label: string | null;
    source_label: string | null;
  }>;

  const now = Date.now();
  const row = rows.find(candidate => {
    if (candidate.reset_at != null && candidate.reset_at <= now) return false;
    if (candidate.reset_at == null && now - candidate.observed_at > SNAPSHOT_STALE_MS) return false;
    return true;
  });

  if (!row) return null;

  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id ?? undefined,
    metricKind: row.metric_kind,
    windowScope: row.window_scope,
    limit: row.limit_value,
    remaining: row.remaining_value,
    resetAt: row.reset_at,
    observedAt: row.observed_at,
    confidence: row.confidence,
    usageCoverage: row.usage_coverage,
    resetPolicy: row.reset_policy,
    poolScope: row.pool_scope,
    poolKey: row.pool_key,
    metricLabel: row.metric_label,
    sourceLabel: row.source_label,
  };
}

export function cleanExpiredQuotaSnapshots(): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    DELETE FROM provider_quota_snapshots
    WHERE (reset_at IS NOT NULL AND reset_at < ?)
       OR (reset_at IS NULL AND observed_at < ?)
  `).run(now - 86_400_000, now - 30 * 86_400_000);
}
/**
 * Limit and quota tracking engine.
 *
 * Maintains fixed-window counters (minute, day, month) for each provider
 * and model in SQLite. The dashboard uses these counters as hub-local
 * headroom unless a provider later supplies provider-synced quota data.
 */

import type {
  LimitConfidence,
  LimitState,
  LimitWindowType,
  ModelInfo,
  ProviderLimitConfig,
  QualityTier,
  QuotaMetricKind,
  QuotaPoolScope,
  QuotaRemainingKind,
  QuotaResetPolicy,
  QuotaUsageCoverage,
  QuotaWindowScope,
} from './types';
import { getDb } from './db';
import { cleanExpiredQuotaSnapshots, getProviderQuotaSnapshot } from './quota-sync';

const FIXED_WINDOW_MS: Record<Exclude<LimitWindowType, 'monthly'>, number> = {
  rpm: 60_000,
  rpd: 86_400_000,
  tpm: 60_000,
  tpd: 86_400_000,
};

const DISPLAY_WINDOW_ORDER: LimitWindowType[] = ['rpd', 'tpd', 'monthly', 'rpm', 'tpm'];
const TRACKED_WINDOWS: LimitWindowType[] = ['rpm', 'rpd', 'tpm', 'tpd', 'monthly'];
const FREE_USAGE_SECTION_ORDER: FreeUsageSectionKey[] = ['official', 'estimated', 'unknown'];
const FREE_USAGE_SERVICE_CLASS_ORDER: FreeUsageServiceClass[] = [
  'strong_chat',
  'fast_chat',
  'vision_chat',
  'embeddings',
  'rerank',
  'specialty',
];

export type FreeUsageSectionKey = 'official' | 'estimated' | 'unknown';
export type FreeUsageServiceClass = 'strong_chat' | 'fast_chat' | 'vision_chat' | 'embeddings' | 'rerank' | 'specialty';

export interface FreeUsageModelSource {
  providerId: string;
  providerName: string;
  defaultLimitConfig?: Partial<ProviderLimitConfig> | null;
  model: ModelInfo;
}

export interface FreeUsageWindowSummary extends LimitState {}

export interface FreeUsageModelSummary {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  qualityTier: QualityTier;
  serviceClass: FreeUsageServiceClass;
  evidence: LimitConfidence | 'unknown';
  usageCoverage: QuotaUsageCoverage;
  remainingKind: QuotaRemainingKind;
  poolScope: QuotaPoolScope | 'unknown';
  poolKey?: string | null;
  capabilityBadges: string[];
  notes: string[];
  primaryWindow: FreeUsageWindowSummary | null;
  windows: FreeUsageWindowSummary[];
}

export interface FreeUsageSectionSummary {
  key: FreeUsageSectionKey;
  label: string;
  description: string;
  serviceCount: number;
  services: FreeUsageModelSummary[];
}

export interface FreeUsageSummaryCard {
  key: string;
  label: string;
  value: number;
  description: string;
}

export interface FreeUsageSummary {
  generatedAt: number;
  serviceCount: number;
  trackedServiceCount: number;
  summaryCards: FreeUsageSummaryCard[];
  sections: FreeUsageSectionSummary[];
}

interface LimitWindowSpec {
  windowType: LimitWindowType;
  windowScope: QuotaWindowScope;
  windowLabel: string;
  metricKind: QuotaMetricKind;
  metricLabel: string;
  limit: number | null | undefined;
}

interface UsageWindowSnapshot {
  used: number;
  windowStart: number;
  windowEnd: number;
  updatedAt: number | null;
}

function getWindowBounds(
  windowType: LimitWindowType,
  resetPolicy: QuotaResetPolicy,
  now = Date.now(),
): { windowStart: number; windowEnd: number } {
  if (windowType === 'monthly') {
    const date = new Date(now);
    const windowStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const windowEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    return { windowStart, windowEnd };
  }

  const windowMs = FIXED_WINDOW_MS[windowType];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  return {
    windowStart,
    windowEnd: windowStart + windowMs,
  };
}

function getDefaultResetPolicy(windowType: LimitWindowType): QuotaResetPolicy {
  if (windowType === 'rpd' || windowType === 'tpd' || windowType === 'monthly') return 'calendar';
  return 'rolling';
}

function getLimitWindowSpecs(limitConfig: Partial<ProviderLimitConfig>): LimitWindowSpec[] {
  const makeSpec = (spec: LimitWindowSpec): LimitWindowSpec => spec;
  const specs: LimitWindowSpec[] = [
    makeSpec({
      windowType: 'rpm',
      windowScope: 'minute',
      windowLabel: 'minute',
      metricKind: 'requests',
      metricLabel: 'requests',
      limit: limitConfig.rpm,
    }),
    makeSpec({
      windowType: 'rpd',
      windowScope: 'day',
      windowLabel: 'day',
      metricKind: 'requests',
      metricLabel: 'requests',
      limit: limitConfig.rpd,
    }),
    makeSpec({
      windowType: 'tpm',
      windowScope: 'minute',
      windowLabel: 'minute',
      metricKind: 'tokens',
      metricLabel: 'tokens',
      limit: limitConfig.tpm,
    }),
    makeSpec({
      windowType: 'tpd',
      windowScope: 'day',
      windowLabel: 'day',
      metricKind: 'tokens',
      metricLabel: 'tokens',
      limit: limitConfig.tpd,
    }),
    makeSpec({
      windowType: 'monthly',
      windowScope: 'month',
      windowLabel: 'month',
      metricKind: 'requests',
      metricLabel: 'requests',
      limit: limitConfig.monthlyRequests,
    }),
    makeSpec({
      windowType: 'monthly',
      windowScope: 'month',
      windowLabel: 'month',
      metricKind: 'tokens',
      metricLabel: 'tokens',
      limit: limitConfig.monthlyTokens,
    }),
    makeSpec({
      windowType: 'rpm',
      windowScope: 'minute',
      windowLabel: 'minute',
      metricKind: 'provider_units',
      metricLabel: limitConfig.providerUnitLabel ?? 'provider units',
      limit: limitConfig.providerUnitsPerMinute,
    }),
    makeSpec({
      windowType: 'rpd',
      windowScope: 'day',
      windowLabel: 'day',
      metricKind: 'provider_units',
      metricLabel: limitConfig.providerUnitLabel ?? 'provider units',
      limit: limitConfig.providerUnitsPerDay,
    }),
    makeSpec({
      windowType: 'monthly',
      windowScope: 'month',
      windowLabel: 'month',
      metricKind: 'provider_units',
      metricLabel: limitConfig.providerUnitLabel ?? 'provider units',
      limit: limitConfig.monthlyProviderUnits,
    }),
  ];

  return specs.filter(spec => typeof spec.limit === 'number' && spec.limit > 0);
}
function getPoolScope(limitConfig: Partial<ProviderLimitConfig>): QuotaPoolScope {
  return limitConfig.poolScope ?? 'model';
}

function getUsageCoverage(
  limitConfig: Partial<ProviderLimitConfig>,
): QuotaUsageCoverage {
  return limitConfig.usageCoverage ?? 'hub_only';
}

function getRemainingKind(
  confidence: LimitConfidence,
  usageCoverage: QuotaUsageCoverage,
): QuotaRemainingKind {
  if (usageCoverage === 'unknown') return 'unknown';
  if (usageCoverage === 'provider_synced') {
    return confidence === 'official' ? 'exact' : 'estimate';
  }
  if (usageCoverage === 'hub_only' || usageCoverage === 'partial') {
    return confidence === 'official' ? 'hub_headroom' : 'estimate';
  }
  return 'unknown';
}

function getScopedModelId(
  limitConfig: Partial<ProviderLimitConfig>,
  modelId?: string,
): string | undefined {
  const poolScope = getPoolScope(limitConfig);
  if (poolScope === 'provider' || poolScope === 'shared') return undefined;
  return modelId;
}

function getMetricValue(
  row: { request_count: number; token_count: number; provider_unit_count: number } | undefined,
  metricKind: QuotaMetricKind,
): number {
  if (!row) return 0;
  switch (metricKind) {
    case 'tokens':
      return row.token_count;
    case 'provider_units':
      return row.provider_unit_count;
    default:
      return row.request_count;
  }
}

function getWindowTypeForState(metricKind: QuotaMetricKind, windowScope: QuotaWindowScope): LimitWindowType {
  if (windowScope === 'month') return 'monthly';
  if (windowScope === 'day') return metricKind === 'tokens' ? 'tpd' : 'rpd';
  return metricKind === 'tokens' ? 'tpm' : 'rpm';
}

function buildSnapshotBackedState(params: {
  snapshot: {
    modelId?: string;
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
  };
  providerId: string;
  metricKind: QuotaMetricKind;
  windowScope: QuotaWindowScope;
  windowLabel: string;
}): LimitState {
  const { snapshot, providerId, metricKind, windowScope, windowLabel } = params;
  const used = Math.max(0, snapshot.limit - snapshot.remaining);
  const pctUsed = snapshot.limit > 0 ? Math.min(100, Math.round((used / snapshot.limit) * 100)) : 0;
  const remainingPct = snapshot.limit > 0 ? Math.max(0, Math.round((snapshot.remaining / snapshot.limit) * 100)) : 0;

  return {
    providerId,
    modelId: snapshot.modelId,
    windowType: getWindowTypeForState(metricKind, windowScope),
    windowScope,
    windowLabel,
    metricKind,
    metricLabel: snapshot.metricLabel ?? (metricKind === 'tokens' ? 'tokens' : metricKind === 'provider_units' ? 'provider units' : 'requests'),
    used,
    limit: snapshot.limit,
    remaining: snapshot.remaining,
    remainingPct,
    confidence: snapshot.confidence,
    usageCoverage: snapshot.usageCoverage,
    remainingKind: getRemainingKind(snapshot.confidence, snapshot.usageCoverage),
    resetPolicy: snapshot.resetPolicy,
    poolScope: snapshot.poolScope,
    poolKey: snapshot.poolKey,
    sourceLabel: snapshot.sourceLabel ?? 'Provider-reported quota',
    freshnessMs: Math.max(0, Date.now() - snapshot.observedAt),
    exhausted: pctUsed >= 98,
    resetAt: snapshot.resetAt,
    pctUsed,
    warnAt70: pctUsed >= 70,
    warnAt85: pctUsed >= 85,
    warnAt95: pctUsed >= 95,
  };
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Record usage Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export function recordUsage(params: {
  providerId: string;
  modelId?: string;
  promptTokens: number;
  completionTokens: number;
  providerUnits?: number;
}): void {
  const { providerId, modelId, promptTokens, completionTokens, providerUnits = 0 } = params;
  const totalTokens = promptTokens + completionTokens;
  const now = Date.now();
  const db = getDb();
  const targetModelIds = modelId ? [undefined, modelId] : [undefined];

  db.transaction(() => {
    for (const targetModelId of targetModelIds) {
      for (const windowType of TRACKED_WINDOWS) {
        const { windowStart } = getWindowBounds(windowType, getDefaultResetPolicy(windowType), now);
        const id = `${providerId}:${targetModelId ?? '*'}:${windowType}:${windowStart}`;

        db.prepare(`
          INSERT INTO usage_windows (
            id, provider_id, model_id, window_type, window_start,
            request_count, token_count, provider_unit_count, updated
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            request_count = request_count + excluded.request_count,
            token_count = token_count + excluded.token_count,
            provider_unit_count = provider_unit_count + excluded.provider_unit_count,
            updated = excluded.updated
        `).run(
          id,
          providerId,
          targetModelId ?? null,
          windowType,
          windowStart,
          1,
          totalTokens,
          providerUnits,
          now,
        );
      }
    }
  })();
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Get current window usage Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export function getCurrentUsage(
  providerId: string,
  metricKind: QuotaMetricKind,
  windowType: LimitWindowType,
  modelId?: string,
  resetPolicy?: QuotaResetPolicy,
): UsageWindowSnapshot {
  const db = getDb();
  const now = Date.now();
  const effectiveResetPolicy = resetPolicy ?? getDefaultResetPolicy(windowType);
  const { windowStart, windowEnd } = getWindowBounds(windowType, effectiveResetPolicy, now);
  const id = `${providerId}:${modelId ?? '*'}:${windowType}:${windowStart}`;

  const row = db.prepare(
    'SELECT request_count, token_count, provider_unit_count, updated FROM usage_windows WHERE id = ?'
  ).get(id) as
    | { request_count: number; token_count: number; provider_unit_count: number; updated: number }
    | undefined;

  return {
    used: getMetricValue(row, metricKind),
    windowStart,
    windowEnd,
    updatedAt: row?.updated ?? null,
  };
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Check if a provider is available (not exhausted, not cooling down) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export function isProviderAvailable(providerId: string, model?: ModelInfo): boolean {
  if (!model?.limitConfig) return true;

  const states = getProviderLimitStates(providerId, model.limitConfig, model.id);
  for (const state of states) {
    if (state.limit > 0 && state.pctUsed >= 98) return false;
  }

  return true;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Get limit states for a provider Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export function getProviderLimitStates(
  providerId: string,
  limitConfig: Partial<ProviderLimitConfig>,
  modelId?: string,
): LimitState[] {
  const states: LimitState[] = [];
  const confidence: LimitConfidence = limitConfig.confidence ?? 'inferred';
  const usageCoverage = getUsageCoverage(limitConfig);
  const remainingKind = getRemainingKind(confidence, usageCoverage);
  const poolScope = getPoolScope(limitConfig);
  const scopedModelId = getScopedModelId(limitConfig, modelId);
  const poolKey = limitConfig.poolKey ?? null;

  for (const spec of getLimitWindowSpecs(limitConfig)) {
    const snapshot = getProviderQuotaSnapshot({
      providerId,
      metricKind: spec.metricKind,
      windowScope: spec.windowScope,
      modelId: scopedModelId,
    });
    if (snapshot) {
      states.push(buildSnapshotBackedState({
        snapshot,
        providerId,
        metricKind: spec.metricKind,
        windowScope: spec.windowScope,
        windowLabel: spec.windowLabel,
      }));
      continue;
    }

    const resetPolicy = limitConfig.resetPolicy ?? getDefaultResetPolicy(spec.windowType);
    const { used, windowEnd, updatedAt } = getCurrentUsage(
      providerId,
      spec.metricKind,
      spec.windowType,
      scopedModelId,
      resetPolicy,
    );
    const limit = spec.limit as number;
    const pctUsed = Math.min(100, Math.round((used / limit) * 100));
    const remaining = Math.max(0, limit - used);
    const remainingPct = limit > 0 ? Math.max(0, Math.round((remaining / limit) * 100)) : 0;

    states.push({
      providerId,
      modelId: scopedModelId,
      windowType: spec.windowType,
      windowScope: spec.windowScope,
      windowLabel: spec.windowLabel,
      metricKind: spec.metricKind,
      metricLabel: spec.metricLabel,
      used,
      limit,
      remaining,
      remainingPct,
      confidence,
      usageCoverage,
      remainingKind,
      resetPolicy,
      poolScope,
      poolKey,
      sourceLabel: limitConfig.sourceLabel ?? (usageCoverage === 'provider_synced' ? 'Provider-reported quota' : 'Hub sliding-window counter'),
      freshnessMs: updatedAt ? Math.max(0, Date.now() - updatedAt) : null,
      exhausted: pctUsed >= 98,
      resetAt: windowEnd,
      pctUsed,
      warnAt70: pctUsed >= 70,
      warnAt85: pctUsed >= 85,
      warnAt95: pctUsed >= 95,
    });
  }

  return states;
}

export function buildFreeUsageSummary(sources: FreeUsageModelSource[]): FreeUsageSummary {
  const sections = new Map<FreeUsageSectionKey, FreeUsageModelSummary[]>([
    ['official', []],
    ['estimated', []],
    ['unknown', []],
  ]);

  for (const source of sources) {
    const { providerId, providerName, model, defaultLimitConfig } = source;

    if (providerId === 'local') continue;
    if (!model.isFree) continue;

    const limitConfig = model.limitConfig ?? defaultLimitConfig ?? undefined;
    const windows = limitConfig && hasQuotaWindows(limitConfig)
      ? getProviderLimitStates(providerId, limitConfig, model.id).sort(compareLimitStates)
      : [];
    const primaryWindow = windows[0] ?? null;
    const evidence: LimitConfidence | 'unknown' = primaryWindow?.confidence ?? limitConfig?.confidence ?? 'unknown';
    const sectionKey: FreeUsageSectionKey = !windows.length
      ? 'unknown'
      : evidence === 'official'
        ? 'official'
        : 'estimated';

    sections.get(sectionKey)?.push({
      providerId,
      providerName,
      modelId: model.id,
      modelName: model.name,
      qualityTier: model.qualityTier,
      serviceClass: getFreeUsageServiceClass(model),
      evidence,
      usageCoverage: primaryWindow?.usageCoverage ?? 'unknown',
      remainingKind: primaryWindow?.remainingKind ?? 'unknown',
      poolScope: primaryWindow?.poolScope ?? 'unknown',
      poolKey: primaryWindow?.poolKey ?? null,
      capabilityBadges: getCapabilityBadges(model),
      notes: buildFreeUsageNotes(model, primaryWindow),
      primaryWindow,
      windows,
    });
  }

  const sectionSummaries = FREE_USAGE_SECTION_ORDER.map(key => buildFreeUsageSection(key, sections.get(key) ?? []));
  const allServices = sectionSummaries.flatMap(section => section.services);
  const trackedServiceCount = allServices.filter(service => service.windows.length > 0).length;
  const strongChatCount = allServices.filter(service => service.serviceClass === 'strong_chat').length;
  const fastChatCount = allServices.filter(service => service.serviceClass === 'fast_chat').length;
  const unknownCount = sectionSummaries.find(section => section.key === 'unknown')?.serviceCount ?? 0;
  const estimatedCount = sectionSummaries.find(section => section.key === 'estimated')?.serviceCount ?? 0;

  return {
    generatedAt: Date.now(),
    serviceCount: allServices.length,
    trackedServiceCount,
    summaryCards: [
      {
        key: 'strong-chat',
        label: 'Strong Chat',
        value: strongChatCount,
        description: 'Higher-end free chat and code lanes kept visible on the board.',
      },
      {
        key: 'fast-chat',
        label: 'Fast Chat',
        value: fastChatCount,
        description: 'Smaller or faster free chat lanes that still have visible headroom.',
      },
      {
        key: 'estimated',
        label: 'Estimated Limits',
        value: estimatedCount,
        description: 'Observed or inferred ceilings. Treat remaining values as guidance.',
      },
      {
        key: 'unknown',
        label: 'No Quota Data',
        value: unknownCount,
        description: 'Free services detected without a configured quota window yet.',
      },
    ],
    sections: sectionSummaries,
  };
}

function hasQuotaWindows(limitConfig: Partial<ProviderLimitConfig>): boolean {
  return getLimitWindowSpecs(limitConfig).length > 0;
}

function getFreeUsageServiceClass(model: ModelInfo): FreeUsageServiceClass {
  if (model.capabilities.embeddings && !model.capabilities.chat) return 'embeddings';
  if (model.capabilities.rerank && !model.capabilities.chat) return 'rerank';
  if (model.capabilities.vision && model.capabilities.chat) return 'vision_chat';
  if (model.qualityTier === 'tier_free_fast') return 'fast_chat';
  if (
    model.qualityTier === 'tier_free_strong'
    || model.qualityTier === 'tier_free_long_context'
    || model.qualityTier === 'tier_code_strong'
  ) {
    return 'strong_chat';
  }
  return 'specialty';
}

function getCapabilityBadges(model: ModelInfo): string[] {
  const badges: string[] = [];
  const serviceClass = getFreeUsageServiceClass(model);

  switch (serviceClass) {
    case 'strong_chat':
      badges.push('strong');
      break;
    case 'fast_chat':
      badges.push('fast');
      break;
    case 'vision_chat':
      badges.push('vision');
      break;
    case 'embeddings':
      badges.push('embeddings');
      break;
    case 'rerank':
      badges.push('rerank');
      break;
    default:
      badges.push('specialty');
      break;
  }

  if (model.capabilities.longContext) badges.push('long context');
  if (model.capabilities.tools) badges.push('tools');
  if (model.capabilities.vision && serviceClass !== 'vision_chat') badges.push('vision');
  return badges;
}

function buildFreeUsageNotes(
  model: ModelInfo,
  primaryWindow: FreeUsageWindowSummary | null,
): string[] {
  const notes: string[] = [];

  if (!primaryWindow) {
    notes.push('No quota window is configured for this service yet.');
  } else {
    if (primaryWindow.remainingKind === 'hub_headroom') {
      notes.push('Remaining values reflect hub traffic only, not the full provider account.');
    } else if (primaryWindow.remainingKind === 'estimate') {
      notes.push('Ceilings are observed or inferred rather than provider-documented.');
    } else if (primaryWindow.remainingKind === 'exact') {
      notes.push('Remaining values come from provider-reported quota data.');
    }

    if (primaryWindow.poolScope === 'provider') {
      notes.push('This quota is tracked as a provider-wide pool shared across models.');
    } else if (primaryWindow.poolScope === 'shared') {
      notes.push('This quota is treated as a shared pool rather than a model-specific counter.');
    }
  }

  if (model.capabilities.embeddings && !model.capabilities.chat) {
    notes.push('Use this through the embeddings route rather than the chat route.');
  }
  if (model.capabilities.rerank && !model.capabilities.chat) {
    notes.push('Use this through the rerank route rather than the chat route.');
  }

  return notes;
}

function buildFreeUsageSection(
  key: FreeUsageSectionKey,
  services: FreeUsageModelSummary[],
): FreeUsageSectionSummary {
  const sorted = [...services].sort(compareFreeUsageModels);

  if (key === 'official') {
    return {
      key,
      label: 'Official Ceilings',
      description: 'Provider-documented limits. Remaining values are still headroom unless coverage says provider synced.',
      serviceCount: sorted.length,
      services: sorted,
    };
  }

  if (key === 'estimated') {
    return {
      key,
      label: 'Estimated Ceilings',
      description: 'Observed or inferred limits. Keep them visible, but do not treat them as exact account truth.',
      serviceCount: sorted.length,
      services: sorted,
    };
  }

  return {
    key,
    label: 'No Quota Data',
    description: 'Free services that the hub can see, but cannot yet quantify with a configured window.',
    serviceCount: sorted.length,
    services: sorted,
  };
}

function getWindowTruthRank(window: Pick<FreeUsageWindowSummary, 'remainingKind'>): number {
  switch (window.remainingKind) {
    case 'exact':
      return 0;
    case 'hub_headroom':
      return 1;
    case 'estimate':
      return 2;
    default:
      return 3;
  }
}

function getRemainingRatio(window: Pick<FreeUsageWindowSummary, 'remaining' | 'limit'>): number {
  if (window.limit <= 0) return 1;
  return Math.max(0, Math.min(1, window.remaining / window.limit));
}

function compareLimitStates(a: FreeUsageWindowSummary, b: FreeUsageWindowSummary): number {
  const truthDelta = getWindowTruthRank(a) - getWindowTruthRank(b);
  if (truthDelta !== 0) return truthDelta;

  const ratioDelta = getRemainingRatio(a) - getRemainingRatio(b);
  if (Math.abs(ratioDelta) > 0.000001) return ratioDelta;

  if (a.remainingPct !== b.remainingPct) return a.remainingPct - b.remainingPct;
  if (a.remaining !== b.remaining) return a.remaining - b.remaining;
  return DISPLAY_WINDOW_ORDER.indexOf(a.windowType) - DISPLAY_WINDOW_ORDER.indexOf(b.windowType);
}

function compareFreeUsageModels(a: FreeUsageModelSummary, b: FreeUsageModelSummary): number {
  const aTracked = a.primaryWindow ? 1 : 0;
  const bTracked = b.primaryWindow ? 1 : 0;
  if (aTracked !== bTracked) return bTracked - aTracked;

  const classDelta = FREE_USAGE_SERVICE_CLASS_ORDER.indexOf(a.serviceClass) - FREE_USAGE_SERVICE_CLASS_ORDER.indexOf(b.serviceClass);
  if (classDelta !== 0) return classDelta;

  if (a.primaryWindow && b.primaryWindow) {
    const windowDelta = compareLimitStates(a.primaryWindow, b.primaryWindow);
    if (windowDelta !== 0) return windowDelta;
  }

  if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName);
  return a.modelName.localeCompare(b.modelName);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Mark a cooldown (e.g., after 429 response) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export function recordCooldown(providerId: string, durationMs: number): void {
  const db = getDb();
  const until = Date.now() + durationMs;
  db.prepare(`
    INSERT INTO provider_health (provider_id, healthy, last_check_at, latency_ms, consecutive_failures, circuit_open, cooldown_until)
    VALUES (?, 0, ?, 0, 1, 0, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      healthy = 0,
      consecutive_failures = consecutive_failures + 1,
      cooldown_until = CASE
        WHEN cooldown_until IS NULL THEN excluded.cooldown_until
        ELSE MAX(cooldown_until, excluded.cooldown_until)
      END
  `).run(providerId, Date.now(), until);
}

export function isCoolingDown(providerId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT cooldown_until FROM provider_health WHERE provider_id = ?').get(providerId) as
    | { cooldown_until: number | null }
    | undefined;
  if (!row?.cooldown_until) return false;
  return row.cooldown_until > Date.now();
}

export function getCooldownUntil(providerId: string): number | null {
  const db = getDb();
  const row = db.prepare('SELECT cooldown_until FROM provider_health WHERE provider_id = ?').get(providerId) as
    | { cooldown_until: number | null }
    | undefined;
  const until = row?.cooldown_until;
  if (!until || until <= Date.now()) return null;
  return until;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Warning percentages Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export interface UsageWarning {
  providerId: string;
  modelId?: string;
  windowType: LimitWindowType;
  windowLabel: string;
  metricKind: QuotaMetricKind;
  metricLabel: string;
  poolScope: QuotaPoolScope;
  poolKey?: string | null;
  pctUsed: number;
  used: number;
  limit: number;
  level: 'warn70' | 'warn85' | 'warn95' | 'exhausted';
}

export function getActiveWarnings(
  providerId: string,
  limitConfig: Partial<ProviderLimitConfig>,
  modelId?: string,
): UsageWarning[] {
  return getProviderLimitStates(providerId, limitConfig, modelId)
    .filter(state => state.pctUsed >= 70)
    .map((state) => {
      let level: UsageWarning['level'];
      if (state.pctUsed >= 98) level = 'exhausted';
      else if (state.pctUsed >= 95) level = 'warn95';
      else if (state.pctUsed >= 85) level = 'warn85';
      else level = 'warn70';

      return {
        providerId,
        modelId: state.modelId,
        windowType: state.windowType,
        windowLabel: state.windowLabel,
        metricKind: state.metricKind,
        metricLabel: state.metricLabel,
        poolScope: state.poolScope,
        poolKey: state.poolKey,
        pctUsed: state.pctUsed,
        used: state.used,
        limit: state.limit,
        level,
      };
    });
}

export function cleanExpiredWindows(): void {
  const db = getDb();
  const shortCutoff = Date.now() - 2 * 86_400_000;
  const now = new Date();
  const monthlyCutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1);

  db.prepare(`
    DELETE FROM usage_windows
    WHERE (window_type != 'monthly' AND window_start < ?)
       OR (window_type = 'monthly' AND window_start < ?)
  `).run(shortCutoff, monthlyCutoff);

  cleanExpiredQuotaSnapshots();
}



/**
 * Warning and approval engine.
 *
 * Detects when providers are nearing exhaustion and generates
 * structured warnings with same-tier/lower-tier alternatives.
 * Issues short-lived approval tokens for downgrade confirmation.
 */

import { randomBytes } from 'crypto';
import type { ProviderWarning, WarningLevel, QualityTier } from './types';
import { QUALITY_TIER_RANK } from './types';
import { getDb } from './db';
import { getActiveWarnings, type UsageWarning } from './limits';
import { registry } from './registry';
import { issueApprovalToken } from './secrets';

// ─── Store and retrieve warnings ──────────────────────────────────────────────

function storeWarning(warning: ProviderWarning): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO warnings (id, provider_id, level, message, same_tier_alternatives, lower_tier_alternatives, approval_token, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    warning.id,
    warning.providerId,
    warning.level,
    warning.message,
    JSON.stringify(warning.sameTierAlternatives),
    JSON.stringify(warning.lowerTierAlternatives),
    warning.approvalToken ?? null,
    warning.createdAt,
  );
}

export function getActiveDbWarnings(): ProviderWarning[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM warnings WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50'
  ).all() as Array<{
    id: string;
    provider_id: string;
    level: string;
    message: string;
    same_tier_alternatives: string;
    lower_tier_alternatives: string;
    approval_token: string | null;
    created_at: number;
    resolved_at: number | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    providerId: row.provider_id,
    level: row.level as WarningLevel,
    message: row.message,
    sameTierAlternatives: JSON.parse(row.same_tier_alternatives) as string[],
    lowerTierAlternatives: JSON.parse(row.lower_tier_alternatives) as string[],
    approvalToken: row.approval_token ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  }));
}

export function resolveWarning(warningId: string): void {
  const db = getDb();
  db.prepare('UPDATE warnings SET resolved_at = ? WHERE id = ?').run(Date.now(), warningId);
}

function getWarningTarget(providerId: string, modelId: string, warning: UsageWarning): string {
  if (warning.poolScope === 'provider') {
    return warning.poolKey ? `${providerId} provider pool (${warning.poolKey})` : `${providerId} provider pool`;
  }
  if (warning.poolScope === 'shared') {
    return warning.poolKey ? `${providerId} shared pool (${warning.poolKey})` : `${providerId} shared pool`;
  }
  return `${providerId}/${warning.modelId ?? modelId}`;
}

function getWarningDedupKey(providerId: string, modelId: string, warning: UsageWarning): string {
  if (warning.poolScope === 'provider' || warning.poolScope === 'shared') {
    return [providerId, warning.poolScope, warning.poolKey ?? '*', warning.metricKind, warning.windowType].join(':');
  }

  return [providerId, warning.modelId ?? modelId, warning.metricKind, warning.windowType].join(':');
}

export function formatUsageWarningMessage(providerId: string, modelId: string, warning: UsageWarning): string {
  return `${getWarningTarget(providerId, modelId, warning)} ${warning.metricLabel}/${warning.windowLabel}: ${warning.pctUsed}% used (${warning.used}/${warning.limit})`;
}

// ─── Build warnings for a provider ───────────────────────────────────────────

export async function buildProviderWarnings(
  providerId: string,
  currentQualityTier: QualityTier,
): Promise<ProviderWarning[]> {
  const adapter = registry.getAdapter(providerId);
  if (!adapter) return [];

  const models = await adapter.listModels().catch(() => []);
  const warnings: ProviderWarning[] = [];
  const seenWarningKeys = new Set<string>();

  for (const model of models) {
    if (!model.limitConfig) continue;
    const usageWarnings = getActiveWarnings(providerId, model.limitConfig, model.id);

    for (const uw of usageWarnings) {
      const warningKey = getWarningDedupKey(providerId, model.id, uw);
      if (seenWarningKeys.has(warningKey)) continue;
      seenWarningKeys.add(warningKey);

      const level: WarningLevel =
        uw.level === 'exhausted' ? 'critical' :
        uw.level === 'warn95' ? 'critical' :
        uw.level === 'warn85' ? 'warn' : 'info';

      const { sameTier, lowerTier } = await findAlternatives(currentQualityTier, providerId);

      const approvalToken = level === 'critical' && lowerTier.length > 0
        ? issueApprovalToken(`downgrade:${providerId}:${model.id}`)
        : undefined;

      const warning: ProviderWarning = {
        id: randomBytes(16).toString('hex'),
        providerId,
        level,
        message: formatUsageWarningMessage(providerId, model.id, uw),
        sameTierAlternatives: sameTier,
        lowerTierAlternatives: lowerTier,
        approvalToken,
        createdAt: Date.now(),
      };

      warnings.push(warning);
      storeWarning(warning);
    }
  }

  return warnings;
}

// ─── Find alternative providers ───────────────────────────────────────────────

export async function findAlternatives(
  currentTier: QualityTier,
  excludeProviderId: string,
): Promise<{ sameTier: string[]; lowerTier: string[] }> {
  const sameTier: string[] = [];
  const lowerTier: string[] = [];

  const currentRank = QUALITY_TIER_RANK[currentTier];
  const adapters = registry.getReadyAdapters();

  for (const adapter of adapters) {
    if (adapter.providerId === excludeProviderId) continue;
    const rank = QUALITY_TIER_RANK[adapter.qualityTier];
    if (rank === currentRank) {
      sameTier.push(adapter.providerId);
    } else if (rank < currentRank) {
      lowerTier.push(adapter.providerId);
    }
  }

  return { sameTier, lowerTier };
}

// ─── Downgrade check ─────────────────────────────────────────────────────────

export interface DowngradeCheckResult {
  allowed: boolean;
  requiresApproval: boolean;
  warning?: string;
  approvalToken?: string;
  sameTierAlternatives: string[];
  lowerTierAlternatives: string[];
}

export async function checkDowngrade(
  fromTier: QualityTier,
  toTier: QualityTier,
  fromProviderId: string,
  requestClass: string,
  allowDowngradeWithApproval: boolean,
  requireSameOrBetter: boolean,
): Promise<DowngradeCheckResult> {
  const fromRank = QUALITY_TIER_RANK[fromTier];
  const toRank = QUALITY_TIER_RANK[toTier];

  // Code-related tasks always require explicit approval for any downgrade
  const isCodingTask = requestClass === 'code_generation' || requestClass === 'code_repair';

  const { sameTier, lowerTier } = await findAlternatives(fromTier, fromProviderId);

  if (toRank >= fromRank) {
    // Same or better quality: always allowed
    return { allowed: true, requiresApproval: false, sameTierAlternatives: sameTier, lowerTierAlternatives: lowerTier };
  }

  if (requireSameOrBetter) {
    return {
      allowed: false,
      requiresApproval: false,
      warning: `Quality downgrade from ${fromTier} to ${toTier} is not allowed (require_same_or_better_quality=true)`,
      sameTierAlternatives: sameTier,
      lowerTierAlternatives: lowerTier,
    };
  }

  if (isCodingTask || !allowDowngradeWithApproval) {
    // Coding tasks require explicit approval; other tasks require approval_with_approval flag
    const approvalToken = issueApprovalToken(`downgrade:${fromTier}:${toTier}:${requestClass}`);
    return {
      allowed: false,
      requiresApproval: true,
      warning: `Quality downgrade required for ${requestClass}: ${fromTier} → ${toTier}. Explicit approval needed.`,
      approvalToken,
      sameTierAlternatives: sameTier,
      lowerTierAlternatives: lowerTier,
    };
  }

  return { allowed: true, requiresApproval: false, sameTierAlternatives: sameTier, lowerTierAlternatives: lowerTier };
}

/**
 * Router engine.
 *
 * Classifies requests, selects providers,
 * enforces no-silent-downgrade, handles fallback,
 * and returns normalized results.
 */

import { randomBytes } from 'crypto';
import type {
  RouteRequest,
  RouteResult,
  RequestClass,
  RouteTaskProfile,
  QualityTier,
  RoutingCandidate,
  ModelInfo,
  AdapterRequest,
  AdapterResponse,
  HubModes,
  ProviderLimitConfig,
} from './types';
import { QUALITY_TIER_RANK } from './types';
import { registry } from './registry';
import { getConfig } from './config';
import {
  isProviderRoutable,
  isModelRoutable,
  getProviderRoutingBlockReason,
  getModelRoutingBlockReason,
  getLatencyScore,
  getFailureScope,
  recordProviderSuccess,
  recordProviderFailure,
  recordModelSuccess,
  recordModelFailure,
  recordModelCooldown,
  calcBackoffMs,
} from './health';
import {
  isProviderAvailable,
  recordUsage,
  recordCooldown,
  getProviderLimitStates,
} from './limits';
import { recordProviderQuotaSnapshots } from './quota-sync';
import { getExactCache, setExactCache, getSemanticCache, setSemanticCache, computeCacheKey, CachedResponse } from './cache';
import { checkDowngrade } from './warnings';
import { estimateMessagesTokens } from './adapters/base';
import type { BaseAdapter } from './adapters/base';
import { ProviderError } from './adapters/base';
import { getEffectiveModes } from './modes';

const MAX_HOPS = 5;
const TOKEN_PREFLIGHT_MAX = 100_000; // Hard cap; adjust by provider

// ─── Model aliases ────────────────────────────────────────────────────────────
const ALIAS_PRIORITY_ORDER: Record<string, string[]> = {
  'fast-free':             ['local', 'openrouter', 'groq', 'cloudflare', 'gemini', 'mistral', 'cerebras'],
  'strong-free':           ['groq', 'openrouter', 'local', 'cerebras', 'mistral', 'github-models', 'sambanova', 'gemini'],
  'strong-code':           ['openrouter', 'local', 'github-models', 'mistral', 'copilot', 'fireworks', 'cloudflare'],
  'agent-build':           ['openrouter', 'local', 'github-models', 'gemini', 'mistral', 'groq', 'cloudflare'],
  'strong-long-context':   ['gemini', 'mistral', 'openrouter', 'github-models'],
  'local-fast':            ['local'],
  'local-strong':          ['local'],
  'premium-code':          ['copilot', 'codex'],
  'premium-review':        ['copilot', 'codex'],
  'frontier-manual':       ['codex', 'copilot'],
  'embeddings-fast':       ['local', 'gemini', 'cloudflare', 'cohere'],
  'embeddings-strong':     ['cohere', 'gemini', 'local'],
  'rerank-strong':         ['cohere'],
};

const HUB_MODEL_ALIAS_SET = new Set<string>([
  ...Object.keys(ALIAS_PRIORITY_ORDER),
  'reasoning-free',
]);

function isHubModelAlias(value: string | null | undefined): boolean {
  return !!value && HUB_MODEL_ALIAS_SET.has(value.trim());
}

function normalizeRouteRequest(req: RouteRequest): RouteRequest {
  const normalizedModel = typeof req.model === 'string' ? req.model.trim() : '';
  if (!req.model_alias && isHubModelAlias(normalizedModel)) {
    const { model: _model, ...rest } = req;
    return {
      ...rest,
      model_alias: normalizedModel,
    };
  }

  if (req.model_alias && isHubModelAlias(req.model_alias) && normalizedModel === req.model_alias) {
    const { model: _model, ...rest } = req;
    return rest;
  }

  return req;
}

function resolveMaxProviderHops(req: RouteRequest): number {
  if (typeof req.max_provider_hops !== 'number' || !Number.isFinite(req.max_provider_hops)) {
    return MAX_HOPS;
  }

  const requested = Math.max(1, Math.min(Math.floor(req.max_provider_hops), MAX_HOPS));
  const normalizedModel = typeof req.model === 'string' ? req.model.trim() : '';
  const isPinnedModel = !!normalizedModel && !isHubModelAlias(normalizedModel);
  const isPinnedProvider = typeof req.preferred_provider === 'string' && req.preferred_provider.trim().length > 0;

  if (requested === 1 && !isPinnedModel && !isPinnedProvider) {
    return Math.min(3, MAX_HOPS);
  }

  return requested;
}

interface RouteSkipEntry {
  providerId: string;
  modelId?: string;
  reason: string;
  detail?: string;
  score?: number;
}

type StabilityLevel = 'normal' | 'strict';
type AliasMatchMode = 'exact' | 'broadened' | 'default';

export interface RoutePreviewCandidate {
  providerId: string;
  modelId: string;
  score: number;
  qualityTier: QualityTier;
  isFree: boolean;
  aliases: string[];
  aliasMatch: AliasMatchMode;
  aliasMatchReason?: string;
}

export interface RoutePreview {
  classifiedAs: RequestClass;
  alias: string | null;
  taskProfile: RouteTaskProfile | null;
  stabilityLevel: StabilityLevel;
  effectiveModes: HubModes;
  priorityOrder: string[];
  candidates: RoutePreviewCandidate[];
  skipCounts: Record<string, number>;
  skipped: RouteSkipEntry[];
}

interface CandidateAnalysis {
  candidates: RoutingCandidate[];
  preview: RoutePreview;
}

export class RouteExecutionError extends Error {
  readonly classifiedAs: RequestClass;
  readonly selectedProvider: string | null;
  readonly selectedModel: string | null;
  readonly qualityTier: QualityTier | null;
  readonly fallbackChain: string[];
  readonly preview?: RoutePreview;
  readonly cause?: unknown;

  constructor(message: string, options: {
    classifiedAs: RequestClass;
    selectedProvider?: string | null;
    selectedModel?: string | null;
    qualityTier?: QualityTier | null;
    fallbackChain?: string[];
    preview?: RoutePreview;
    cause?: unknown;
  }) {
    super(message);
    this.name = 'RouteExecutionError';
    this.classifiedAs = options.classifiedAs;
    this.selectedProvider = options.selectedProvider ?? null;
    this.selectedModel = options.selectedModel ?? null;
    this.qualityTier = options.qualityTier ?? null;
    this.fallbackChain = [...(options.fallbackChain ?? [])];
    this.preview = options.preview;
    this.cause = options.cause;
  }
}

function normalizeTaskProfile(value: string | null | undefined): RouteTaskProfile | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'tiny_reply':
    case 'general_chat':
    case 'planning':
    case 'codegen':
    case 'repo_scaffold':
    case 'long_context':
      return normalized;
    default:
      return null;
  }
}

function getRequestedTaskProfile(req: RouteRequest): RouteTaskProfile | null {
  const explicit = normalizeTaskProfile(typeof req.task_profile === 'string' ? req.task_profile : null);
  if (explicit) return explicit;

  const tagMatch = req.request_tags
    ?.map(tag => normalizeTaskProfile(tag))
    .find((tag): tag is RouteTaskProfile => tag !== null);
  return tagMatch ?? null;
}

function mapTaskProfileToRequestClass(taskProfile: RouteTaskProfile): RequestClass {
  switch (taskProfile) {
    case 'tiny_reply':
      return 'tiny_text_utility';
    case 'planning':
      return 'reasoning_heavy';
    case 'codegen':
      return 'code_generation';
    case 'repo_scaffold':
      return 'repo_scaffold';
    case 'long_context':
      return 'long_context';
    case 'general_chat':
    default:
      return 'normal_chat';
  }
}

// ─── Request classifier ───────────────────────────────────────────────────────

export function classifyRequest(req: RouteRequest): RequestClass {
  const text = getRequestText(req).toLowerCase();
  const msgCount = req.messages?.length ?? 0;
  const totalLen = text.length;
  const taskProfile = getRequestedTaskProfile(req);

  // Embeddings / rerank pass-through
  if (req.route_policy === 'embeddings') return 'embeddings';
  if (req.route_policy === 'rerank') return 'rerank';

  // Vision
  if (hasImageContent(req)) return 'vision_text';

  if (taskProfile) return mapTaskProfileToRequestClass(taskProfile);

  // Long context
  const estTokens = estimateMessagesTokens(req.messages ?? []);
  if (estTokens > 30_000) return 'long_context';

  const scaffoldKeywords = /\b(scaffold|boilerplate|starter|from\s+scratch|new\s+(app|project|game|site)|create\s+(an?\s+)?(app|project|game|site)|folder\s+structure|file\s+structure|multi-file|set\s+up|setup|game\s+loop|inventory\s+system|assets|component\s+library|landing\s+page|rpg|platformer|dashboard|crud\s+app)\b/;
  const scaffoldSignals = scaffoldKeywords.test(text)
    || ((req.tools?.length ?? 0) > 0 && totalLen > 300 && /(project|app|game|site|repo|folder|files?)/.test(text));
  if (scaffoldSignals) return 'repo_scaffold';

  // Code patterns
  const codeKeywords = /\b(function|class|interface|import|export|const |let |var |def |async |await |implement|refactor|debug|fix\s+bug|write\s+code|generate\s+code|complete\s+the\s+code|typescript|javascript|python|rust|golang|java|c\+\+|\.ts|\.js|\.py)\b/;
  if (codeKeywords.test(text)) {
    const repairKeywords = /\b(fix|repair|debug|resolve|error|bug|failing|broken|exception|traceback|why\s+(is|does)|what('s|\s+is)\s+wrong)\b/;
    if (repairKeywords.test(text)) return 'code_repair';
    return 'code_generation';
  }

  // Reasoning chains
  const reasoningKeywords = /\b(reason|think\s+step|chain\s+of\s+thought|proof|theorem|mathematically|formally\s+prove|step\s+by\s+step|analyze|evaluate\s+options|compare.*tradeoff)\b/;
  if (reasoningKeywords.test(text)) return 'reasoning_heavy';

  // Structured extraction
  const extractionKeywords = /\b(extract|parse|json|schema|structured\s+output|fill\s+out|return\s+only|format\s+as)\b/;
  if (extractionKeywords.test(text)) return 'structured_extraction';

  // Tiny utility
  if (totalLen < 200 && msgCount <= 2) return 'tiny_text_utility';

  return 'normal_chat';
}

function getRequestText(req: RouteRequest): string {
  if (!req.messages) return req.prompt ?? '';
  return req.messages.map(m => {
    if (typeof m.content === 'string') return m.content ?? '';
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ');
    }
    return '';
  }).join(' ');
}

function hasImageContent(req: RouteRequest): boolean {
  if (!req.messages) return false;
  for (const msg of req.messages) {
    if (Array.isArray(msg.content)) {
      if (msg.content.some(p => p.type === 'image_url')) return true;
    }
  }
  return false;
}

function getRouteCacheScope(req: RouteRequest, requestClass: RequestClass): string {
  return req.model_alias ?? req.model ?? req.task_profile ?? `class:${requestClass}`;
}

function buildRouteCacheAdapterRequest(req: RouteRequest, requestClass: RequestClass): AdapterRequest {
  return buildAdapterRequest(req, getRouteCacheScope(req, requestClass), requestClass);
}

function getSemanticCachePrompt(req: RouteRequest, requestClass: RequestClass): string {
  return `[scope:${getRouteCacheScope(req, requestClass)}]\n${getRequestText(req)}`;
}

// ─── Preflight availability checks ────────────────────────────────────────────

async function checkProviderModelAvailability(
  adapter: BaseAdapter,
  model: ModelInfo,
  timeoutMs: number = 2000,
): Promise<{ available: boolean; reason?: string }> {
  try {
    // Check if provider is responsive within timeout
    const healthCheckPromise = adapter.healthCheck();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Preflight timeout')), timeoutMs);
    });

    const health = await Promise.race([healthCheckPromise, timeoutPromise]);
    
    if (!health.healthy) {
      return { available: false, reason: `Health check failed: ${health.error || 'unhealthy'}` };
    }

    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: `Preflight check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ─── Provider scorer ──────────────────────────────────────────────────────────

function scoreCandidate(
  adapter: BaseAdapter,
  model: ModelInfo,
  requestClass: RequestClass,
  req: RouteRequest,
  alias: string | null,
  aliasMatch: AliasMatchMode,
  priorityOrder: string[],
  modes: HubModes,
): number {
  let score = 0;
  const premiumAliasRequested = alias === 'premium-code'
    || alias === 'premium-review'
    || alias === 'frontier-manual';
  const explicitPaidRequest = premiumAliasRequested
    || req.preferred_provider === adapter.providerId
    || req.model === model.id;

  // 1. Capability match (0–0.3)
  let capScore = 0.15;
  if (requestClass === 'code_generation' || requestClass === 'code_repair') {
    capScore = model.capabilities.tools ? 0.3 : 0.1;
    if (model.qualityTier === 'tier_code_strong') capScore += 0.05;
  }
  if (requestClass === 'vision_text') {
    capScore = model.capabilities.vision ? 0.3 : -0.5; // Penalize non-vision for vision tasks
  }
  if (requestClass === 'long_context') {
    capScore = model.capabilities.longContext ? 0.3 : 0.05;
  }
  if (requestClass === 'embeddings') {
    capScore = model.capabilities.embeddings ? 0.3 : -1;
  }
  if (requestClass === 'rerank') {
    capScore = model.capabilities.rerank ? 0.3 : -1;
  }
  score += capScore;

  // 2. Availability / quota (0–0.3)
  const effectiveLimitConfig = getEffectiveLimitConfig(adapter, model);
  const available = isProviderAvailable(adapter.providerId, { ...model, limitConfig: effectiveLimitConfig });
  score += available ? 0.3 : -0.5;
  score += getQuotaScoreDelta(adapter, model);

  // 3. Quality tier fit (0–0.2)
  const tierRank = QUALITY_TIER_RANK[model.qualityTier];
  const targetRank = getTargetTierRank(requestClass);
  if (tierRank === targetRank) score += 0.2;
  else if (tierRank > targetRank) score += 0.15; // Better quality is ok
  else score += 0.05 * (tierRank / targetRank);

  // 4. Latency score (0–0.1)
  score += getLatencyScore(adapter.providerId) * 0.1;

  // 5. Free-first preference (0–0.1)
  if (model.isFree) score += 0.1;
  else if (modes.freeOnly || req.forbid_paid) score -= 1; // Heavy penalty in free-only mode

  // Keep membership/premium providers as fallback unless the request explicitly asks for them.
  if (!model.isFree && !explicitPaidRequest) score -= 0.25;

  // 6. Priority order position (0–0.1)
  const posIdx = priorityOrder.indexOf(adapter.providerId);
  if (posIdx >= 0) {
    score += (1 - posIdx / Math.max(priorityOrder.length, 1)) * 0.1;
  }

  // 7. Local preference and external provider preference
  if (req.prefer_local && adapter.providerId === 'local') score += 0.2;
  if (req.preferred_provider === adapter.providerId) score += 0.15;

  // External provider preference/bias (Fix 2)
  if (req.prefer_external && adapter.providerId !== 'local') {
    score += 0.2; // Boost external providers
  }
  if (req.prefer_external && adapter.providerId === 'local') {
    score -= 0.15; // Penalize local when external is preferred
  }

  // Exclude local on specific aliases (Fix 2)
  if (req.exclude_local_on_alias?.includes(alias ?? '') && adapter.providerId === 'local') {
    score = Math.min(score, -0.5); // Strong penalty to encourage exclusion
  }

  score += getLaneScoreAdjustment(adapter, model, requestClass, req, alias);

  if (aliasMatch === 'broadened') score -= 0.28;

  return Math.max(-1, Math.min(1, score));
}

function getQuotaScoreDelta(adapter: BaseAdapter, model: ModelInfo): number {
  const effectiveLimitConfig = getEffectiveLimitConfig(adapter, model);
  if (!hasTrackedLimitConfig(effectiveLimitConfig)) return 0;

  const states = getProviderLimitStates(adapter.providerId, effectiveLimitConfig, model.id);
  if (!states.length) return 0;

  const primary = [...states].sort((a, b) => {
    if (a.remainingPct !== b.remainingPct) return a.remainingPct - b.remainingPct;
    if (a.remaining !== b.remaining) return a.remaining - b.remaining;
    return a.windowLabel.localeCompare(b.windowLabel);
  })[0];
  if (!primary) return 0;

  let delta = ((primary.remainingPct / 100) - 0.5) * 0.2;

  if (primary.confidence === 'official') delta += 0.05;
  else if (primary.confidence === 'observed') delta += 0.01;

  if (primary.usageCoverage === 'provider_synced') delta += 0.06;
  else if (primary.usageCoverage === 'partial') delta -= 0.03;
  else if (primary.usageCoverage === 'unknown') delta -= 0.05;

  return Math.max(-0.2, Math.min(0.18, delta));
}

function getRequestedStabilityLevel(req: RouteRequest): StabilityLevel {
  return req.stability_level === 'strict' ? 'strict' : 'normal';
}

function getEffectiveLimitConfig(adapter: BaseAdapter, model: ModelInfo): Partial<ProviderLimitConfig> {
  return {
    ...adapter.defaultLimitConfig,
    ...(model.limitConfig ?? {}),
  };
}

function hasTrackedLimitConfig(limitConfig: Partial<ProviderLimitConfig>): boolean {
  const trackedKeys: Array<keyof ProviderLimitConfig> = [
    'rpm',
    'rpd',
    'tpm',
    'tpd',
    'monthlyRequests',
    'monthlyTokens',
    'providerUnitsPerMinute',
    'providerUnitsPerDay',
    'monthlyProviderUnits',
  ];

  return trackedKeys.some(key => typeof limitConfig[key] === 'number' && (limitConfig[key] as number) > 0);
}

function getRequestedCompletionTokens(req: RouteRequest, model: ModelInfo): number {
  return Math.max(
    0,
    Math.min(
      req.max_tokens ?? Math.min(model.maxOutputTokens || 1024, 2048),
      model.maxOutputTokens || Number.MAX_SAFE_INTEGER,
    ),
  );
}

function getEstimatedPromptTokens(req: RouteRequest): number {
  if (req.messages?.length) return estimateMessagesTokens(req.messages);
  if (req.prompt) return estimateMessagesTokens([{ role: 'user', content: req.prompt }]);
  return 0;
}

function getProjectedRequestTokens(req: RouteRequest, model: ModelInfo): number {
  return getEstimatedPromptTokens(req) + getRequestedCompletionTokens(req, model);
}

function getPrimaryQuotaState(adapter: BaseAdapter, model: ModelInfo) {
  const effectiveLimitConfig = getEffectiveLimitConfig(adapter, model);
  if (!hasTrackedLimitConfig(effectiveLimitConfig)) return null;

  const states = getProviderLimitStates(adapter.providerId, effectiveLimitConfig, model.id);
  if (!states.length) return null;

  return [...states].sort((a, b) => {
    if (a.remainingPct !== b.remainingPct) return a.remainingPct - b.remainingPct;
    if (a.remaining !== b.remaining) return a.remaining - b.remaining;
    return a.windowLabel.localeCompare(b.windowLabel);
  })[0] ?? null;
}

function getLaneScoreAdjustment(
  adapter: BaseAdapter,
  model: ModelInfo,
  requestClass: RequestClass,
  req: RouteRequest,
  alias: string | null,
): number {
  const projectedTokens = getProjectedRequestTokens(req, model);
  const contextWindow = Math.max(1, model.contextWindow || 1);
  const contextRatio = projectedTokens / contextWindow;
  const taskProfile = getRequestedTaskProfile(req);
  const preferToolStability = req.prefer_tool_stability ?? taskProfile === 'repo_scaffold';
  let delta = 0;

  if (contextWindow >= 131_072) delta += 0.08;
  else if (contextWindow >= 65_536) delta += 0.05;
  else if (contextWindow >= 32_768) delta += 0.02;

  if (contextRatio > 0.9) delta -= 0.3;
  else if (contextRatio > 0.75) delta -= 0.18;
  else if (contextRatio > 0.55) delta -= 0.08;

  const modelName = `${model.id} ${model.name}`.toLowerCase();
  const quotaState = getPrimaryQuotaState(adapter, model);

  if (alias === 'agent-build' || requestClass === 'repo_scaffold' || taskProfile === 'planning' || taskProfile === 'repo_scaffold') {
    if (contextWindow >= 131_072) delta += 0.14;
    else if (contextWindow >= 65_536) delta += 0.09;
    else if (contextWindow >= 32_768) delta += 0.04;

    if (model.capabilities.tools) delta += 0.06;
    if (model.capabilities.structuredOutput) delta += 0.03;
    if (model.aliases.includes('strong-free')) delta += 0.08;
    if (model.aliases.includes('local-strong')) delta += 0.08;
    if (model.aliases.includes('strong-long-context')) delta += 0.08;
    if (model.aliases.includes('strong-code')) delta += 0.04;
    if (adapter.providerId === 'local') delta += 0.05;
    if (model.qualityTier === 'tier_free_fast') delta -= 0.18;
    if (contextWindow < 32_768) delta -= 0.2;
    if (projectedTokens > 16_000 && contextWindow < 65_536) delta -= 0.18;
    if (/(coder|codestral|devstral|deepseek-coder|qwen.*coder|codegemma|starcoder|codellama|granite-code)/.test(modelName)) delta -= 0.03;
  }

  if ((alias === 'strong-code' || requestClass === 'code_generation' || requestClass === 'code_repair') && requestClass !== 'repo_scaffold') {
    if (model.qualityTier === 'tier_code_strong') delta += 0.12;
    if (model.aliases.includes('strong-code')) delta += 0.08;
    if (model.capabilities.tools) delta += 0.04;
    if (/(coder|codestral|devstral|deepseek-coder|qwen.*coder|codegemma|starcoder|codellama|granite-code)/.test(modelName)) delta += 0.06;
    if (adapter.providerId === 'local') delta += 0.08;
    if (adapter.providerId === 'mistral') delta -= 0.08;
    if (projectedTokens > 20_000 && contextWindow < 65_536) delta -= 0.25;
    if (projectedTokens > 12_000 && contextWindow < 32_768) delta -= 0.18;
  }

  if (alias === 'strong-free') {
    if (model.qualityTier === 'tier_free_strong' || model.qualityTier === 'tier_free_long_context' || model.qualityTier === 'tier_code_strong') {
      delta += 0.08;
    } else if (model.qualityTier === 'tier_free_fast') {
      delta -= 0.12;
    }

    if (adapter.providerId === 'local') delta += 0.06;
    if (quotaState?.usageCoverage === 'provider_synced' && quotaState.remainingPct >= 20) delta += 0.05;
    if (quotaState?.remainingPct !== undefined && quotaState.remainingPct < 10) delta -= 0.12;
    if (projectedTokens > 18_000 && contextWindow < 65_536) delta -= 0.2;
  }

  if (alias === 'fast-free') {
    if (model.qualityTier === 'tier_free_fast') delta += 0.06;
    if (projectedTokens > 10_000 && contextWindow < 32_768) delta -= 0.3;
    else if (projectedTokens > 6_000 && contextWindow < 16_384) delta -= 0.2;

    if ((req.tools?.length ?? 0) > 0 || requestClass === 'code_generation' || requestClass === 'code_repair') {
      if (model.qualityTier === 'tier_code_strong') delta += 0.1;
      if (model.aliases.includes('strong-code')) delta += 0.08;
      if (model.qualityTier === 'tier_free_strong') delta += 0.04;
    }

    if (projectedTokens > 10_000 && adapter.providerId === 'local') delta += 0.08;
    if (contextWindow >= 65_536 && projectedTokens > 8_000) delta += 0.05;
    if (quotaState?.remainingPct !== undefined && quotaState.remainingPct < 15) delta -= 0.08;
    if (adapter.providerId === 'cerebras' && ((req.tools?.length ?? 0) > 0 || projectedTokens > 6_000)) delta -= 0.35;
  }

  if (requestClass === 'tiny_text_utility') {
    if (model.qualityTier === 'tier_free_fast') delta += 0.08;
    if (model.aliases.includes('fast-free') || model.aliases.includes('local-fast')) delta += 0.06;
    if (model.qualityTier === 'tier_code_strong') delta -= 0.12;
    if (contextWindow >= 131_072) delta -= 0.04;
  }

  if (preferToolStability && !model.capabilities.tools) delta -= 0.3;

  return delta;
}

function getBroadenedAliasTargets(alias: string): string[] {
  switch (alias) {
    case 'agent-build':
      return ['strong-free', 'local-strong', 'strong-code', 'strong-long-context'];
    case 'strong-code':
      return ['strong-free', 'local-strong', 'strong-long-context', 'fast-free'];
    case 'strong-free':
      return ['reasoning-free', 'strong-code', 'local-strong', 'strong-long-context'];
    case 'fast-free':
      return ['local-fast', 'strong-code', 'strong-free', 'local-strong', 'strong-long-context'];
    case 'strong-long-context':
      return ['strong-free', 'local-strong'];
    case 'premium-code':
      return ['strong-code', 'strong-free'];
    case 'premium-review':
      return ['premium-code', 'strong-code', 'strong-free'];
    default:
      return [];
  }
}

function getCandidateBlockReason(req: RouteRequest, requestClass: RequestClass, model: ModelInfo): string | null {
  if (requestClass !== 'embeddings' && requestClass !== 'rerank') {
    if (model.providerId === 'cohere') return 'provider_known_broken';
    if (model.providerId === 'cerebras' && model.id === 'gpt-oss-120b') return 'model_known_broken';
    if (model.providerId === 'mistral' && model.id === 'mistral-small-latest' && (req.tools?.length ?? 0) > 0) {
      return 'model_tool_call_incompatible';
    }
    if (req.model_alias === 'fast-free' && model.providerId === 'cerebras') {
      const projectedTokens = getProjectedRequestTokens(req, model);
      if ((req.tools?.length ?? 0) > 0 || requestClass === 'code_generation' || requestClass === 'code_repair' || projectedTokens > 6_000) {
        return 'provider_lane_unfit';
      }
    }
  }

  return null;
}

function getPreflightSkipReason(
  req: RouteRequest,
  candidate: Pick<RoutingCandidate, 'providerId' | 'model'>,
  limitConfig: Partial<ProviderLimitConfig>,
): string | null {
  const preflight = tokenPreflight(req, candidate as RoutingCandidate, limitConfig);
  if (preflight.ok || !preflight.reason) return null;

  if (preflight.reason.includes('context window')) return 'preflight_context_window';
  if (preflight.reason.includes('remaining') && preflight.reason.includes('token headroom')) return 'preflight_token_headroom';
  if (preflight.reason.includes('quota is exhausted') || preflight.reason.includes('No remaining')) return 'preflight_quota_exhausted';
  if (preflight.reason.includes('max output')) return 'preflight_max_tokens';
  if (preflight.reason.includes('hard cap')) return 'preflight_hard_cap';
  return 'preflight_blocked';
}

function getCooldownMsForFailure(errorType: string, errorMessage: string, attempt: number): number {
  const normalized = errorMessage.toLowerCase();
  if (errorType === 'rate_limit' || errorType === 'quota_exhausted') {
    if (
      normalized.includes('tokens per minute limit exceeded')
      || normalized.includes('too many tokens processed')
      || normalized.includes('token_quota_exceeded')
      || normalized.includes('remaining minute token headroom')
    ) {
      return 60_000;
    }
  }

  return calcBackoffMs(attempt);
}

function getAliasMatchInfo(alias: string | null, model: ModelInfo, stabilityLevel: StabilityLevel): { allowed: boolean; mode: AliasMatchMode; reason?: string } {
  if (!alias) {
    return { allowed: true, mode: 'default' };
  }

  if (model.aliases.includes(alias)) {
    return { allowed: true, mode: 'exact' };
  }

  if (stabilityLevel === 'strict') {
    return { allowed: false, mode: 'default' };
  }

  const broadenedAlias = getBroadenedAliasTargets(alias).find(candidateAlias => model.aliases.includes(candidateAlias));
  if (!broadenedAlias) {
    return { allowed: false, mode: 'default' };
  }

  return {
    allowed: true,
    mode: 'broadened',
    reason: `requested=${alias}; matched=${broadenedAlias}`,
  };
}

function getTargetTierRank(requestClass: RequestClass): number {
  switch (requestClass) {
    case 'repo_scaffold':
      return QUALITY_TIER_RANK['tier_free_strong'];
    case 'code_generation':
    case 'code_repair':
      return QUALITY_TIER_RANK['tier_code_strong'];
    case 'reasoning_heavy':
      return QUALITY_TIER_RANK['tier_free_strong'];
    case 'tiny_text_utility':
      return QUALITY_TIER_RANK['tier_free_fast'];
    case 'long_context':
      return QUALITY_TIER_RANK['tier_free_long_context'];
    case 'embeddings':
    case 'rerank':
      return QUALITY_TIER_RANK['tier_free_fast'];
    default:
      return QUALITY_TIER_RANK['tier_free_fast'];
  }
}

// ─── Candidate builder ────────────────────────────────────────────────────────

async function buildCandidates(
  req: RouteRequest,
  requestClass: RequestClass,
): Promise<CandidateAnalysis> {
  req = normalizeRouteRequest(req);
  await registry.initialize();

  const modes = getEffectiveModes(getConfig());
  const stabilityLevel = getRequestedStabilityLevel(req);
  const taskProfile = getRequestedTaskProfile(req);
  const candidates: RoutingCandidate[] = [];

  // Determine alias-based priority
  const alias = req.model_alias ?? null;
  const priorityOrder = alias ? (ALIAS_PRIORITY_ORDER[alias] ?? []) : getDefaultPriority(requestClass);
  const preview: RoutePreview = {
    classifiedAs: requestClass,
    alias,
    taskProfile,
    stabilityLevel,
    effectiveModes: modes,
    priorityOrder,
    candidates: [],
    skipCounts: {},
    skipped: [],
  };

  const recordSkip = (entry: RouteSkipEntry): void => {
    preview.skipCounts[entry.reason] = (preview.skipCounts[entry.reason] ?? 0) + 1;
    preview.skipped.push(entry);
  };

  const adapters = registry.getAllAdapters();

  for (const adapter of adapters) {
    if (!adapter.isEnabled()) {
      recordSkip({ providerId: adapter.providerId, reason: 'provider_disabled' });
      continue;
    }

    if (!adapter.isAuthenticated()) {
      recordSkip({ providerId: adapter.providerId, reason: 'missing_auth' });
      continue;
    }

    if (modes.localOnly && adapter.providerId !== 'local') {
      recordSkip({ providerId: adapter.providerId, reason: 'local_only_mode' });
      continue;
    }

    // Membership gates
    if (!modes.premiumEnabled &&
      (adapter.qualityTier === 'tier_membership_premium' || adapter.qualityTier === 'tier_membership_frontier')) {
      recordSkip({ providerId: adapter.providerId, reason: 'premium_disabled' });
      continue;
    }

    // Routing health
    if (!isProviderRoutable(adapter.providerId)) {
      const providerBlockReason = getProviderRoutingBlockReason(adapter.providerId) ?? 'provider_unroutable';
      recordSkip({ providerId: adapter.providerId, reason: `provider_${providerBlockReason}` });
      continue;
    }

    let models: ModelInfo[];
    try {
      models = await adapter.listModels();
    } catch (error) {
      recordSkip({
        providerId: adapter.providerId,
        reason: 'model_list_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const model of models) {
      const candidateBlockReason = getCandidateBlockReason(req, requestClass, model);
      if (candidateBlockReason) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: candidateBlockReason });
        continue;
      }

      if (modes.freeOnly && !model.isFree) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'free_only_mode' });
        continue;
      }

      if (req.forbid_paid && !model.isFree) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'forbid_paid' });
        continue;
      }

      if (!isModelRoutable(adapter.providerId, model.id)) {
        const modelBlockReason = getModelRoutingBlockReason(adapter.providerId, model.id) ?? 'unroutable';
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: `model_${modelBlockReason}` });
        continue;
      }

      // Skip non-chat models for chat tasks
      if (requestClass !== 'embeddings' && requestClass !== 'rerank') {
        if (!model.capabilities.chat) {
          recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'chat_unsupported' });
          continue;
        }
      }
      if (requestClass === 'vision_text' && !model.capabilities.vision) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'vision_unsupported' });
        continue;
      }
      if (requestClass === 'embeddings' && !model.capabilities.embeddings) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'embeddings_unsupported' });
        continue;
      }
      if (requestClass === 'rerank' && !model.capabilities.rerank) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'rerank_unsupported' });
        continue;
      }
      if (req.stream && model.capabilities.streaming === false) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'stream_unsupported' });
        continue;
      }
      if ((req.tools?.length ?? 0) > 0 && !model.capabilities.tools) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'tools_unsupported' });
        continue;
      }
      if (req.response_format && !model.capabilities.structuredOutput) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: 'structured_output_unsupported' });
        continue;
      }

      // Apply requested model/alias filter
      if (req.model && req.model !== model.id && !model.aliases.includes(req.model)) {
        recordSkip({
          providerId: adapter.providerId,
          modelId: model.id,
          reason: 'model_mismatch',
          detail: `requested=${req.model}`,
        });
        continue;
      }

      const effectiveLimitConfig = getEffectiveLimitConfig(adapter, model);
      const preflightSkipReason = getPreflightSkipReason(req, {
        providerId: adapter.providerId,
        model: {
          ...model,
          limitConfig: effectiveLimitConfig,
        },
      }, effectiveLimitConfig);
      if (preflightSkipReason) {
        recordSkip({ providerId: adapter.providerId, modelId: model.id, reason: preflightSkipReason });
        continue;
      }

      const aliasMatch = getAliasMatchInfo(alias, model, stabilityLevel);
      if (!aliasMatch.allowed) {
        recordSkip({
          providerId: adapter.providerId,
          modelId: model.id,
          reason: 'alias_mismatch',
          detail: `requested=${alias}`,
        });
        continue;
      }

      // Phase 1: Preflight availability check (Fix 1)
      const cfg = getConfig();
      const availability = await checkProviderModelAvailability(adapter, model, cfg.preflightTimeoutMs);
      if (!availability.available) {
        recordSkip({
          providerId: adapter.providerId,
          modelId: model.id,
          reason: 'preflight_unavailable',
          detail: availability.reason,
        });
        continue;
      }

      const factors: Record<string, number> = {};
      const s = scoreCandidate(adapter, model, requestClass, req, alias, aliasMatch.mode, priorityOrder, modes);
      // Collect individual factors for debugging
      factors.score = s;
      factors.aliasMatch = aliasMatch.mode === 'exact' ? 1 : aliasMatch.mode === 'broadened' ? 0.5 : 0;

      if (s > -0.3) { // Threshold to keep candidate
        candidates.push({
          providerId: adapter.providerId,
          model: {
            ...model,
            limitConfig: effectiveLimitConfig,
          },
          score: s,
          factors: {
            ...factors,
            aliasMatchMode: aliasMatch.mode === 'exact' ? 2 : aliasMatch.mode === 'broadened' ? 1 : 0,
          },
        });
        preview.candidates.push({
          providerId: adapter.providerId,
          modelId: model.id,
          score: s,
          qualityTier: model.qualityTier,
          isFree: model.isFree,
          aliases: model.aliases,
          aliasMatch: aliasMatch.mode,
          aliasMatchReason: aliasMatch.reason,
        });
      } else {
        recordSkip({
          providerId: adapter.providerId,
          modelId: model.id,
          reason: 'score_below_threshold',
          score: s,
        });
      }
    }
  }

  // Phase 5: Apply fallback chain ordering (Fix 5)
  const cfg = getConfig();
  const providerOrder = req.explicit_provider_order ?? cfg.providerFallbackOrder;
  
  candidates.sort((a, b) => {
    // Primary sort: by explicit provider order if specified
    const aIdx = providerOrder.indexOf(a.providerId);
    const bIdx = providerOrder.indexOf(b.providerId);
    
    if (aIdx >= 0 && bIdx >= 0) {
      // Both in order, sort by provider position first
      if (aIdx !== bIdx) return aIdx - bIdx;
    } else if (aIdx >= 0) {
      // Only a is in order, prefer a
      return -1;
    } else if (bIdx >= 0) {
      // Only b is in order, prefer b
      return 1;
    }
    
    // Secondary sort: by score when provider order is same or neither in order
    return b.score - a.score;
  });

  preview.candidates.sort((a, b) => {
    const aIdx = providerOrder.indexOf(a.providerId);
    const bIdx = providerOrder.indexOf(b.providerId);
    
    if (aIdx >= 0 && bIdx >= 0) {
      if (aIdx !== bIdx) return aIdx - bIdx;
    } else if (aIdx >= 0) {
      return -1;
    } else if (bIdx >= 0) {
      return 1;
    }
    
    return b.score - a.score;
  });

  return { candidates, preview };
}

function summarizeRoutePreview(preview: RoutePreview): string {
  const topSkips = Object.entries(preview.skipCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');

  const modeSummary = `stability=${preview.stabilityLevel} free_only=${preview.effectiveModes.freeOnly} local_only=${preview.effectiveModes.localOnly} premium_enabled=${preview.effectiveModes.premiumEnabled}`;
  return topSkips ? `${modeSummary}; top skips: ${topSkips}` : modeSummary;
}

export async function previewRoute(req: RouteRequest): Promise<RoutePreview> {
  const normalizedReq = normalizeRouteRequest(req);
  const requestClass = classifyRequest(normalizedReq);
  const analysis = await buildCandidates(normalizedReq, requestClass);
  return analysis.preview;
}

function getDefaultPriority(requestClass: RequestClass): string[] {
  switch (requestClass) {
    case 'repo_scaffold':
      return ['openrouter', 'local', 'github-models', 'gemini', 'mistral', 'groq', 'cloudflare', 'sambanova'];
    case 'code_generation':
    case 'code_repair':
      return ['local', 'github-models', 'mistral', 'gemini', 'groq', 'sambanova', 'openrouter', 'cloudflare', 'copilot', 'codex', 'fireworks'];
    case 'long_context':
      return ['local', 'gemini', 'mistral', 'openrouter', 'github-models'];
    case 'embeddings':
      return ['local', 'gemini', 'cohere', 'cloudflare'];
    case 'rerank':
      return ['cohere', 'local'];
    case 'vision_text':
      return ['local', 'gemini', 'openrouter', 'github-models'];
    case 'reasoning_heavy':
      return ['gemini', 'groq', 'github-models', 'openrouter', 'cerebras'];
    default:
      return ['local', 'gemini', 'groq', 'github-models', 'cerebras', 'cloudflare', 'sambanova', 'openrouter', 'cohere', 'fireworks'];
  }
}

// ─── Token preflight ─────────────────────────────────────────────────────────

function tokenPreflight(req: RouteRequest, candidate: RoutingCandidate, limitConfig: Partial<ProviderLimitConfig>): { ok: boolean; reason?: string } {
  const estTokens = estimateMessagesTokens(req.messages ?? []);
  const requestedMaxTokens = Math.max(0, Math.min(req.max_tokens ?? Math.min(candidate.model.maxOutputTokens || 1024, 2048), candidate.model.maxOutputTokens || Number.MAX_SAFE_INTEGER));

  if (estTokens > TOKEN_PREFLIGHT_MAX) {
    return { ok: false, reason: `Request estimated at ~${estTokens} tokens exceeds hard cap ${TOKEN_PREFLIGHT_MAX}` };
  }

  const model = candidate.model;
  if (req.max_tokens && model.maxOutputTokens && req.max_tokens > model.maxOutputTokens) {
    return {
      ok: false,
      reason: `Requested max_tokens ${req.max_tokens} exceeds ${model.id}'s max output ${model.maxOutputTokens}`,
    };
  }

  if (model.contextWindow && estTokens + requestedMaxTokens > model.contextWindow) {
    return {
      ok: false,
      reason: `Projected request size (~${estTokens + requestedMaxTokens} tokens) exceeds ${model.id}'s context window (${model.contextWindow})`,
    };
  }

  if (hasTrackedLimitConfig(limitConfig)) {
    const limitStates = getProviderLimitStates(candidate.providerId, limitConfig, model.id);
    const hardBlocked = limitStates.find(state => state.exhausted || state.remaining <= 0);
    if (hardBlocked) {
      return {
        ok: false,
        reason: `${hardBlocked.metricLabel}/${hardBlocked.windowLabel} quota is exhausted`,
      };
    }

    const requestWindow = limitStates
      .filter(state => state.metricKind === 'requests' && state.remainingKind !== 'unknown')
      .sort((left, right) => left.remaining - right.remaining)[0];
    if (requestWindow && requestWindow.remaining < 1) {
      return {
        ok: false,
        reason: `No remaining ${requestWindow.metricLabel}/${requestWindow.windowLabel} budget`,
      };
    }

    const tokenWindow = limitStates
      .filter(state => state.metricKind === 'tokens' && state.remainingKind !== 'unknown')
      .sort((left, right) => left.remaining - right.remaining)[0];
    if (tokenWindow && tokenWindow.remaining < estTokens + requestedMaxTokens) {
      return {
        ok: false,
        reason: `Projected token usage (~${estTokens + requestedMaxTokens}) exceeds remaining ${tokenWindow.windowLabel} token headroom (${tokenWindow.remaining})`,
      };
    }
  }

  return { ok: true };
}

function isEmptyAssistantResponse(response: AdapterResponse, stream: boolean | undefined): boolean {
  if (stream || response.streamResponse) return false;
  return response.content.trim().length === 0;
}

// ─── Main route function ──────────────────────────────────────────────────────

export async function route(req: RouteRequest): Promise<RouteResult> {
  req = normalizeRouteRequest(req);
  const requestId = randomBytes(16).toString('hex');
  const requestClass = classifyRequest(req);
  const maxHops = resolveMaxProviderHops(req);

  // ── Exact cache check ──
  if (req.cache_policy !== 'bypass' && req.messages) {
    const adapterReq = buildRouteCacheAdapterRequest(req, requestClass);
    const cacheKey = computeCacheKey(adapterReq);
    const cached = getExactCache(cacheKey);
    if (cached) {
      return buildCachedResult(requestId, cached, requestClass, true);
    }
  }

  // ── Semantic cache check ──
  if (req.cache_policy !== 'bypass' && req.messages && requestClass !== 'code_generation' && requestClass !== 'code_repair') {
    const prompt = getSemanticCachePrompt(req, requestClass);
    const semanticCached = await getSemanticCache(prompt);
    if (semanticCached) {
      return buildCachedResult(requestId, semanticCached, requestClass, true);
    }
  }

  const analysis = await buildCandidates(req, requestClass);
  const { candidates, preview } = analysis;

  if (candidates.length === 0) {
    throw new RouteExecutionError(
      `No available providers for this request. ${summarizeRoutePreview(preview)}`,
      {
        classifiedAs: requestClass,
        fallbackChain: [],
        preview,
      },
    );
  }

  let lastError: unknown = null;
  let lastCandidate: RoutingCandidate | null = null;
  const fallbackChain: string[] = [];
  const blockedProviders = new Set<string>();
  const blockedModels = new Set<string>();
  let initialTier: QualityTier | null = null;

  for (let hop = 0; hop < Math.min(candidates.length, maxHops); hop++) {
    const candidate = candidates[hop];
    if (blockedProviders.has(candidate.providerId)) continue;
    if (blockedModels.has(`${candidate.providerId}/${candidate.model.id}`)) continue;

    lastCandidate = candidate;
    fallbackChain.push(`${candidate.providerId}/${candidate.model.id}`);

    // ── Downgrade check ── (only on fallback)
    if (hop > 0 && initialTier) {
      const downgradeResult = await checkDowngrade(
        initialTier,
        candidate.model.qualityTier,
        candidates[0]!.providerId,
        requestClass,
        req.allow_downgrade_with_approval ?? false,
        req.require_same_or_better_quality ?? false,
      );

      if (!downgradeResult.allowed) {
        // Return with approval required
        return {
          id: requestId,
          providerId: candidates[0]!.providerId,
          upstreamModel: candidates[0]!.model.id,
          normalizedAlias: req.model_alias ?? candidates[0]!.model.aliases[0] ?? candidates[0]!.model.id,
          qualityTier: initialTier,
          cacheHit: false,
          estimatedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          warnings: [downgradeResult.warning ?? 'Downgrade requires approval'],
          downgradeApprovalRequired: true,
          routeDecision: {
            selectedProvider: candidates[0]!.providerId,
            selectedModel: candidates[0]!.model.id,
            classifiedAs: requestClass,
            hopCount: hop,
            fallbackReason: `Tried ${hop} providers; downgrade to ${candidate.model.qualityTier} needs approval`,
            candidatesConsidered: candidates.length,
            scoringFactors: candidate.factors,
            qualityTier: candidate.model.qualityTier,
          },
          output: {
            error: downgradeResult.warning,
            approval_token: downgradeResult.approvalToken,
            same_tier_alternatives: downgradeResult.sameTierAlternatives,
            lower_tier_alternatives: downgradeResult.lowerTierAlternatives,
          },
        };
      }
    }

    if (initialTier === null) initialTier = candidate.model.qualityTier;

    // ── Execute ──
    const adapter = registry.getAdapter(candidate.providerId);
    if (!adapter) continue;

    const adapterReq = buildAdapterRequest(req, candidate.model.id, requestClass);
    const start = Date.now();
    const effectiveLimitConfig = getEffectiveLimitConfig(adapter, candidate.model);

    const preflight = tokenPreflight(req, candidate, effectiveLimitConfig);
    if (!preflight.ok) {
      lastError = new Error(`Preflight: ${preflight.reason}`);
      blockedModels.add(`${candidate.providerId}/${candidate.model.id}`);
      continue;
    }

    try {
      let response;
      if (requestClass === 'embeddings') {
        const embResult = await adapter.executeEmbeddings({
          input: getRequestText(req),
          model: candidate.model.id,
          projectId: req.project_id,
        });
        if (embResult.quotaSnapshots?.length) {
          recordProviderQuotaSnapshots(embResult.quotaSnapshots);
        }
        recordUsage({ providerId: candidate.providerId, modelId: candidate.model.id, ...embResult.usage });
        recordProviderSuccess(candidate.providerId, Date.now() - start);
        recordModelSuccess(candidate.providerId, candidate.model.id, Date.now() - start);
        return buildEmbeddingResult(requestId, candidate, requestClass, embResult);
      } else if (requestClass === 'rerank') {
        // Handled separately in rerank route
        throw new Error('Rerank requests should use /v1/rerank endpoint');
      } else {
        response = await adapter.executeCompletion(adapterReq);
      }

      if (isEmptyAssistantResponse(response, req.stream)) {
        throw new ProviderError(
          `${candidate.providerId}/${candidate.model.id}: empty assistant response`,
          'unknown',
          undefined,
          true,
        );
      }

      const latencyMs = Date.now() - start;
      recordProviderSuccess(candidate.providerId, latencyMs);
      recordModelSuccess(candidate.providerId, candidate.model.id, latencyMs);
      if (response.quotaSnapshots?.length) {
        recordProviderQuotaSnapshots(response.quotaSnapshots);
      }
      recordUsage({
        providerId: candidate.providerId,
        modelId: candidate.model.id,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      });

      // ── Cache the result ──
      if (req.cache_policy !== 'bypass' && !req.stream) {
        const cachedResp: CachedResponse = {
          content: response.content,
          finishReason: response.finishReason,
          usage: response.usage,
          providerId: candidate.providerId,
          modelId: candidate.model.id,
          qualityTier: candidate.model.qualityTier,
          normalizedAlias: req.model_alias ?? candidate.model.aliases[0] ?? candidate.model.id,
        };
        // Exact cache for deterministic tasks
        if (req.temperature === 0 || req.temperature === undefined) {
          const cacheKey = computeCacheKey(buildRouteCacheAdapterRequest(req, requestClass));
          setExactCache(cacheKey, cachedResp);
        }
        // Semantic cache async (don't wait)
        if (requestClass !== 'code_generation' && requestClass !== 'code_repair') {
          const prompt = getSemanticCachePrompt(req, requestClass);
          setSemanticCache(prompt, cachedResp).catch(() => {});
        }
      }

      const isDowngrade = hop > 0 && initialTier !== null &&
        QUALITY_TIER_RANK[candidate.model.qualityTier] < QUALITY_TIER_RANK[initialTier];

      return {
        id: requestId,
        providerId: candidate.providerId,
        upstreamModel: candidate.model.id,
        normalizedAlias: req.model_alias ?? candidate.model.aliases[0] ?? candidate.model.id,
        qualityTier: candidate.model.qualityTier,
        cacheHit: false,
        estimatedUsage: response.usage,
        warnings: isDowngrade
          ? [`Downgraded from ${initialTier} to ${candidate.model.qualityTier} after ${hop} failed attempt(s)`]
          : [],
        downgradeApprovalRequired: false,
        routeDecision: {
          selectedProvider: candidate.providerId,
          selectedModel: candidate.model.id,
          classifiedAs: requestClass,
          requestedAlias: req.model_alias ?? (isHubModelAlias(req.model as string | undefined) ? (req.model as string) : null),
          taskProfile: getRequestedTaskProfile(req),
          stabilityLevel: getRequestedStabilityLevel(req),
          hopCount: hop,
          fallbackReason: hop > 0 ? `Fallback after: ${fallbackChain.slice(0, -1).join(' → ')}` : undefined,
          candidatesConsidered: candidates.length,
          scoringFactors: candidate.factors,
          qualityTier: candidate.model.qualityTier,
        },
        output: req.stream
          ? { stream: response.streamResponse }
          : buildOpenAIOutput(response, candidate.model.id, adapterReq),
        streamResponse: response.streamResponse,
      };
    } catch (e) {
      lastError = e;
      if (e instanceof ProviderError && e.quotaSnapshots?.length) {
        recordProviderQuotaSnapshots(e.quotaSnapshots);
      }
      const errorType = adapter.classifyFailure(e);
      const errMsg = e instanceof Error ? e.message : String(e);

      const failureScope = getFailureScope(errorType);
      if (failureScope === 'provider') {
        recordProviderFailure(candidate.providerId, errMsg, errorType);
        blockedProviders.add(candidate.providerId);
      } else {
        recordModelFailure(candidate.providerId, candidate.model.id, errMsg, errorType);
        blockedModels.add(`${candidate.providerId}/${candidate.model.id}`);
      }

      if (errorType === 'rate_limit' || errorType === 'quota_exhausted') {
        const backoffMs = getCooldownMsForFailure(errorType, errMsg, hop);
        if (failureScope === 'provider') {
          recordCooldown(candidate.providerId, backoffMs);
        } else if (backoffMs >= 60_000) {
          // TPM/token-quota exhaustion: shared account budget — block the entire provider
          recordCooldown(candidate.providerId, backoffMs);
          blockedProviders.add(candidate.providerId);
        } else {
          recordModelCooldown(candidate.providerId, candidate.model.id, backoffMs);
        }
      }

      if (errorType === 'auth_failure') {
        // Skip remaining candidates from same provider
        continue;
      }

      // Continue to next candidate
    }
  }

  const errMsg = lastError instanceof Error ? lastError.message : 'All providers exhausted';
  throw new RouteExecutionError(`Routing failed after ${fallbackChain.length} attempt(s): ${errMsg}`, {
    classifiedAs: requestClass,
    selectedProvider: lastCandidate?.providerId ?? null,
    selectedModel: lastCandidate?.model.id ?? null,
    qualityTier: lastCandidate?.model.qualityTier ?? null,
    fallbackChain,
    preview,
    cause: lastError,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAdapterRequest(req: RouteRequest, modelId: string, _requestClass: RequestClass): AdapterRequest {
  return {
    messages: req.messages ?? (req.prompt ? [{ role: 'user', content: req.prompt }] : []),
    model: modelId,
    stream: req.stream ?? false,
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    topP: req.top_p,
    tools: req.tools,
    toolChoice: req.tool_choice,
    responseFormat: req.response_format as { type: string } | undefined,
    stop: req.stop as string | string[] | undefined,
    projectId: req.project_id,
  };
}

function buildOpenAIOutput(response: import('./types').AdapterResponse, modelId: string, req: AdapterRequest): unknown {
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: response.content },
        finish_reason: response.finishReason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
      total_tokens: response.usage.totalTokens,
    },
  };
}

function buildCachedResult(
  requestId: string,
  cached: CachedResponse,
  requestClass: RequestClass,
  cacheHit: boolean,
): RouteResult {
  return {
    id: requestId,
    providerId: cached.providerId,
    upstreamModel: cached.modelId,
    normalizedAlias: cached.normalizedAlias ?? cached.modelId,
    qualityTier: cached.qualityTier ?? 'tier_free_fast',
    cacheHit,
    estimatedUsage: cached.usage,
    warnings: [],
    downgradeApprovalRequired: false,
    routeDecision: {
      selectedProvider: cached.providerId,
      selectedModel: cached.modelId,
      classifiedAs: requestClass,
      hopCount: 0,
      candidatesConsidered: 0,
      scoringFactors: { cache: 1 },
      qualityTier: cached.qualityTier ?? 'tier_free_fast',
    },
    output: {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: cached.modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: cached.content }, finish_reason: cached.finishReason ?? 'stop' }],
      usage: { prompt_tokens: cached.usage.promptTokens, completion_tokens: cached.usage.completionTokens, total_tokens: cached.usage.totalTokens },
    },
  };
}

function buildEmbeddingResult(
  requestId: string,
  candidate: RoutingCandidate,
  requestClass: RequestClass,
  embResult: import('./types').EmbeddingResponse,
): RouteResult {
  return {
    id: requestId,
    providerId: candidate.providerId,
    upstreamModel: candidate.model.id,
    normalizedAlias: candidate.model.aliases[0] ?? candidate.model.id,
    qualityTier: candidate.model.qualityTier,
    cacheHit: false,
    estimatedUsage: embResult.usage,
    warnings: [],
    downgradeApprovalRequired: false,
    routeDecision: {
      selectedProvider: candidate.providerId,
      selectedModel: candidate.model.id,
      classifiedAs: requestClass,
      hopCount: 0,
      candidatesConsidered: 1,
      scoringFactors: candidate.factors,
      qualityTier: candidate.model.qualityTier,
    },
    output: {
      object: 'list',
      data: embResult.embeddings.map((e, i) => ({ object: 'embedding', index: i, embedding: e })),
      model: candidate.model.id,
      usage: { prompt_tokens: embResult.usage.promptTokens, total_tokens: embResult.usage.totalTokens },
    },
  };
}

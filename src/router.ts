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
  QualityTier,
  RoutingCandidate,
  RouteDecision,
  ModelInfo,
  AdapterRequest,
} from './types';
import { QUALITY_TIER_RANK } from './types';
import { registry } from './registry';
import { getConfig, HubConfig } from './config';
import { getSetting } from './db';
import {
  isProviderRoutable,
  getLatencyScore,
  recordSuccess,
  recordFailure,
  calcBackoffMs,
} from './health';
import {
  isProviderAvailable,
  recordUsage,
  isCoolingDown,
  recordCooldown,
  getProviderLimitStates,
} from './limits';
import { recordProviderQuotaSnapshots } from './quota-sync';
import { getExactCache, setExactCache, getSemanticCache, setSemanticCache, computeCacheKey, CachedResponse } from './cache';
import { checkDowngrade } from './warnings';
import { estimateMessagesTokens } from './adapters/base';
import type { BaseAdapter } from './adapters/base';
import { ProviderError } from './adapters/base';

const MAX_HOPS = 5;
const TOKEN_PREFLIGHT_MAX = 100_000; // Hard cap; adjust by provider

// ─── Model aliases ────────────────────────────────────────────────────────────
const ALIAS_PRIORITY_ORDER: Record<string, string[]> = {
  'fast-free':             ['groq', 'gemini', 'cerebras', 'cloudflare', 'openrouter', 'mistral'],
  'strong-free':           ['gemini', 'groq', 'github-models', 'cerebras', 'openrouter', 'sambanova', 'mistral'],
  'strong-code':           ['copilot', 'github-models', 'mistral', 'fireworks', 'cloudflare', 'openrouter'],
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

// ─── Request classifier ───────────────────────────────────────────────────────

export function classifyRequest(req: RouteRequest): RequestClass {
  const text = getRequestText(req).toLowerCase();
  const msgCount = req.messages?.length ?? 0;
  const totalLen = text.length;

  // Embeddings / rerank pass-through
  if (req.route_policy === 'embeddings') return 'embeddings';
  if (req.route_policy === 'rerank') return 'rerank';

  // Vision
  if (hasImageContent(req)) return 'vision_text';

  // Long context
  const estTokens = estimateMessagesTokens(req.messages ?? []);
  if (estTokens > 30_000) return 'long_context';

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

// ─── Provider scorer ──────────────────────────────────────────────────────────

function scoreCandidate(
  adapter: BaseAdapter,
  model: ModelInfo,
  requestClass: RequestClass,
  req: RouteRequest,
  alias: string | null,
  priorityOrder: string[],
): number {
  let score = 0;
  const cfg = getConfig();
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
  const available = isProviderAvailable(adapter.providerId, model);
  score += available ? 0.3 : -0.5;
  score += getQuotaScoreDelta(adapter.providerId, model);

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
  else if (cfg.freeOnly) score -= 1; // Heavy penalty in free-only mode

  // Keep membership/premium providers as fallback unless the request explicitly asks for them.
  if (!model.isFree && !explicitPaidRequest) score -= 0.25;

  // 6. Priority order position (0–0.1)
  const posIdx = priorityOrder.indexOf(adapter.providerId);
  if (posIdx >= 0) {
    score += (1 - posIdx / Math.max(priorityOrder.length, 1)) * 0.1;
  }

  // 7. Local preference
  if (req.prefer_local && adapter.providerId === 'local') score += 0.2;
  if (req.preferred_provider === adapter.providerId) score += 0.15;

  return Math.max(-1, Math.min(1, score));
}

function getQuotaScoreDelta(providerId: string, model: ModelInfo): number {
  if (!model.limitConfig) return 0;

  const states = getProviderLimitStates(providerId, model.limitConfig, model.id);
  if (!states.length) return 0;

  const primary = [...states].sort((a, b) => {
    if (a.remainingPct !== b.remainingPct) return a.remainingPct - b.remainingPct;
    if (a.remaining !== b.remaining) return a.remaining - b.remaining;
    return a.windowLabel.localeCompare(b.windowLabel);
  })[0];
  if (!primary) return 0;

  let delta = ((primary.remainingPct / 100) - 0.5) * 0.08;

  if (primary.confidence === 'official') delta += 0.03;
  else if (primary.confidence === 'observed') delta += 0.01;

  if (primary.usageCoverage === 'provider_synced') delta += 0.03;
  else if (primary.usageCoverage === 'partial') delta -= 0.01;
  else if (primary.usageCoverage === 'unknown') delta -= 0.02;

  return Math.max(-0.06, Math.min(0.08, delta));
}

function getTargetTierRank(requestClass: RequestClass): number {
  switch (requestClass) {
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
): Promise<RoutingCandidate[]> {
  const cfg = getConfig();
  const candidates: RoutingCandidate[] = [];

  // Determine alias-based priority
  const alias = req.model_alias ?? null;
  const priorityOrder = alias ? (ALIAS_PRIORITY_ORDER[alias] ?? []) : getDefaultPriority(requestClass);

  const adapters = registry.getReadyAdapters();

  for (const adapter of adapters) {
    // Mode gates
    if (cfg.localOnly && adapter.providerId !== 'local') continue;
    if (cfg.freeOnly && !adapter.capabilities.chat) continue;
    if (req.forbid_paid && !adapter.capabilities.chat) continue;

    // Membership gates
    if (!cfg.premiumEnabled &&
      (adapter.qualityTier === 'tier_membership_premium' || adapter.qualityTier === 'tier_membership_frontier')) {
      continue;
    }

    // Routing health
    if (!isProviderRoutable(adapter.providerId)) continue;
    if (isCoolingDown(adapter.providerId)) continue;

    let models: ModelInfo[];
    try {
      models = await adapter.listModels();
    } catch {
      continue;
    }

    for (const model of models) {
      // Skip non-chat models for chat tasks
      if (requestClass !== 'embeddings' && requestClass !== 'rerank') {
        if (!model.capabilities.chat) continue;
      }
      if (requestClass === 'embeddings' && !model.capabilities.embeddings) continue;
      if (requestClass === 'rerank' && !model.capabilities.rerank) continue;

      // Apply requested model/alias filter
      if (req.model && req.model !== model.id && !model.aliases.includes(req.model)) continue;
      if (alias && !model.aliases.includes(alias) && !ALIAS_PRIORITY_ORDER[alias]?.includes(adapter.providerId)) {
        // Only skip if the alias is explicitly required and this model doesn't have it
        if (req.model_alias && !model.aliases.includes(req.model_alias)) continue;
      }

      const factors: Record<string, number> = {};
      const s = scoreCandidate(adapter, model, requestClass, req, alias, priorityOrder);
      // Collect individual factors for debugging
      factors.score = s;

      if (s > -0.3) { // Threshold to keep candidate
        candidates.push({ providerId: adapter.providerId, model, score: s, factors });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function getDefaultPriority(requestClass: RequestClass): string[] {
  switch (requestClass) {
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

function tokenPreflight(req: RouteRequest, candidate: RoutingCandidate): { ok: boolean; reason?: string } {
  const estTokens = estimateMessagesTokens(req.messages ?? []);

  if (estTokens > TOKEN_PREFLIGHT_MAX) {
    return { ok: false, reason: `Request estimated at ~${estTokens} tokens exceeds hard cap ${TOKEN_PREFLIGHT_MAX}` };
  }

  const model = candidate.model;
  if (model.contextWindow && estTokens > model.contextWindow * 0.9) {
    return {
      ok: false,
      reason: `Request estimated at ~${estTokens} tokens exceeds 90% of ${model.id}'s context window (${model.contextWindow})`,
    };
  }

  return { ok: true };
}

// ─── Main route function ──────────────────────────────────────────────────────

export async function route(req: RouteRequest): Promise<RouteResult> {
  const cfg = getConfig();
  const requestId = randomBytes(16).toString('hex');
  const requestClass = classifyRequest(req);
  const maxHops = Math.min(req.max_provider_hops ?? MAX_HOPS, MAX_HOPS);

  // ── Exact cache check ──
  if (req.cache_policy !== 'bypass' && req.messages) {
    const adapterReq = buildAdapterRequest(req, '', requestClass);
    const cacheKey = computeCacheKey(adapterReq);
    const cached = getExactCache(cacheKey);
    if (cached) {
      return buildCachedResult(requestId, cached, requestClass, true);
    }
  }

  // ── Semantic cache check ──
  if (req.cache_policy !== 'bypass' && req.messages && requestClass !== 'code_generation' && requestClass !== 'code_repair') {
    const prompt = getRequestText(req);
    const semanticCached = await getSemanticCache(prompt);
    if (semanticCached) {
      return buildCachedResult(requestId, semanticCached, requestClass, true);
    }
  }

  const candidates = await buildCandidates(req, requestClass);

  if (candidates.length === 0) {
    throw new Error('No available providers for this request. Check provider config and API keys.');
  }

  let lastError: unknown = null;
  const fallbackChain: string[] = [];
  let initialTier: QualityTier | null = null;

  for (let hop = 0; hop < Math.min(candidates.length, maxHops); hop++) {
    const candidate = candidates[hop];
    fallbackChain.push(`${candidate.providerId}/${candidate.model.id}`);

    // ── Token preflight ──
    const preflight = tokenPreflight(req, candidate);
    if (!preflight.ok) {
      lastError = new Error(`Preflight: ${preflight.reason}`);
      continue;
    }

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
        recordSuccess(candidate.providerId, Date.now() - start);
        return buildEmbeddingResult(requestId, candidate, requestClass, embResult);
      } else if (requestClass === 'rerank') {
        // Handled separately in rerank route
        throw new Error('Rerank requests should use /v1/rerank endpoint');
      } else {
        response = await adapter.executeCompletion(adapterReq);
      }

      const latencyMs = Date.now() - start;
      recordSuccess(candidate.providerId, latencyMs);
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
        };
        // Exact cache for deterministic tasks
        if (req.temperature === 0 || req.temperature === undefined) {
          const cacheKey = computeCacheKey(adapterReq);
          setExactCache(cacheKey, cachedResp);
        }
        // Semantic cache async (don't wait)
        if (requestClass !== 'code_generation' && requestClass !== 'code_repair') {
          const prompt = getRequestText(req);
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

      recordFailure(candidate.providerId, errMsg, errorType);

      if (errorType === 'rate_limit' || errorType === 'quota_exhausted') {
        const backoffMs = calcBackoffMs(hop);
        recordCooldown(candidate.providerId, backoffMs);
      }

      if (errorType === 'auth_failure') {
        // Skip remaining candidates from same provider
        continue;
      }

      // Continue to next candidate
    }
  }

  const errMsg = lastError instanceof Error ? lastError.message : 'All providers exhausted';
  throw new Error(`Routing failed after ${fallbackChain.length} attempt(s): ${errMsg}`);
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
    normalizedAlias: cached.modelId,
    qualityTier: 'tier_free_fast', // placeholder for cached
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
      qualityTier: 'tier_free_fast',
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

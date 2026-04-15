// ─── Quality tiers ────────────────────────────────────────────────────────────
export type QualityTier =
  | 'tier_local_basic'
  | 'tier_free_fast'
  | 'tier_free_strong'
  | 'tier_free_long_context'
  | 'tier_code_strong'
  | 'tier_membership_premium'
  | 'tier_membership_frontier';

export const QUALITY_TIER_RANK: Record<QualityTier, number> = {
  tier_local_basic: 1,
  tier_free_fast: 2,
  tier_free_strong: 3,
  tier_free_long_context: 4,
  tier_code_strong: 5,
  tier_membership_premium: 6,
  tier_membership_frontier: 7,
};

// ─── Request classification ───────────────────────────────────────────────────
export type RequestClass =
  | 'tiny_text_utility'
  | 'normal_chat'
  | 'code_generation'
  | 'code_repair'
  | 'repo_scaffold'
  | 'reasoning_heavy'
  | 'long_context'
  | 'embeddings'
  | 'rerank'
  | 'vision_text'
  | 'structured_extraction';

export type RouteTaskProfile =
  | 'tiny_reply'
  | 'general_chat'
  | 'planning'
  | 'codegen'
  | 'repo_scaffold'
  | 'long_context';

// ─── Provider metadata ────────────────────────────────────────────────────────
export type ProviderAuthType = 'api_key' | 'oauth' | 'interactive' | 'none';

export type LimitConfidence = 'official' | 'observed' | 'inferred';
export type QuotaMetricKind = 'requests' | 'tokens' | 'provider_units';
export type QuotaWindowScope = 'minute' | 'day' | 'month';
export type QuotaUsageCoverage = 'provider_synced' | 'hub_only' | 'partial' | 'unknown';
export type QuotaRemainingKind = 'exact' | 'hub_headroom' | 'estimate' | 'unknown';
export type QuotaResetPolicy = 'rolling' | 'calendar' | 'provider_reported' | 'unknown';
export type QuotaPoolScope = 'model' | 'provider' | 'shared';

export interface ProviderCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
  rerank: boolean;
  longContext: boolean;
}

export interface ProviderLimitConfig {
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
  monthlyRequests: number | null;
  monthlyTokens: number | null;
  providerUnitsPerMinute?: number | null;
  providerUnitsPerDay?: number | null;
  monthlyProviderUnits?: number | null;
  providerUnitLabel?: string | null;
  confidence: LimitConfidence;
  usageCoverage?: QuotaUsageCoverage;
  resetPolicy?: QuotaResetPolicy;
  poolScope?: QuotaPoolScope;
  poolKey?: string | null;
  sourceLabel?: string | null;
  updatedAt?: number | null;
}

export interface ProviderQuotaSnapshot {
  providerId: string;
  modelId?: string;
  metricKind: QuotaMetricKind;
  windowScope: QuotaWindowScope;
  limit: number;
  remaining: number;
  resetAt?: number | null;
  observedAt?: number | null;
  confidence?: LimitConfidence;
  usageCoverage?: QuotaUsageCoverage;
  resetPolicy?: QuotaResetPolicy;
  poolScope?: QuotaPoolScope;
  poolKey?: string | null;
  metricLabel?: string | null;
  sourceLabel?: string | null;
}

// ─── Model info ───────────────────────────────────────────────────────────────
export interface ModelInfo {
  id: string;
  providerId: string;
  name: string;
  qualityTier: QualityTier;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: Partial<ProviderCapabilities>;
  aliases: string[];
  isFree: boolean;
  limitConfig?: Partial<ProviderLimitConfig>;
}

// ─── Chat message types ───────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ─── Route request (external, OpenAI-like) ───────────────────────────────────
export interface RouteRequest {
  messages?: ChatMessage[];
  prompt?: string;
  model?: string;
  // Hub-specific extensions
  route_policy?: string;
  model_alias?: string;
  preferred_provider?: string;
  forbid_paid?: boolean;
  prefer_local?: boolean;
  prefer_external?: boolean;
  exclude_local_on_alias?: string[];
  explicit_provider_order?: string[];
  max_provider_hops?: number;
  cache_policy?: 'default' | 'bypass' | 'force';
  stability_level?: 'normal' | 'strict';
  task_profile?: RouteTaskProfile;
  request_tags?: string[];
  project_id?: string;
  prefer_tool_stability?: boolean;
  require_same_or_better_quality?: boolean;
  allow_downgrade_with_approval?: boolean;
  interactive_warning_mode?: boolean;
  // Standard OpenAI fields passed through
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: Tool[];
  tool_choice?: unknown;
  response_format?: { type: string };
  stop?: string | string[];
  [key: string]: unknown;
}

// ─── Internal adapter request ─────────────────────────────────────────────────
export interface AdapterRequest {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: Tool[];
  toolChoice?: unknown;
  responseFormat?: { type: string };
  stop?: string | string[];
  projectId?: string;
}

export interface EmbeddingRequest {
  input: string | string[];
  model: string;
  projectId?: string;
}

export interface RerankRequest {
  query: string;
  documents: string[];
  model?: string;
  topN?: number;
  projectId?: string;
}

// ─── Adapter responses ────────────────────────────────────────────────────────
export interface AdapterResponse {
  id: string;
  content: string;
  finishReason: string | null;
  usage: UsageEstimate;
  quotaSnapshots?: ProviderQuotaSnapshot[];
  rawResponse?: unknown;
  streamResponse?: NodeJS.ReadableStream;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  usage: UsageEstimate;
  quotaSnapshots?: ProviderQuotaSnapshot[];
}

export interface RerankResponse {
  results: Array<{ index: number; relevanceScore: number; document?: string }>;
  usage?: UsageEstimate;
  quotaSnapshots?: ProviderQuotaSnapshot[];
}

// ─── Usage ────────────────────────────────────────────────────────────────────
export interface UsageEstimate {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerUnits?: number;
}

// ─── Route decision ───────────────────────────────────────────────────────────
export interface RouteDecision {
  selectedProvider: string;
  selectedModel: string;
  classifiedAs: RequestClass;
  requestedAlias?: string | null;
  taskProfile?: RouteTaskProfile | null;
  stabilityLevel?: 'normal' | 'strict';
  hopCount: number;
  fallbackReason?: string;
  candidatesConsidered: number;
  scoringFactors: Record<string, number>;
  qualityTier: QualityTier;
}

// ─── Route result ─────────────────────────────────────────────────────────────
export interface RouteResult {
  id: string;
  providerId: string;
  upstreamModel: string;
  normalizedAlias: string;
  qualityTier: QualityTier;
  cacheHit: boolean;
  estimatedUsage: UsageEstimate;
  warnings: string[];
  downgradeApprovalRequired: boolean;
  routeDecision: RouteDecision;
  output: unknown;
  streamResponse?: NodeJS.ReadableStream;
}

// ─── Health state ─────────────────────────────────────────────────────────────
export interface ProviderHealth {
  providerId: string;
  healthy: boolean;
  lastCheckAt: number;
  latencyMs: number;
  lastError: string | null;
  lastFailureType: FailureType | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  cooldownUntil: number | null;
  quarantineUntil: number | null;
}

export interface ModelHealth {
  providerId: string;
  modelId: string;
  healthy: boolean;
  lastCheckAt: number;
  latencyMs: number;
  lastError: string | null;
  lastFailureType: FailureType | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  cooldownUntil: number | null;
  quarantineUntil: number | null;
}

// ─── Limit state ─────────────────────────────────────────────────────────────
export type LimitWindowType = 'rpm' | 'rpd' | 'tpm' | 'tpd' | 'monthly';

export interface LimitState {
  providerId: string;
  modelId?: string;
  windowType: LimitWindowType;
  windowScope: QuotaWindowScope;
  windowLabel: string;
  metricKind: QuotaMetricKind;
  metricLabel: string;
  used: number;
  limit: number;
  remaining: number;
  remainingPct: number;
  confidence: LimitConfidence;
  usageCoverage: QuotaUsageCoverage;
  remainingKind: QuotaRemainingKind;
  resetPolicy: QuotaResetPolicy;
  poolScope: QuotaPoolScope;
  poolKey?: string | null;
  sourceLabel?: string | null;
  freshnessMs?: number | null;
  exhausted: boolean;
  resetAt: number | null;
  pctUsed: number;
  warnAt70: boolean;
  warnAt85: boolean;
  warnAt95: boolean;
}

// ─── Warning ──────────────────────────────────────────────────────────────────
export type WarningLevel = 'info' | 'warn' | 'critical';

export interface ProviderWarning {
  id: string;
  providerId: string;
  level: WarningLevel;
  message: string;
  sameTierAlternatives: string[];
  lowerTierAlternatives: string[];
  approvalToken?: string;
  createdAt: number;
  resolvedAt?: number;
}

// ─── Failure classification ───────────────────────────────────────────────────
export type FailureType =
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_failure'
  | 'timeout'
  | 'server_error'
  | 'network_error'
  | 'content_filter'
  | 'context_too_long'
  | 'unknown';

// ─── Adapter candidate for routing ───────────────────────────────────────────
export interface RoutingCandidate {
  providerId: string;
  model: ModelInfo;
  score: number;
  factors: Record<string, number>;
}

// ─── Project client token ─────────────────────────────────────────────────────
export interface ClientToken {
  id: string;
  label: string;
  tokenHash: string;
  projectId: string;
  readOnly: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

// ─── Request log entry ────────────────────────────────────────────────────────
export interface RequestLogEntry {
  id: string;
  projectId: string | null;
  classifiedAs: RequestClass;
  selectedProvider: string;
  selectedModel: string;
  qualityTier: QualityTier;
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  fallbackChain: string[];
  downgraded: boolean;
  timestamp: number;
}

export type ProviderState =
  | 'disabled'
  | 'missing_auth'
  | 'healthy'
  | 'degraded'
  | 'cooling_down'
  | 'quarantined'
  | 'circuit_open'
  | 'recovering';

// ─── Provider status summary (for dashboard/API) ─────────────────────────────
export interface ProviderStatus {
  id: string;
  name: string;
  enabled: boolean;
  authenticated: boolean;
  healthy: boolean;
  status: ProviderState;
  routable: boolean;
  blockingReason: string | null;
  circuitOpen: boolean;
  cooldownUntil: number | null;
  quarantineUntil: number | null;
  recoveryAt: number | null;
  recoveryInMs: number | null;
  lastCheckAt: number | null;
  lastLatencyMs: number;
  lastError: string | null;
  lastFailureType: FailureType | null;
  consecutiveFailures: number;
  capabilities: ProviderCapabilities;
  models: ModelInfo[];
  limits: LimitState[];
}

// ─── Hub mode flags ───────────────────────────────────────────────────────────
export interface HubModes {
  freeOnly: boolean;
  localOnly: boolean;
  premiumEnabled: boolean;
}

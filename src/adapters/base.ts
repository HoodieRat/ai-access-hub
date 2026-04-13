import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderLimitConfig,
  AdapterRequest,
  AdapterResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  RerankRequest,
  RerankResponse,
  UsageEstimate,
  ProviderHealth,
  LimitState,
  FailureType,
  QualityTier,
  ProviderQuotaSnapshot,
} from '../types';

// ─── Health check result ──────────────────────────────────────────────────────
export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  error?: string;
  failureType?: FailureType;
}

// ─── Provider feature set ─────────────────────────────────────────────────────
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  chat: true,
  streaming: true,
  tools: false,
  vision: false,
  structuredOutput: false,
  embeddings: false,
  rerank: false,
  longContext: false,
};

// ─── Base adapter contract ────────────────────────────────────────────────────
export abstract class BaseAdapter {
  abstract readonly providerId: string;
  abstract readonly providerName: string;
  abstract readonly authType: string;
  abstract readonly capabilities: ProviderCapabilities;
  abstract readonly qualityTier: QualityTier;
  abstract readonly defaultLimitConfig: ProviderLimitConfig;

  protected _enabled = false;
  protected _authenticated = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  abstract initialize(): Promise<void>;
  abstract healthCheck(): Promise<HealthCheckResult>;
  abstract listModels(): Promise<ModelInfo[]>;

  // ── Execution ─────────────────────────────────────────────────────────────
  abstract executeCompletion(req: AdapterRequest): Promise<AdapterResponse>;

  executeEmbeddings(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    return Promise.reject(new Error(`${this.providerId} does not support embeddings`));
  }

  executeRerank(_req: RerankRequest): Promise<RerankResponse> {
    return Promise.reject(new Error(`${this.providerId} does not support rerank`));
  }

  // ── State ──────────────────────────────────────────────────────────────────
  abstract getRateState(): LimitState[];
  abstract classifyFailure(error: unknown): FailureType;
  abstract normalizeUsage(rawUsage: unknown): UsageEstimate;

  isEnabled(): boolean { return this._enabled; }
  isAuthenticated(): boolean { return this._authenticated; }

  // ── Cost estimation ────────────────────────────────────────────────────────
  estimateRequestCost(messages: Array<{ role: string; content: string | null }>): UsageEstimate {
    const text = messages.map(m => m.content ?? '').join(' ');
    const promptTokens = estimateTokens(text);
    return {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
    };
  }
}

// ─── Token estimation (character heuristic) ───────────────────────────────────
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~3.5 chars per token for typical English/code
  return Math.max(1, Math.ceil(text.length / 3.5));
}

export function estimateMessagesTokens(messages: Array<{ role?: string; content?: string | null | unknown }>): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    total += estimateTokens(content) + 4; // 4 tokens for message overhead
  }
  return total + 3; // 3 tokens for conversation overhead
}

// ─── Common HTTP helpers ──────────────────────────────────────────────────────
export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function doFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...fetchOpts } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = options.signal
      ? combineSignals(options.signal, controller.signal)
      : controller.signal;
    return await fetch(url, {
      method: fetchOpts.method ?? 'GET',
      headers: fetchOpts.headers,
      body: fetchOpts.body,
      signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Provider error ───────────────────────────────────────────────────────────
export class ProviderError extends Error {
  public readonly quotaSnapshots?: ProviderQuotaSnapshot[];

  constructor(
    message: string,
    public readonly failureType: FailureType,
    public readonly statusCode?: number,
    public readonly retryable = false,
    quotaSnapshots?: ProviderQuotaSnapshot[],
  ) {
    super(message);
    this.name = 'ProviderError';
    this.quotaSnapshots = quotaSnapshots;
  }
}

export function classifyHttpError(status: number, body?: string): FailureType {
  const text = body?.toLowerCase() ?? '';

  if (text.includes('insufficient_quota')
    || text.includes('quota')
    || text.includes('billing')
    || text.includes('spending limit')
    || text.includes('invoice')
    || text.includes('suspended')) {
    return 'quota_exhausted';
  }

  if (status === 401 || status === 403) return 'auth_failure';
  if (status === 402) return 'quota_exhausted';
  if (status === 412 && text) return 'quota_exhausted';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'unknown';
  if (status === 422 || status === 400) {
    if (text.includes('context') || text.includes('token')) return 'context_too_long';
    if (text.includes('content') || text.includes('filter') || text.includes('safety')) return 'content_filter';
    return 'unknown';
  }
  if (status >= 500) return 'server_error';
  return 'unknown';
}

export function inferFailureTypeFromError(errorText: string): FailureType {
  const text = errorText.trim();
  if (!text) return 'unknown';

  const httpMatch = text.match(/HTTP\s+(\d{3})(?:\s+[\-–]\s+([\s\S]+))?/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    const body = httpMatch[2] ?? text;
    return classifyHttpError(status, body);
  }

  const lower = text.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) return 'timeout';
  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('authentication') || lower.includes('invalid api key')) {
    return 'auth_failure';
  }
  if (lower.includes('quota')
    || lower.includes('billing')
    || lower.includes('spending limit')
    || lower.includes('invoice')
    || lower.includes('suspended')) {
    return 'quota_exhausted';
  }
  if (lower.includes('network')
    || lower.includes('fetch failed')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
    || lower.includes('eai_again')) {
    return 'network_error';
  }
  if ((lower.includes('context') || lower.includes('token')) && (lower.includes('too long') || lower.includes('limit'))) {
    return 'context_too_long';
  }
  if (lower.includes('content') && (lower.includes('filter') || lower.includes('safety'))) {
    return 'content_filter';
  }

  return 'unknown';
}

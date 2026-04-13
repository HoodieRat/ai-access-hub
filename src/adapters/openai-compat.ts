/**
 * OpenAI-compatible base adapter.
 * Most providers (Groq, Mistral, Cerebras, SambaNova, Fireworks, GitHub Models,
 * GitHub Copilot, Codex, OpenRouter, Local) share this base since they implement
 * the OpenAI chat completions API.
 */

import { Readable } from 'stream';
import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderLimitConfig,
  AdapterRequest,
  AdapterResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  UsageEstimate,
  LimitState,
  FailureType,
  QualityTier,
} from '../types';
import {
  BaseAdapter,
  HealthCheckResult,
  ProviderError,
  classifyHttpError,
  doFetch,
  estimateMessagesTokens,
  estimateTokens,
} from './base';
import { extractProviderQuotaSnapshots } from '../quota-sync';

export interface OpenAICompatConfig {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  authHeaderPrefix?: string;  // default: 'Bearer'
  extraHeaders?: Record<string, string>;
  capabilities: ProviderCapabilities;
  qualityTier: QualityTier;
  defaultLimitConfig: ProviderLimitConfig;
  defaultModels: ModelInfo[];
  // Whether to try /models endpoint for model discovery
  supportsModelList?: boolean;
}

export abstract class OpenAICompatAdapter extends BaseAdapter {
  readonly providerId: string;
  readonly providerName: string;
  readonly capabilities: ProviderCapabilities;
  readonly qualityTier: QualityTier;
  readonly defaultLimitConfig: ProviderLimitConfig;
  readonly authType = 'api_key';

  protected baseUrl: string;
  protected apiKey: string;
  protected authHeaderPrefix: string;
  protected extraHeaders: Record<string, string>;
  protected defaultModels: ModelInfo[];
  protected supportsModelList: boolean;

  protected _models: ModelInfo[] = [];

  constructor(cfg: OpenAICompatConfig) {
    super();
    this.providerId = cfg.providerId;
    this.providerName = cfg.providerName;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
    this.authHeaderPrefix = cfg.authHeaderPrefix ?? 'Bearer';
    this.extraHeaders = cfg.extraHeaders ?? {};
    this.capabilities = cfg.capabilities;
    this.qualityTier = cfg.qualityTier;
    this.defaultLimitConfig = cfg.defaultLimitConfig;
    this.defaultModels = cfg.defaultModels;
    this.supportsModelList = cfg.supportsModelList ?? false;
    this._models = [...cfg.defaultModels];
  }

  override async initialize(): Promise<void> {
    this._enabled = true;
    this._authenticated = !!(this.apiKey);

    if (this.supportsModelList && this.apiKey) {
      try {
        const fetched = await this.fetchModelList();
        if (fetched.length > 0) this._models = fetched;
      } catch {
        // Non-fatal: keep default models
      }
    }
  }

  protected authHeaders(): Record<string, string> {
    return {
      Authorization: `${this.authHeaderPrefix} ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
  }

  override async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const url = this.supportsModelList
        ? `${this.baseUrl}/models`
        : `${this.baseUrl}/chat/completions`;

      if (this.supportsModelList) {
        const resp = await doFetch(url, {
          headers: this.authHeaders(),
          timeoutMs: 10_000,
        });
        const latencyMs = Date.now() - start;
        if (resp.ok || resp.status === 401) {
          return { healthy: resp.ok, latencyMs, error: resp.ok ? undefined : 'Auth failure' };
        }
        const text = await resp.text().catch(() => '');
        return {
          healthy: false,
          latencyMs,
          error: `HTTP ${resp.status}${text ? ` – ${text.slice(0, 200)}` : ''}`,
        };
      } else {
        // Ping with a minimal completion (1-token check)
        const resp = await doFetch(url, {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({
            model: this._models[0]?.id ?? 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          timeoutMs: 15_000,
        });
        const latencyMs = Date.now() - start;
        const text = resp.ok ? '' : await resp.text().catch(() => '');
        return {
          healthy: resp.ok,
          latencyMs,
          error: resp.ok ? undefined : `HTTP ${resp.status}${text ? ` – ${text.slice(0, 200)}` : ''}`,
        };
      }
    } catch (e: unknown) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    return this._models;
  }

  protected async fetchModelList(): Promise<ModelInfo[]> {
    const resp = await doFetch(`${this.baseUrl}/models`, {
      headers: this.authHeaders(),
      timeoutMs: 10_000,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { data?: Array<{ id: string }> };
    if (!data?.data) return [];
    // Map to ModelInfo using default model metadata as a template
    return data.data.map(m => {
      const existing = this.defaultModels.find(dm => dm.id === m.id);
      if (existing) return existing;
      return {
        id: m.id,
        providerId: this.providerId,
        name: m.id,
        qualityTier: this.qualityTier,
        contextWindow: 8192,
        maxOutputTokens: 4096,
        capabilities: this.capabilities,
        aliases: [],
        isFree: true,
      } satisfies ModelInfo;
    });
  }

  override async executeCompletion(req: AdapterRequest): Promise<AdapterResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.tools?.length) body.tools = req.tools;
    if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
    if (req.responseFormat) body.response_format = req.responseFormat;
    if (req.stop) body.stop = req.stop;
    if (req.stream) body.stream = true;

    const resp = await doFetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });
    const quotaSnapshots = extractProviderQuotaSnapshots(this.providerId, resp.headers, req.model);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const failureType = classifyHttpError(resp.status, text);
      throw new ProviderError(
        `${this.providerId}: HTTP ${resp.status} – ${text.slice(0, 200)}`,
        failureType,
        resp.status,
        failureType === 'rate_limit' || failureType === 'server_error',
        quotaSnapshots,
      );
    }

    if (req.stream) {
      if (!resp.body) throw new ProviderError('No response body for stream', 'unknown');
      // Convert Web ReadableStream to Node Readable
      const nodeStream = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
      const promptTokens = estimateMessagesTokens(req.messages);
      return {
        id: `stream-${Date.now()}`,
        content: '',
        finishReason: null,
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
        quotaSnapshots,
        streamResponse: nodeStream,
      };
    }

    const data = (await resp.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason ?? null;
    const usage = this.normalizeUsage(data.usage);

    return {
      id: data.id ?? `${this.providerId}-${Date.now()}`,
      content,
      finishReason,
      usage,
      quotaSnapshots,
      rawResponse: data,
    };
  }

  override async executeEmbeddings(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.capabilities.embeddings) {
      throw new ProviderError(`${this.providerId} does not support embeddings`, 'unknown');
    }
    const url = `${this.baseUrl}/embeddings`;
    const body = { model: req.model, input: req.input };

    const resp = await doFetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });
    const quotaSnapshots = extractProviderQuotaSnapshots(this.providerId, resp.headers, req.model);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ProviderError(
        `${this.providerId} embeddings: HTTP ${resp.status}`,
        classifyHttpError(resp.status, text),
        resp.status,
        false,
        quotaSnapshots,
      );
    }

    const data = (await resp.json()) as { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } };
    const embeddings = data.data.map(d => d.embedding);
    const promptTokens = data.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(req.input));
    return {
      embeddings,
      usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
      quotaSnapshots,
    };
  }

  override getRateState(): LimitState[] {
    return []; // Populated by limit engine from DB
  }

  override classifyFailure(error: unknown): FailureType {
    if (error instanceof ProviderError) return error.failureType;
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('abort')) return 'timeout';
      if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused')) return 'network_error';
    }
    return 'unknown';
  }

  override normalizeUsage(rawUsage: unknown): UsageEstimate {
    const u = rawUsage as {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    } | null;
    if (!u) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const promptTokens = u.prompt_tokens ?? 0;
    const completionTokens = u.completion_tokens ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: u.total_tokens ?? promptTokens + completionTokens,
    };
  }
}

// ─── Response shape ───────────────────────────────────────────────────────────
interface OpenAIResponse {
  id?: string;
  choices?: Array<{
    message?: { content?: string; role?: string };
    finish_reason?: string;
    delta?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

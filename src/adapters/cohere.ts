/**
 * Cohere adapter.
 * Uses Cohere's native v2 API for chat, plus the rerank and embed endpoints.
 * Also uses the OpenAI-compatible endpoint for easier chat passthrough.
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
  RerankRequest,
  RerankResponse,
  UsageEstimate,
  LimitState,
  FailureType,
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
import { getConfig } from '../config';

const BASE_URL = 'https://api.cohere.ai';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: false,
  structuredOutput: false, embeddings: true, rerank: true, longContext: true,
};

const CHAT_MODELS: ModelInfo[] = [
  {
    id: 'command-r-plus',
    providerId: 'cohere', name: 'Command R+',
    qualityTier: 'tier_free_strong', contextWindow: 128_000, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['strong-free'], isFree: true,
  },
  {
    id: 'command-r',
    providerId: 'cohere', name: 'Command R',
    qualityTier: 'tier_free_fast', contextWindow: 128_000, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
  },
];

const UTILITY_MODELS: ModelInfo[] = [
  {
    id: 'embed-english-v3.0',
    providerId: 'cohere', name: 'Embed English v3',
    qualityTier: 'tier_free_strong', contextWindow: 512, maxOutputTokens: 0,
    capabilities: { ...CAPS, chat: false }, aliases: ['embeddings-strong'], isFree: true,
  },
  {
    id: 'rerank-english-v3.0',
    providerId: 'cohere', name: 'Rerank English v3',
    qualityTier: 'tier_free_strong', contextWindow: 4096, maxOutputTokens: 0,
    capabilities: { ...CAPS, chat: false, rerank: true }, aliases: ['rerank-strong'], isFree: true,
  },
];

export class CohereAdapter extends BaseAdapter {
  readonly providerId = 'cohere';
  readonly providerName = 'Cohere';
  readonly authType = 'api_key';
  readonly capabilities = CAPS;
  readonly qualityTier = 'tier_free_strong' as const;
  readonly defaultLimitConfig: ProviderLimitConfig = {
    rpm: null,
    rpd: null,
    tpm: null,
    tpd: null,
    monthlyRequests: 1_000,
    monthlyTokens: null,
    confidence: 'official',
    poolScope: 'provider',
    poolKey: 'trial-key',
    sourceLabel: 'Cohere trial or evaluation monthly call cap',
  };

  private apiKey = '';
  private models: ModelInfo[] = UTILITY_MODELS;
  private chatEnabled = false;

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.cohere;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
    this.chatEnabled = pCfg.chatEnabled === true;
    this.models = this.chatEnabled ? [...CHAT_MODELS, ...UTILITY_MODELS] : [...UTILITY_MODELS];
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  override async healthCheck(): Promise<HealthCheckResult> {
    if (!this.apiKey) return { healthy: false, latencyMs: 0, error: 'No API key' };
    const start = Date.now();
    try {
      if (!this.chatEnabled) {
        const resp = await doFetch(`${BASE_URL}/v2/embed`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model: 'embed-english-v3.0',
            texts: ['health check'],
            input_type: 'search_document',
            embedding_types: ['float'],
          }),
          timeoutMs: 10_000,
        });
        const latencyMs = Date.now() - start;
        const text = resp.ok ? '' : await resp.text().catch(() => '');
        return {
          healthy: resp.ok,
          latencyMs,
          error: resp.ok ? undefined : `HTTP ${resp.status}${text ? ` – ${text.slice(0, 200)}` : ''}`,
          failureType: resp.ok ? undefined : classifyHttpError(resp.status, text),
        };
      }

      const resp = await doFetch(`${BASE_URL}/compatibility/openai/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: 'command-r',
          messages: [{ role: 'user', content: 'health check' }],
          max_tokens: 1,
        }),
        timeoutMs: 10_000,
      });
      const latencyMs = Date.now() - start;
      const text = resp.ok ? '' : await resp.text().catch(() => '');
      return {
        healthy: resp.ok,
        latencyMs,
        error: resp.ok ? undefined : `HTTP ${resp.status}${text ? ` – ${text.slice(0, 200)}` : ''}`,
        failureType: resp.ok ? undefined : classifyHttpError(resp.status, text),
      };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - start, error: String(e) };
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  override async executeCompletion(req: AdapterRequest): Promise<AdapterResponse> {
    if (!this.chatEnabled) {
      throw new ProviderError('cohere chat routing is disabled; enable COHERE_CHAT_ENABLED=true only after verifying the compat endpoint', 'unknown');
    }

    // Use OpenAI-compat endpoint for simpler mapping
    const url = `${BASE_URL}/compatibility/openai/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.stream) body.stream = true;

    const resp = await doFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const failureType = classifyHttpError(resp.status, text);
      throw new ProviderError(`cohere: HTTP ${resp.status} – ${text.slice(0, 200)}`, failureType, resp.status,
        failureType === 'rate_limit');
    }

    if (req.stream) {
      if (!resp.body) throw new ProviderError('No body', 'unknown');
      const nodeStream = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
      const promptTokens = estimateMessagesTokens(req.messages);
      return {
        id: `cohere-stream-${Date.now()}`,
        content: '',
        finishReason: null,
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
        streamResponse: nodeStream,
      };
    }

    const data = await resp.json() as { id?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const choice = data.choices?.[0];
    return {
      id: data.id ?? `cohere-${Date.now()}`,
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage: this.normalizeUsage(data.usage),
      rawResponse: data,
    };
  }

  override async executeEmbeddings(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const url = `${BASE_URL}/v2/embed`;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const body = {
      model: req.model || 'embed-english-v3.0',
      texts: inputs,
      input_type: 'search_document',
      embedding_types: ['float'],
    };

    const resp = await doFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ProviderError(`cohere embeddings: HTTP ${resp.status}`, classifyHttpError(resp.status, text), resp.status);
    }

    const data = await resp.json() as { embeddings?: { float?: number[][] }; meta?: { billed_units?: { input_tokens?: number } } };
    const embeddings = data.embeddings?.float ?? [];
    const promptTokens = data.meta?.billed_units?.input_tokens ?? estimateTokens(inputs.join(' '));
    return { embeddings, usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens } };
  }

  override async executeRerank(req: RerankRequest): Promise<RerankResponse> {
    const url = `${BASE_URL}/v2/rerank`;
    const body = {
      model: req.model || 'rerank-english-v3.0',
      query: req.query,
      documents: req.documents,
      top_n: req.topN,
      return_documents: true,
    };

    const resp = await doFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ProviderError(`cohere rerank: HTTP ${resp.status}`, classifyHttpError(resp.status, text), resp.status);
    }

    const data = await resp.json() as {
      results?: Array<{ index: number; relevance_score: number; document?: { text?: string } }>;
      meta?: { billed_units?: { search_units?: number } };
    };

    const promptTokens = estimateTokens([req.query, ...req.documents].join(' '));

    return {
      results: (data.results ?? []).map(r => ({
        index: r.index,
        relevanceScore: r.relevance_score,
        document: r.document?.text,
      })),
      usage: {
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        providerUnits: data.meta?.billed_units?.search_units,
      },
    };
  }

  override getRateState(): LimitState[] { return []; }

  override classifyFailure(error: unknown): FailureType {
    if (error instanceof ProviderError) return error.failureType;
    const msg = String(error).toLowerCase();
    if (msg.includes('timeout') || msg.includes('abort')) return 'timeout';
    return 'unknown';
  }

  override normalizeUsage(rawUsage: unknown): UsageEstimate {
    const u = rawUsage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
    if (!u) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    return {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
    };
  }
}

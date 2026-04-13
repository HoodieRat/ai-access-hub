/**
 * Cloudflare Workers AI adapter.
 * Supports both direct Workers AI and optional AI Gateway routing.
 * Uses its own request/response format (not OpenAI-compatible directly).
 */

import { Readable } from 'stream';
import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderLimitConfig,
  AdapterRequest,
  AdapterResponse,
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

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: false, vision: false,
  structuredOutput: false, embeddings: true, rerank: false, longContext: false,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: '@cf/meta/llama-3.1-8b-instruct',
    providerId: 'cloudflare', name: 'LLaMA 3.1 8B (CF)',
    qualityTier: 'tier_free_fast', contextWindow: 128_000, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    providerId: 'cloudflare', name: 'LLaMA 3.3 70B (CF)',
    qualityTier: 'tier_free_strong', contextWindow: 128_000, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['strong-free'], isFree: true,
  },
  {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    providerId: 'cloudflare', name: 'Qwen 2.5 Coder 32B (CF)',
    qualityTier: 'tier_code_strong', contextWindow: 32_768, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['strong-code'], isFree: true,
  },
  {
    id: '@cf/baai/bge-large-en-v1.5',
    providerId: 'cloudflare', name: 'BGE Large EN (CF)',
    qualityTier: 'tier_free_fast', contextWindow: 512, maxOutputTokens: 0,
    capabilities: { ...CAPS, chat: false, embeddings: true }, aliases: ['embeddings-fast'], isFree: true,
  },
];

export class CloudflareAdapter extends BaseAdapter {
  readonly providerId = 'cloudflare';
  readonly providerName = 'Cloudflare Workers AI';
  readonly authType = 'api_key';
  readonly capabilities = CAPS;
  readonly qualityTier = 'tier_free_fast' as const;
  readonly defaultLimitConfig: ProviderLimitConfig = {
    rpm: 300, rpd: null, tpm: null, tpd: null,
    monthlyRequests: null, monthlyTokens: null, confidence: 'inferred',
  };

  private apiToken = '';
  private accountId = '';
  private gatewayName = '';
  private models: ModelInfo[] = DEFAULT_MODELS;

  private getBaseUrl(modelId: string): string {
    if (this.gatewayName && this.accountId) {
      // Use AI Gateway
      return `https://gateway.ai.cloudflare.com/v1/${this.accountId}/${this.gatewayName}/workers-ai/${modelId}`;
    }
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${modelId}`;
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.cloudflare;
    this._enabled = pCfg.enabled;
    this.apiToken = pCfg.apiKey ?? '';
    this.accountId = pCfg.accountId ?? '';
    this.gatewayName = pCfg.gatewayName ?? '';
    this._authenticated = !!(this.apiToken && this.accountId);
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  override async healthCheck(): Promise<HealthCheckResult> {
    if (!this._authenticated) return { healthy: false, latencyMs: 0, error: 'Not configured' };
    const start = Date.now();
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/models/search?per_page=1`;
      const resp = await doFetch(url, { headers: this.authHeaders(), timeoutMs: 10_000 });
      const latencyMs = Date.now() - start;
      const text = resp.ok ? '' : await resp.text().catch(() => '');
      const hint = resp.status === 403
        ? ' – verify CLOUDFLARE_ACCOUNT_ID and that the token has Workers AI account permissions for this Cloudflare account'
        : '';
      return {
        healthy: resp.ok,
        latencyMs,
        error: resp.ok ? undefined : `HTTP ${resp.status}${text ? ` – ${text.slice(0, 200)}` : hint}`,
      };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - start, error: String(e) };
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  override async executeCompletion(req: AdapterRequest): Promise<AdapterResponse> {
    const modelId = req.model;
    const url = this.getBaseUrl(modelId);

    const body: Record<string, unknown> = { messages: req.messages };
    if (req.stream) body.stream = true;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const resp = await doFetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const failureType = classifyHttpError(resp.status, text);
      throw new ProviderError(`cloudflare: HTTP ${resp.status} – ${text.slice(0, 200)}`,
        failureType, resp.status, failureType === 'rate_limit');
    }

    if (req.stream) {
      if (!resp.body) throw new ProviderError('No body', 'unknown');
      const nodeStream = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
      const transformed = transformCFStream(nodeStream, modelId);
      const promptTokens = estimateMessagesTokens(req.messages);
      return {
        id: `cf-stream-${Date.now()}`,
        content: '',
        finishReason: null,
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
        streamResponse: transformed,
      };
    }

    const data = await resp.json() as CloudflareResponse;
    if (!data.success) {
      const errMsg = data.errors?.[0]?.message ?? 'unknown error';
      throw new ProviderError(`cloudflare: ${errMsg}`, 'server_error');
    }

    const content = data.result?.response ?? '';
    const promptTokens = estimateMessagesTokens(req.messages);
    const completionTokens = estimateTokens(content);
    return {
      id: `cf-${Date.now()}`,
      content,
      finishReason: 'stop',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      rawResponse: data,
    };
  }

  override async executeEmbeddings(req: import('../types').EmbeddingRequest): Promise<import('../types').EmbeddingResponse> {
    const modelId = req.model || '@cf/baai/bge-large-en-v1.5';
    const url = this.getBaseUrl(modelId);
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const body = { text: inputs };

    const resp = await doFetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ProviderError(`cloudflare embeddings: HTTP ${resp.status}`, classifyHttpError(resp.status, text), resp.status);
    }

    const data = await resp.json() as { result?: { data?: number[][] }; success?: boolean };
    const embeddings = data.result?.data ?? [];
    const promptTokens = estimateTokens(inputs.join(' '));
    return { embeddings, usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens } };
  }

  override getRateState(): LimitState[] { return []; }

  override classifyFailure(error: unknown): FailureType {
    if (error instanceof ProviderError) return error.failureType;
    const msg = String(error).toLowerCase();
    if (msg.includes('timeout') || msg.includes('abort')) return 'timeout';
    return 'unknown';
  }

  override normalizeUsage(rawUsage: unknown): UsageEstimate {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}

function transformCFStream(input: NodeJS.ReadableStream, model: string): NodeJS.ReadableStream {
  const { Transform } = require('stream') as typeof import('stream');
  let buffer = '';

  return input.pipe(new Transform({
    transform(chunk: Buffer, _enc: string, cb: () => void) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') {
          if (jsonStr === '[DONE]') this.push('data: [DONE]\n\n');
          continue;
        }
        try {
          const cfChunk = JSON.parse(jsonStr) as { response?: string };
          const openAIChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: cfChunk.response ?? '' }, finish_reason: null }],
          };
          this.push(`data: ${JSON.stringify(openAIChunk)}\n\n`);
        } catch { /* skip */ }
      }
      cb();
    },
    flush(cb: () => void) {
      this.push('data: [DONE]\n\n');
      cb();
    },
  }));
}

interface CloudflareResponse {
  success?: boolean;
  result?: { response?: string };
  errors?: Array<{ message?: string }>;
}

/**
 * Google Gemini adapter.
 * Uses the Google Generative Language REST API (not OpenAI-compatible format).
 * Endpoint: https://generativelanguage.googleapis.com/v1beta
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
  ChatMessage,
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

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const CAPABILITIES: ProviderCapabilities = {
  chat: true,
  streaming: true,
  tools: true,
  vision: true,
  structuredOutput: true,
  embeddings: true,
  rerank: false,
  longContext: true,
};

const LIMIT_CONFIG: ProviderLimitConfig = {
  rpm: 15,        // gemini-1.5-pro free
  rpd: 50,        // gemini-1.5-pro free  
  tpm: 1_000_000, // gemini-1.5-flash free
  tpd: null,
  monthlyRequests: null,
  monthlyTokens: null,
  confidence: 'official',
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'gemini-1.5-flash',
    providerId: 'gemini',
    name: 'Gemini 1.5 Flash',
    qualityTier: 'tier_free_fast',
    contextWindow: 1_048_576,
    maxOutputTokens: 8192,
    capabilities: CAPABILITIES,
    aliases: ['fast-free', 'strong-long-context'],
    isFree: true,
    limitConfig: { rpm: 15, rpd: 1500, tpm: 1_000_000, confidence: 'official' },
  },
  {
    id: 'gemini-1.5-pro',
    providerId: 'gemini',
    name: 'Gemini 1.5 Pro',
    qualityTier: 'tier_free_strong',
    contextWindow: 2_097_152,
    maxOutputTokens: 8192,
    capabilities: CAPABILITIES,
    aliases: ['strong-free'],
    isFree: true,
    limitConfig: { rpm: 2, rpd: 50, confidence: 'official' },
  },
  {
    id: 'gemini-2.0-flash',
    providerId: 'gemini',
    name: 'Gemini 2.0 Flash',
    qualityTier: 'tier_free_strong',
    contextWindow: 1_048_576,
    maxOutputTokens: 8192,
    capabilities: CAPABILITIES,
    aliases: ['strong-free'],
    isFree: true,
    limitConfig: { rpm: 15, rpd: 1500, tpm: 1_000_000, confidence: 'official' },
  },
  {
    id: 'text-embedding-004',
    providerId: 'gemini',
    name: 'Text Embedding 004',
    qualityTier: 'tier_free_fast',
    contextWindow: 2048,
    maxOutputTokens: 0,
    capabilities: { ...CAPABILITIES, chat: false, embeddings: true },
    aliases: ['embeddings-fast', 'embeddings-strong'],
    isFree: true,
  },
];

export class GeminiAdapter extends BaseAdapter {
  readonly providerId = 'gemini';
  readonly providerName = 'Google Gemini';
  readonly authType = 'api_key';
  readonly capabilities = CAPABILITIES;
  readonly qualityTier = 'tier_free_strong' as const;
  readonly defaultLimitConfig = LIMIT_CONFIG;

  private apiKey = '';
  private models: ModelInfo[] = DEFAULT_MODELS;

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.gemini;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey?.trim() ?? '';
    this._authenticated = !!this.apiKey;
  }

  override async healthCheck(): Promise<HealthCheckResult> {
    if (!this.apiKey) return { healthy: false, latencyMs: 0, error: 'No API key' };
    const start = Date.now();
    try {
      const modelId = 'gemini-2.0-flash';
      const url = `${BASE_URL}/models/${modelId}:generateContent?key=${this.apiKey}`;
      const resp = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'health check' }] }],
          generationConfig: { maxOutputTokens: 1 },
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
    const modelId = req.model || 'gemini-1.5-flash';
    const endpoint = req.stream
      ? `${BASE_URL}/models/${modelId}:streamGenerateContent?alt=sse&key=${this.apiKey}`
      : `${BASE_URL}/models/${modelId}:generateContent?key=${this.apiKey}`;

    const geminiBody = buildGeminiRequest(req);

    const resp = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      timeoutMs: 120_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const failureType = classifyHttpError(resp.status, text);
      throw new ProviderError(`gemini: HTTP ${resp.status} – ${text.slice(0, 200)}`, failureType, resp.status,
        failureType === 'rate_limit');
    }

    if (req.stream) {
      if (!resp.body) throw new ProviderError('No response body', 'unknown');
      const nodeStream = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
      // Transform SSE stream from Gemini format to OpenAI format
      const transformed = transformGeminiStream(nodeStream, modelId);
      const promptTokens = estimateMessagesTokens(req.messages);
      return {
        id: `gemini-stream-${Date.now()}`,
        content: '',
        finishReason: null,
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
        streamResponse: transformed,
      };
    }

    const data = await resp.json() as GeminiResponse;
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const finishReason = data.candidates?.[0]?.finishReason ?? null;
    const usage = this.normalizeUsage(data.usageMetadata);

    return {
      id: `gemini-${Date.now()}`,
      content,
      finishReason,
      usage,
      rawResponse: data,
    };
  }

  override async executeEmbeddings(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const modelId = req.model || 'text-embedding-004';
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const url = `${BASE_URL}/models/${modelId}:batchEmbedContents?key=${this.apiKey}`;

    const body = {
      requests: inputs.map(text => ({
        model: `models/${modelId}`,
        content: { parts: [{ text }] },
      })),
    };

    const resp = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ProviderError(`gemini embeddings: HTTP ${resp.status}`, classifyHttpError(resp.status, text), resp.status);
    }

    const data = await resp.json() as { embeddings?: Array<{ values: number[] }> };
    const embeddings = (data.embeddings ?? []).map(e => e.values);
    const promptTokens = estimateTokens(inputs.join(' '));
    return { embeddings, usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens } };
  }

  override getRateState(): LimitState[] { return []; }

  override classifyFailure(error: unknown): FailureType {
    if (error instanceof ProviderError) return error.failureType;
    const msg = String(error).toLowerCase();
    if (msg.includes('timeout') || msg.includes('abort')) return 'timeout';
    if (msg.includes('fetch') || msg.includes('network')) return 'network_error';
    return 'unknown';
  }

  override normalizeUsage(rawUsage: unknown): UsageEstimate {
    const u = rawUsage as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | null;
    if (!u) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const promptTokens = u.promptTokenCount ?? 0;
    const completionTokens = u.candidatesTokenCount ?? 0;
    return { promptTokens, completionTokens, totalTokens: u.totalTokenCount ?? promptTokens + completionTokens };
  }
}

// ─── Gemini request builder ───────────────────────────────────────────────────

function buildGeminiRequest(req: AdapterRequest): Record<string, unknown> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;

  for (const msg of req.messages) {
    const textContent = extractTextContent(msg);
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: textContent }] };
    } else if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: textContent }] });
    } else if (msg.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: textContent }] });
    }
  }

  const result: Record<string, unknown> = { contents };
  if (systemInstruction) result.system_instruction = systemInstruction;

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.topP !== undefined) generationConfig.topP = req.topP;
  if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;

  return result;
}

function extractTextContent(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content ?? '';
  if (Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
  }
  return '';
}

// ─── Stream transformer ───────────────────────────────────────────────────────

function transformGeminiStream(input: NodeJS.ReadableStream, model: string): NodeJS.ReadableStream {
  const { Transform } = require('stream') as typeof import('stream');
  let buffer = '';
  let isFirst = true;

  return input.pipe(new Transform({
    transform(chunk: Buffer, _enc: string, cb: () => void) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const geminiChunk = JSON.parse(jsonStr) as GeminiStreamChunk;
          const text = geminiChunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          const finishReason = geminiChunk.candidates?.[0]?.finishReason;

          const openAIChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: isFirst ? { role: 'assistant', content: text } : { content: text },
              finish_reason: finishReason === 'STOP' ? 'stop' : (finishReason ? finishReason.toLowerCase() : null),
            }],
          };
          isFirst = false;
          this.push(`data: ${JSON.stringify(openAIChunk)}\n\n`);
        } catch {
          // Skip malformed chunks
        }
      }
      cb();
    },
    flush(cb: () => void) {
      this.push('data: [DONE]\n\n');
      cb();
    },
  }));
}

// ─── Gemini response types ────────────────────────────────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

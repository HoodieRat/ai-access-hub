import type { ModelInfo, ProviderCapabilities, ProviderLimitConfig } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { doFetch, type HealthCheckResult } from './base';
import { getConfig } from '../config';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: true,
  structuredOutput: true, embeddings: false, rerank: false, longContext: true,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'openai/gpt-oss-120b:free',
    providerId: 'openrouter', name: 'GPT-OSS 120B (free)',
    qualityTier: 'tier_free_strong', contextWindow: 131_072, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['strong-free', 'reasoning-free'], isFree: true,
  },
  {
    id: 'openai/gpt-oss-20b:free',
    providerId: 'openrouter', name: 'GPT-OSS 20B (free)',
    qualityTier: 'tier_free_fast', contextWindow: 131_072, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
  },
  {
    id: 'google/gemma-4-31b-it:free',
    providerId: 'openrouter', name: 'Gemma 4 31B (free)',
    qualityTier: 'tier_free_strong', contextWindow: 131_072, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['strong-free'], isFree: true,
  },
  {
    id: 'qwen/qwen3-coder:free',
    providerId: 'openrouter', name: 'Qwen 3 Coder (free)',
    qualityTier: 'tier_code_strong', contextWindow: 131_072, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['strong-code'], isFree: true,
  },
];

export class OpenRouterAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.openrouter;
    super({
      providerId: 'openrouter',
      providerName: 'OpenRouter (free)',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: pCfg.apiKey ?? '',
      extraHeaders: {
        'HTTP-Referer': pCfg.siteUrl ?? 'http://localhost:3000',
        'X-Title': pCfg.siteName ?? 'ai-access-hub',
      },
      capabilities: CAPS,
      qualityTier: 'tier_free_strong',
      defaultLimitConfig: {
        rpm: null,
        rpd: null,
        tpm: null,
        tpd: null,
        monthlyRequests: null,
        monthlyTokens: null,
        confidence: 'observed',
      },
      defaultModels: DEFAULT_MODELS,
      supportsModelList: false,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.openrouter;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
  }

  override async healthCheck(): Promise<HealthCheckResult> {
    if (!this.apiKey) return { healthy: false, latencyMs: 0, error: 'No API key' };
    const start = Date.now();
    try {
      const resp = await doFetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        timeoutMs: 10_000,
      });
      const latencyMs = Date.now() - start;
      const text = resp.ok ? '' : await resp.text().catch(() => '');
      return {
        healthy: resp.ok,
        latencyMs,
        error: resp.ok ? undefined : `HTTP ${resp.status}${text ? ` – ${text.slice(0, 200)}` : ''}`,
      };
    } catch (e) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

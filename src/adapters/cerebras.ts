import type { ModelInfo, ProviderCapabilities } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { getConfig } from '../config';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: false,
  structuredOutput: false, embeddings: false, rerank: false, longContext: false,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'llama3.1-8b',
    providerId: 'cerebras', name: 'LLaMA 3.1 8B (Cerebras)',
    qualityTier: 'tier_free_fast', contextWindow: 8_192, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
    limitConfig: { rpm: 30, rpd: 14_400, tpm: 60_000, tpd: 1_000_000, confidence: 'official', sourceLabel: 'Cerebras free inference rate-limit table' },
  },
  {
    id: 'qwen-3-235b-a22b-instruct-2507',
    providerId: 'cerebras', name: 'Qwen 3 235B A22B (Cerebras)',
    qualityTier: 'tier_free_strong', contextWindow: 128_000, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['strong-free'], isFree: true,
    limitConfig: { rpm: 30, rpd: 14_400, tpm: 60_000, tpd: 1_000_000, confidence: 'official', sourceLabel: 'Cerebras free inference rate-limit table' },
  },
];

export class CerebrasAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.cerebras;
    super({
      providerId: 'cerebras',
      providerName: 'Cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKey: pCfg.apiKey ?? '',
      capabilities: CAPS,
      qualityTier: 'tier_free_strong',
      defaultLimitConfig: { rpm: 30, rpd: 14_400, tpm: 60_000, tpd: 1_000_000, monthlyRequests: null, monthlyTokens: null, confidence: 'official', sourceLabel: 'Cerebras free inference rate-limit table' },
      defaultModels: DEFAULT_MODELS,
      supportsModelList: true,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.cerebras;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
  }
}

import type { ModelInfo, ProviderCapabilities } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { getConfig } from '../config';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: false, vision: false,
  structuredOutput: false, embeddings: false, rerank: false, longContext: true,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'DeepSeek-V3.2',
    providerId: 'sambanova', name: 'DeepSeek V3.2 (SambaNova)',
    qualityTier: 'tier_free_strong', contextWindow: 131_072, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['strong-free'], isFree: true,
  },
  {
    id: 'DeepSeek-R1-0528',
    providerId: 'sambanova', name: 'DeepSeek R1 0528 (SambaNova)',
    qualityTier: 'tier_free_strong', contextWindow: 131_072, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['strong-free', 'reasoning-free'], isFree: true,
  },
  {
    id: 'Meta-Llama-3.1-8B-Instruct',
    providerId: 'sambanova', name: 'LLaMA 3.1 8B (SambaNova)',
    qualityTier: 'tier_free_fast', contextWindow: 16_384, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
  },
];

export class SambaNovaAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.sambanova;
    super({
      providerId: 'sambanova',
      providerName: 'SambaNova',
      baseUrl: 'https://api.sambanova.ai/v1',
      apiKey: pCfg.apiKey ?? '',
      capabilities: CAPS,
      qualityTier: 'tier_free_strong',
      defaultLimitConfig: { rpm: null, rpd: null, tpm: null, tpd: null, monthlyRequests: null, monthlyTokens: null, confidence: 'observed' },
      defaultModels: DEFAULT_MODELS,
      supportsModelList: true,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.sambanova;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
  }
}

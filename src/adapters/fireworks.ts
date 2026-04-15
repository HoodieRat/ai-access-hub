import type { ModelInfo, ProviderCapabilities } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { getConfig } from '../config';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: false,
  structuredOutput: false, embeddings: false, rerank: false, longContext: true,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    providerId: 'fireworks', name: 'LLaMA 3.3 70B (Fireworks)',
    qualityTier: 'tier_free_strong', contextWindow: 131_072, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['strong-free'], isFree: false,
  },
  {
    id: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    providerId: 'fireworks', name: 'LLaMA 3.1 8B (Fireworks)',
    qualityTier: 'tier_free_fast', contextWindow: 131_072, maxOutputTokens: 16_384,
    capabilities: CAPS, aliases: ['fast-free'], isFree: false,
  },
  {
    id: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
    providerId: 'fireworks', name: 'Qwen 2.5 Coder 32B (Fireworks)',
    qualityTier: 'tier_code_strong', contextWindow: 32_768, maxOutputTokens: 16_384,
    capabilities: CAPS, aliases: ['strong-code'], isFree: false,
  },
];

export class FireworksAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.fireworks;
    super({
      providerId: 'fireworks',
      providerName: 'Fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      apiKey: pCfg.apiKey ?? '',
      capabilities: CAPS,
      qualityTier: 'tier_free_strong',
      defaultLimitConfig: { rpm: null, rpd: null, tpm: null, tpd: null, monthlyRequests: null, monthlyTokens: null, confidence: 'observed' },
      defaultModels: DEFAULT_MODELS,
      supportsModelList: false,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.fireworks;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
  }
}

import type { ModelInfo, ProviderCapabilities } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { getConfig } from '../config';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: false,
  structuredOutput: true, embeddings: false, rerank: false, longContext: true,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'mistral-large-latest',
    providerId: 'mistral', name: 'Mistral Large',
    qualityTier: 'tier_free_strong', contextWindow: 131_072, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['strong-free'], isFree: true,
  },
  {
    id: 'codestral-latest',
    providerId: 'mistral', name: 'Codestral',
    qualityTier: 'tier_code_strong', contextWindow: 262_144, maxOutputTokens: 16_384,
    capabilities: CAPS, aliases: ['strong-code'], isFree: true,
  },
  {
    id: 'mistral-small-latest',
    providerId: 'mistral', name: 'Mistral Small',
    qualityTier: 'tier_free_fast', contextWindow: 131_072, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
  },
];

export class MistralAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.mistral;
    super({
      providerId: 'mistral',
      providerName: 'Mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: pCfg.apiKey ?? '',
      capabilities: CAPS,
      qualityTier: 'tier_free_strong',
      defaultLimitConfig: { rpm: 5, rpd: null, tpm: 500_000, tpd: null, monthlyRequests: null, monthlyTokens: null, confidence: 'inferred' },
      defaultModels: DEFAULT_MODELS,
      supportsModelList: true,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.mistral;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
  }
}

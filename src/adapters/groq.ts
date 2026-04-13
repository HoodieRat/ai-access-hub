import type { ModelInfo, ProviderCapabilities, ProviderLimitConfig } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { getConfig } from '../config';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: false,
  structuredOutput: true, embeddings: false, rerank: false, longContext: false,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'llama-3.3-70b-versatile',
    providerId: 'groq', name: 'LLaMA 3.3 70B Versatile',
    qualityTier: 'tier_free_strong', contextWindow: 128_000, maxOutputTokens: 32_768,
    capabilities: CAPS, aliases: ['strong-free', 'fast-free'], isFree: true,
    limitConfig: { rpm: 30, rpd: 14_400, tpm: 6_000, tpd: 500_000, confidence: 'official' },
  },
  {
    id: 'llama-3.1-8b-instant',
    providerId: 'groq', name: 'LLaMA 3.1 8B Instant',
    qualityTier: 'tier_free_fast', contextWindow: 131_072, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
    limitConfig: { rpm: 30, rpd: 14_400, tpm: 20_000, tpd: 500_000, confidence: 'official' },
  },
  {
    id: 'gemma2-9b-it',
    providerId: 'groq', name: 'Gemma 2 9B',
    qualityTier: 'tier_free_fast', contextWindow: 8_192, maxOutputTokens: 4_096,
    capabilities: CAPS, aliases: [], isFree: true,
    limitConfig: { rpm: 30, rpd: 14_400, tpm: 15_000, tpd: 500_000, confidence: 'official' },
  },
  {
    id: 'mixtral-8x7b-32768',
    providerId: 'groq', name: 'Mixtral 8x7B',
    qualityTier: 'tier_free_strong', contextWindow: 32_768, maxOutputTokens: 32_768,
    capabilities: CAPS, aliases: [], isFree: true,
    limitConfig: { rpm: 30, rpd: 14_400, tpm: 5_000, tpd: 500_000, confidence: 'official' },
  },
];

export class GroqAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.groq;
    super({
      providerId: 'groq',
      providerName: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: pCfg.apiKey ?? '',
      capabilities: CAPS,
      qualityTier: 'tier_free_strong',
      defaultLimitConfig: {
        rpm: 30, rpd: 14_400, tpm: 6_000, tpd: 500_000,
        monthlyRequests: null, monthlyTokens: null, confidence: 'official',
      },
      defaultModels: DEFAULT_MODELS,
      supportsModelList: true,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.groq;
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
  }
}

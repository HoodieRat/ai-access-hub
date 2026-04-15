import type { ModelInfo, ProviderCapabilities } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { getConfig } from '../config';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: true,
  structuredOutput: true, embeddings: false, rerank: false, longContext: true,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o',
    providerId: 'github-models', name: 'GPT-4o (GitHub)',
    qualityTier: 'tier_free_strong', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: CAPS, aliases: ['strong-free', 'strong-code'], isFree: true,
    limitConfig: { rpm: 10, rpd: 50, tpm: null, tpd: null, confidence: 'official', sourceLabel: 'GitHub Models free API high-tier rate limits' },
  },
  {
    id: 'gpt-4o-mini',
    providerId: 'github-models', name: 'GPT-4o Mini (GitHub)',
    qualityTier: 'tier_free_fast', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: CAPS, aliases: ['fast-free'], isFree: true,
    limitConfig: { rpm: 15, rpd: 150, tpm: null, tpd: null, confidence: 'official', sourceLabel: 'GitHub Models free API low-tier rate limits' },
  },
  {
    id: 'Meta-Llama-3.1-405B-Instruct',
    providerId: 'github-models', name: 'LLaMA 3.1 405B (GitHub)',
    qualityTier: 'tier_free_strong', contextWindow: 131_072, maxOutputTokens: 4_096,
    capabilities: { ...CAPS, vision: false }, aliases: ['strong-free'], isFree: true,
    limitConfig: { rpm: 5, rpd: 50, tpm: null, tpd: null, confidence: 'official', sourceLabel: 'GitHub Models free API high-tier rate limits' },
  },
  {
    id: 'Phi-3.5-MoE-instruct',
    providerId: 'github-models', name: 'Phi-3.5 MoE (GitHub)',
    qualityTier: 'tier_free_fast', contextWindow: 131_072, maxOutputTokens: 4_096,
    capabilities: { ...CAPS, vision: false }, aliases: [], isFree: true,
    limitConfig: { rpm: 15, rpd: 150, tpm: null, tpd: null, confidence: 'official', sourceLabel: 'GitHub Models free API low-tier rate limits' },
  },
];

export class GitHubModelsAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers['github-models'];
    super({
      providerId: 'github-models',
      providerName: 'GitHub Models',
      baseUrl: 'https://models.inference.ai.azure.com',
      apiKey: pCfg.apiKey ?? '',
      capabilities: CAPS,
      qualityTier: 'tier_free_strong',
      defaultLimitConfig: { rpm: 10, rpd: 50, tpm: null, tpd: null, monthlyRequests: null, monthlyTokens: null, confidence: 'official', sourceLabel: 'GitHub Models free API rate limits by model tier' },
      defaultModels: DEFAULT_MODELS,
      supportsModelList: false,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers['github-models'];
    this._enabled = pCfg.enabled;
    this.apiKey = pCfg.apiKey ?? '';
    this._authenticated = !!this.apiKey;
  }
}

import type { ModelInfo, ProviderCapabilities, ProviderLimitConfig } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { getConfig } from '../config';

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
  rpm: null,
  rpd: null,
  tpm: null,
  tpd: null,
  monthlyRequests: null,
  monthlyTokens: null,
  confidence: 'inferred',
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'local-default',
    providerId: 'local',
    name: 'Local Default',
    qualityTier: 'tier_local_basic',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    capabilities: CAPABILITIES,
    aliases: ['local-fast', 'local-strong'],
    isFree: true,
  },
];

export class LocalAdapter extends OpenAICompatAdapter {
  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.local;
    const baseUrl = pCfg.baseUrl ?? 'http://localhost:1234/v1';

    super({
      providerId: 'local',
      providerName: 'Local OpenAI-Compatible',
      baseUrl,
      apiKey: 'local',
      authHeaderPrefix: 'Bearer',
      capabilities: CAPABILITIES,
      qualityTier: 'tier_local_basic',
      defaultLimitConfig: LIMIT_CONFIG,
      defaultModels: DEFAULT_MODELS,
      supportsModelList: true,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.local;
    this._enabled = pCfg.enabled;
    // Local endpoints don't need an API key
    this._authenticated = true;

    if (pCfg.models && pCfg.models.length > 0) {
      // User specified known models
      this._models = pCfg.models.map(id => ({
        id,
        providerId: 'local',
        name: id,
        qualityTier: 'tier_local_basic' as const,
        contextWindow: 32768,
        maxOutputTokens: 8192,
        capabilities: CAPABILITIES,
        aliases: [],
        isFree: true,
      }));
    } else {
      // Try to discover models
      try {
        const fetched = await this.fetchModelList();
        if (fetched.length > 0) {
          this._models = fetched.map(m => ({
            ...m,
            qualityTier: 'tier_local_basic' as const,
            isFree: true,
          }));
        }
      } catch {
        this._models = DEFAULT_MODELS;
      }
    }
  }

  protected override authHeaders(): Record<string, string> {
    return {
      Authorization: 'Bearer local',
      'Content-Type': 'application/json',
    };
  }
}

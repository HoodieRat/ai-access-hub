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
    aliases: ['local-fast', 'local-strong', 'strong-free'],
    isFree: true,
  },
];

function buildLocalAliases(modelId: string, modelName?: string): string[] {
  const haystack = `${modelId} ${modelName ?? ''}`.toLowerCase();
  const aliases = new Set<string>(['local-fast', 'local-strong']);

  const looksCodeFocused = /(coder|codestral|devstral|deepseek-coder|qwen.*coder|codegemma|starcoder|codellama|phi-4-mini|phi-4|granite-code)/.test(haystack);
  const looksStrongGeneral = /(70b|72b|123b|235b|405b|mixtral|mistral-large|qwen2\.5-72b|qwen3|deepseek-r1|r1|llama-3\.3|llama3\.3|llama-4|gpt-oss-20b|gpt-oss-120b)/.test(haystack);

  if (looksCodeFocused) {
    aliases.add('strong-code');
  }

  if (looksStrongGeneral || looksCodeFocused || haystack.includes('instruct')) {
    aliases.add('strong-free');
  }

  return [...aliases];
}

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
        aliases: buildLocalAliases(id, id),
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
            aliases: [...new Set([...(m.aliases ?? []), ...buildLocalAliases(m.id, m.name)])],
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

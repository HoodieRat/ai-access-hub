import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { CohereAdapter } from '../src/adapters/cohere';
import { LocalAdapter } from '../src/adapters/local';
import { DEFAULT_CAPABILITIES, ProviderError, type BaseAdapter } from '../src/adapters/base';
import { reloadConfig } from '../src/config';
import { closeDb, setSetting } from '../src/db';
import { getModelHealth, getProviderHealth, recordModelCooldown, recordModelFailure, recordProviderFailure } from '../src/health';
import {
  buildFreeUsageSummary,
  getProviderLimitStates,
  type FreeUsageModelSource,
  type UsageWarning,
} from '../src/limits';
import { extractProviderQuotaSnapshots, recordProviderQuotaSnapshots } from '../src/quota-sync';
import { registry } from '../src/registry';
import { previewRoute, route } from '../src/router';
import { dedupeLimitStates } from '../src/routes/usage';
import { checkDowngrade, formatUsageWarningMessage } from '../src/warnings';
import type { ModelInfo, ProviderLimitConfig, QualityTier, RouteRequest } from '../src/types';

test.describe.configure({ mode: 'serial' });

async function withIsolatedQuotaState(run: () => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-access-hub-quota-'));
  const previousDataDir = process.env.HUB_DATA_DIR;
  const previousLogDir = process.env.HUB_LOG_DIR;

  closeDb();
  process.env.HUB_DATA_DIR = path.join(tempRoot, 'data');
  process.env.HUB_LOG_DIR = path.join(tempRoot, 'logs');
  reloadConfig();

  try {
    await run();
  } finally {
    closeDb();
    if (previousDataDir === undefined) delete process.env.HUB_DATA_DIR;
    else process.env.HUB_DATA_DIR = previousDataDir;
    if (previousLogDir === undefined) delete process.env.HUB_LOG_DIR;
    else process.env.HUB_LOG_DIR = previousLogDir;
    reloadConfig();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function makeModel(overrides: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'providerId' | 'name'>): ModelInfo {
  return {
    id: overrides.id,
    providerId: overrides.providerId,
    name: overrides.name,
    qualityTier: overrides.qualityTier ?? 'tier_free_fast',
    contextWindow: overrides.contextWindow ?? 8192,
    maxOutputTokens: overrides.maxOutputTokens ?? 2048,
    capabilities: overrides.capabilities ?? { chat: true, streaming: true },
    aliases: overrides.aliases ?? [],
    isFree: overrides.isFree ?? true,
    limitConfig: overrides.limitConfig,
  };
}

const TEST_LIMIT_CONFIG: ProviderLimitConfig = {
  rpm: null,
  rpd: null,
  tpm: null,
  tpd: null,
  monthlyRequests: null,
  monthlyTokens: null,
  confidence: 'observed',
};

function makeTestAdapter(params: {
  providerId: string;
  providerName: string;
  models: ModelInfo[];
  qualityTier?: QualityTier;
  enabled?: boolean;
  authenticated?: boolean;
  executeCompletionImpl?: (req: RouteRequest) => Promise<unknown>;
  healthCheckImpl?: () => Promise<{ healthy: boolean; latencyMs: number }>;
}): BaseAdapter {
  return {
    providerId: params.providerId,
    providerName: params.providerName,
    authType: 'none',
    capabilities: DEFAULT_CAPABILITIES,
    qualityTier: params.qualityTier ?? 'tier_free_fast',
    defaultLimitConfig: TEST_LIMIT_CONFIG,
    async initialize() {},
    async healthCheck() {
      if (params.healthCheckImpl) {
        return params.healthCheckImpl();
      }
      return { healthy: true, latencyMs: 5 };
    },
    async listModels() {
      return params.models;
    },
    async executeCompletion(request) {
      if (params.executeCompletionImpl) {
        return params.executeCompletionImpl(request as unknown as RouteRequest) as Promise<never>;
      }

      throw new Error('Not used in router preview tests');
    },
    async executeEmbeddings() {
      throw new Error('Not used in router preview tests');
    },
    async executeRerank() {
      throw new Error('Not used in router preview tests');
    },
    getRateState() {
      return [];
    },
    classifyFailure(error) {
      if (error instanceof ProviderError) {
        return error.failureType;
      }
      return 'unknown';
    },
    normalizeUsage() {
      return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    },
    isEnabled() {
      return params.enabled ?? true;
    },
    isAuthenticated() {
      return params.authenticated ?? true;
    },
    estimateRequestCost(messages) {
      const promptTokens = messages.reduce((total, message) => total + String(message.content ?? '').length, 0);
      return { promptTokens, completionTokens: 0, totalTokens: promptTokens };
    },
  } as unknown as BaseAdapter;
}

async function withMockedRegistry(adapters: BaseAdapter[], run: () => Promise<void>): Promise<void> {
  const registryShim = registry as unknown as {
    initialize?: () => Promise<void>;
    getAllAdapters?: () => BaseAdapter[];
    getAdapter?: (providerId: string) => BaseAdapter | undefined;
  };

  registryShim.initialize = async () => {};
  registryShim.getAllAdapters = () => adapters;
  registryShim.getAdapter = (providerId: string) => adapters.find(adapter => adapter.providerId === providerId);

  try {
    await run();
  } finally {
    delete registryShim.initialize;
    delete registryShim.getAllAdapters;
    delete registryShim.getAdapter;
  }
}

function makeRouteRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    messages: [{ role: 'user', content: 'Write a TypeScript router fix.' }],
    ...overrides,
  };
}

test('parses GitHub Models rate-limit headers into provider-synced snapshots', async () => {
  const snapshots = extractProviderQuotaSnapshots('github-models', {
    'x-ratelimit-limit-requests': '20000',
    'x-ratelimit-remaining-requests': '19999',
    'x-ratelimit-renewalperiod-requests': '60',
    'x-ratelimit-reset-requests': '3',
    'x-ratelimit-limit-tokens': '2000000',
    'x-ratelimit-remaining-tokens': '1999967',
    'x-ratelimit-renewalperiod-tokens': '60',
    'x-ratelimit-reset-tokens': '0',
  }, 'gpt-4o-mini');

  const requestSnapshot = snapshots.find(snapshot => snapshot.metricKind === 'requests' && snapshot.windowScope === 'minute');
  const tokenSnapshot = snapshots.find(snapshot => snapshot.metricKind === 'tokens' && snapshot.windowScope === 'minute');

  expect(requestSnapshot).toMatchObject({
    providerId: 'github-models',
    modelId: undefined,
    metricKind: 'requests',
    windowScope: 'minute',
    limit: 20000,
    remaining: 19999,
    confidence: 'official',
    usageCoverage: 'provider_synced',
    poolScope: 'provider',
  });
  expect(requestSnapshot?.resetAt).toBeGreaterThan(Date.now());
  expect(tokenSnapshot).toMatchObject({
    metricKind: 'tokens',
    windowScope: 'minute',
    limit: 2000000,
    remaining: 1999967,
  });
});

test('parses SambaNova day headers into provider-wide request snapshots', async () => {
  const snapshots = extractProviderQuotaSnapshots('sambanova', {
    'x-ratelimit-limit-requests-day': '20',
    'x-ratelimit-remaining-requests-day': '19',
    'x-ratelimit-reset-requests-day': '1776197156',
  }, 'Meta-Llama-3.1-8B-Instruct');

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({
    providerId: 'sambanova',
    metricKind: 'requests',
    windowScope: 'day',
    limit: 20,
    remaining: 19,
    poolScope: 'provider',
    usageCoverage: 'provider_synced',
  });
  expect(snapshots[0]?.resetAt).toBeGreaterThan(Date.now());
});

test('provider-synced snapshots override hub-only counters for matching windows', async () => {
  await withIsolatedQuotaState(async () => {
    recordProviderQuotaSnapshots([{
      providerId: 'github-models',
      metricKind: 'requests',
      windowScope: 'minute',
      limit: 20000,
      remaining: 19950,
      resetAt: Date.now() + 60_000,
      confidence: 'official',
      usageCoverage: 'provider_synced',
      poolScope: 'provider',
      poolKey: 'github-models',
      sourceLabel: 'github-models rate-limit headers',
    }]);

    const states = getProviderLimitStates('github-models', {
      rpm: 10,
      rpd: 50,
      tpm: null,
      tpd: null,
      monthlyRequests: null,
      monthlyTokens: null,
      confidence: 'observed',
    }, 'gpt-4o-mini');

    const minuteState = states.find(state => state.metricKind === 'requests' && state.windowScope === 'minute');
    const dayState = states.find(state => state.metricKind === 'requests' && state.windowScope === 'day');

    expect(minuteState).toMatchObject({
      usageCoverage: 'provider_synced',
      remainingKind: 'exact',
      poolScope: 'provider',
      remaining: 19950,
      limit: 20000,
      modelId: undefined,
    });
    expect(dayState).toMatchObject({
      usageCoverage: 'hub_only',
      remainingKind: 'estimate',
      limit: 50,
    });
  });
});

test('free-usage summary keeps unknown services visible beside synced services', async () => {
  await withIsolatedQuotaState(async () => {
    recordProviderQuotaSnapshots([{
      providerId: 'github-models',
      metricKind: 'requests',
      windowScope: 'minute',
      limit: 20000,
      remaining: 19990,
      resetAt: Date.now() + 60_000,
      confidence: 'official',
      usageCoverage: 'provider_synced',
      poolScope: 'provider',
      poolKey: 'github-models',
    }]);

    const sources: FreeUsageModelSource[] = [
      {
        providerId: 'github-models',
        providerName: 'GitHub Models',
        model: makeModel({
          id: 'gpt-4o-mini',
          providerId: 'github-models',
          name: 'GPT-4o Mini',
          qualityTier: 'tier_free_fast',
          limitConfig: { rpm: 10, rpd: 50, monthlyRequests: null, monthlyTokens: null, tpm: null, tpd: null, confidence: 'observed' },
        }),
      },
      {
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        model: makeModel({
          id: 'openai/gpt-4o-mini',
          providerId: 'openrouter',
          name: 'GPT-4o Mini',
          qualityTier: 'tier_free_fast',
          limitConfig: undefined,
        }),
      },
    ];

    const summary = buildFreeUsageSummary(sources);
    const unknownSection = summary.sections.find(section => section.key === 'unknown');
    const githubService = summary.sections
      .flatMap(section => section.services)
      .find(service => service.providerId === 'github-models');

    expect(summary.serviceCount).toBe(2);
    expect(summary.trackedServiceCount).toBe(1);
    expect(githubService).toMatchObject({
      providerId: 'github-models',
      usageCoverage: 'provider_synced',
      remainingKind: 'exact',
    });
    expect(githubService?.windows.length).toBeGreaterThan(0);
    expect(unknownSection?.serviceCount).toBe(1);
    expect(unknownSection?.services[0]?.providerId).toBe('openrouter');
  });
});

test('free-usage summary prefers broader windows over minute limits when headroom ratios tie', async () => {
  await withIsolatedQuotaState(async () => {
    const sources: FreeUsageModelSource[] = [
      {
        providerId: 'cohere',
        providerName: 'Cohere',
        model: makeModel({
          id: 'command-r',
          providerId: 'cohere',
          name: 'Command R',
          limitConfig: {
            rpm: 20,
            rpd: null,
            tpm: null,
            tpd: null,
            monthlyRequests: 1_000,
            monthlyTokens: null,
            confidence: 'official',
          },
        }),
      },
    ];

    const summary = buildFreeUsageSummary(sources);
    const service = summary.sections.flatMap(section => section.services)[0];

    expect(service?.primaryWindow?.windowType).toBe('monthly');
    expect(service?.primaryWindow?.windowScope).toBe('month');
  });
});

test('free-usage summary marks published ceilings without live remaining coverage', async () => {
  await withIsolatedQuotaState(async () => {
    const sources: FreeUsageModelSource[] = [
      {
        providerId: 'cloudflare',
        providerName: 'Cloudflare Workers AI',
        model: makeModel({
          id: '@cf/meta/llama-3.1-8b-instruct',
          providerId: 'cloudflare',
          name: 'LLaMA 3.1 8B (CF)',
          limitConfig: {
            rpm: null,
            rpd: null,
            tpm: null,
            tpd: null,
            monthlyRequests: null,
            monthlyTokens: null,
            providerUnitsPerDay: 10_000,
            monthlyProviderUnits: 300_000,
            providerUnitLabel: 'neurons',
            confidence: 'official',
            usageCoverage: 'unknown',
            poolScope: 'provider',
            poolKey: 'workers-ai-free',
          },
        }),
      },
      {
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        model: makeModel({
          id: 'openai/gpt-oss-20b:free',
          providerId: 'openrouter',
          name: 'GPT-OSS 20B (free)',
          limitConfig: undefined,
        }),
      },
    ];

    const summary = buildFreeUsageSummary(sources);
    const cloudflareService = summary.sections.flatMap(section => section.services).find(service => service.providerId === 'cloudflare');
    const summaryCardMap = new Map(summary.summaryCards.map(card => [card.key, card.value]));

    expect(cloudflareService?.primaryWindow).toMatchObject({
      metricKind: 'provider_units',
      remainingKind: 'unknown',
      usageCoverage: 'unknown',
    });
    expect(cloudflareService?.notes).toContain('This row shows the published ceiling only; live remaining is not available yet.');
    expect(summaryCardMap.get('ceiling-only')).toBe(1);
    expect(summaryCardMap.get('unknown')).toBe(1);
  });
});

test('free-usage summary excludes non-recurring paid routes from the free board', async () => {
  await withIsolatedQuotaState(async () => {
    const sources: FreeUsageModelSource[] = [
      {
        providerId: 'fireworks',
        providerName: 'Fireworks',
        model: makeModel({
          id: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
          providerId: 'fireworks',
          name: 'LLaMA 3.1 8B (Fireworks)',
          isFree: false,
        }),
      },
    ];

    const summary = buildFreeUsageSummary(sources);

    expect(summary.serviceCount).toBe(0);
    expect(summary.sections.every(section => section.serviceCount === 0)).toBeTruthy();
  });
});

test('route preview only includes models that explicitly advertise the requested alias in strict mode', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'github-models',
        providerName: 'GitHub Models',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'gpt-4o',
            providerId: 'github-models',
            name: 'GPT-4o',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code', 'strong-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
          makeModel({
            id: 'gpt-4o-mini',
            providerId: 'github-models',
            name: 'GPT-4o Mini',
            aliases: ['fast-free'],
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_free_strong',
        models: [
          makeModel({
            id: 'openai/gpt-4o-mini',
            providerId: 'openrouter',
            name: 'OpenAI GPT-4o Mini',
            aliases: ['strong-free'],
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const preview = await previewRoute(makeRouteRequest({ model_alias: 'strong-code', stability_level: 'strict' }));

      expect(preview.stabilityLevel).toBe('strict');
      expect(preview.candidates).toHaveLength(1);
      expect(preview.candidates[0]).toMatchObject({
        providerId: 'github-models',
        modelId: 'gpt-4o',
        aliasMatch: 'exact',
      });
      expect(preview.candidates.every(candidate => candidate.aliases.includes('strong-code'))).toBeTruthy();
      expect(preview.skipCounts.alias_mismatch).toBe(2);
    });
  });
});

test('route preview broadens strong-code in normal mode when exact aliases are unavailable', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'github-models',
        providerName: 'GitHub Models',
        qualityTier: 'tier_free_strong',
        models: [
          makeModel({
            id: 'gpt-4o',
            providerId: 'github-models',
            name: 'GPT-4o',
            qualityTier: 'tier_free_strong',
            aliases: ['strong-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'local',
        providerName: 'Local',
        qualityTier: 'tier_local_basic',
        models: [
          makeModel({
            id: 'local-default',
            providerId: 'local',
            name: 'Local Default',
            qualityTier: 'tier_local_basic',
            aliases: ['local-strong'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const normalPreview = await previewRoute(makeRouteRequest({ model_alias: 'strong-code' }));
      const strictPreview = await previewRoute(makeRouteRequest({ model_alias: 'strong-code', stability_level: 'strict' }));

      expect(normalPreview.stabilityLevel).toBe('normal');
      expect(normalPreview.candidates.length).toBeGreaterThan(0);
      expect(normalPreview.candidates.every(candidate => candidate.aliasMatch === 'broadened')).toBeTruthy();
      expect(strictPreview.stabilityLevel).toBe('strict');
      expect(strictPreview.candidates).toHaveLength(0);
      expect(strictPreview.skipCounts.alias_mismatch).toBe(2);
    });
  });
});

test('route preview normalizes hub aliases sent via model field', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'qwen3-coder',
            providerId: 'openrouter',
            name: 'Qwen3 Coder',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'local',
        providerName: 'Local',
        qualityTier: 'tier_local_basic',
        models: [
          makeModel({
            id: 'local-dev',
            providerId: 'local',
            name: 'Local Dev',
            qualityTier: 'tier_local_basic',
            aliases: ['local-strong'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const preview = await previewRoute(makeRouteRequest({ model: 'strong-code' }));

      expect(preview.alias).toBe('strong-code');
      expect(preview.candidates.map(candidate => candidate.modelId)).toEqual(['qwen3-coder', 'local-dev']);
      expect(preview.candidates[1]).toMatchObject({
        providerId: 'local',
        aliasMatch: 'broadened',
      });
    });
  });
});

test('route preview keeps sibling models routable when one model is cooling down', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'github-models',
        providerName: 'GitHub Models',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'gpt-4o',
            providerId: 'github-models',
            name: 'GPT-4o',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
          makeModel({
            id: 'gpt-4o-mini',
            providerId: 'github-models',
            name: 'GPT-4o Mini',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      recordModelCooldown('github-models', 'gpt-4o', 60_000);

      const preview = await previewRoute(makeRouteRequest({ model_alias: 'strong-code', stability_level: 'strict' }));

      expect(preview.candidates.map(candidate => candidate.modelId)).toEqual(['gpt-4o-mini']);
      expect(preview.skipCounts.model_cooling_down).toBe(1);
    });
  });
});

test('route preview free_only mode excludes paid alias matches', async () => {
  await withIsolatedQuotaState(async () => {
    setSetting('free_only', 'true');

    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'free-code',
            providerId: 'openrouter',
            name: 'Free Code Model',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            isFree: true,
          }),
          makeModel({
            id: 'paid-code',
            providerId: 'openrouter',
            name: 'Paid Code Model',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            isFree: false,
          }),
        ],
      }),
    ], async () => {
      const preview = await previewRoute(makeRouteRequest({ model_alias: 'strong-code' }));

      expect(preview.effectiveModes.freeOnly).toBe(true);
      expect(preview.candidates.map(candidate => candidate.modelId)).toEqual(['free-code']);
      expect(preview.skipCounts.free_only_mode).toBe(1);
    });
  });
});

test('route preview forbid_paid excludes paid alias matches without global free-only mode', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'free-code',
            providerId: 'openrouter',
            name: 'Free Code Model',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            isFree: true,
          }),
          makeModel({
            id: 'paid-code',
            providerId: 'openrouter',
            name: 'Paid Code Model',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            isFree: false,
          }),
        ],
      }),
    ], async () => {
      const preview = await previewRoute(makeRouteRequest({
        model_alias: 'strong-code',
        forbid_paid: true,
      }));

      expect(preview.effectiveModes.freeOnly).toBe(false);
      expect(preview.candidates.map(candidate => candidate.modelId)).toEqual(['free-code']);
      expect(preview.skipCounts.forbid_paid).toBe(1);
    });
  });
});

test('route preflight rejects oversized max_tokens before adapter execution', async () => {
  await withIsolatedQuotaState(async () => {
    let executeCalls = 0;

    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'github-models',
        providerName: 'GitHub Models',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'gpt-4o',
            providerId: 'github-models',
            name: 'GPT-4o',
            qualityTier: 'tier_code_strong',
            maxOutputTokens: 128,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        async executeCompletionImpl() {
          executeCalls += 1;
          return {
            id: 'test-response',
            content: 'ok',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      }),
    ], async () => {
      await expect(route(makeRouteRequest({ model_alias: 'strong-code', max_tokens: 1024 }))).rejects.toThrow(/Preflight: Requested max_tokens 1024 exceeds gpt-4o's max output 128/i);
      expect(executeCalls).toBe(0);
    });
  });
});

test('exact cache stays scoped to the requested lane alias', async () => {
  await withIsolatedQuotaState(async () => {
    let strongCodeCalls = 0;
    let strongFreeCalls = 0;

    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'code-route',
            providerId: 'openrouter',
            name: 'Code Route',
            qualityTier: 'tier_code_strong',
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        async executeCompletionImpl() {
          strongCodeCalls += 1;
          return {
            id: 'code-response',
            content: 'code',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      }),
      makeTestAdapter({
        providerId: 'groq',
        providerName: 'Groq',
        qualityTier: 'tier_free_strong',
        models: [
          makeModel({
            id: 'free-route',
            providerId: 'groq',
            name: 'Free Route',
            qualityTier: 'tier_free_strong',
            aliases: ['strong-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        async executeCompletionImpl() {
          strongFreeCalls += 1;
          return {
            id: 'free-response',
            content: 'free',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      }),
    ], async () => {
      const strongCodeResult = await route(makeRouteRequest({ model_alias: 'strong-code' }));
      const strongFreeResult = await route(makeRouteRequest({ model_alias: 'strong-free' }));

      expect(strongCodeResult.providerId).toBe('openrouter');
      expect(strongFreeResult.providerId).toBe('groq');
      expect(strongCodeResult.cacheHit).toBe(false);
      expect(strongFreeResult.cacheHit).toBe(false);
      expect(strongCodeCalls).toBe(1);
      expect(strongFreeCalls).toBe(1);
    });
  });
});

test('route preview prunes candidates that fail context preflight before scoring', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'groq',
        providerName: 'Groq',
        qualityTier: 'tier_free_fast',
        models: [
          makeModel({
            id: 'small-fast',
            providerId: 'groq',
            name: 'Small Fast',
            qualityTier: 'tier_free_fast',
            contextWindow: 8192,
            maxOutputTokens: 2048,
            aliases: ['fast-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
          makeModel({
            id: 'large-fast',
            providerId: 'groq',
            name: 'Large Fast',
            qualityTier: 'tier_free_fast',
            contextWindow: 65536,
            maxOutputTokens: 4096,
            aliases: ['fast-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const oversizedPrompt = 'x '.repeat(6000);
      const preview = await previewRoute(makeRouteRequest({
        model_alias: 'fast-free',
        messages: [{ role: 'user', content: oversizedPrompt }],
      }));

      expect(preview.candidates.map(candidate => candidate.modelId)).toEqual(['large-fast']);
      expect(preview.skipCounts.preflight_context_window).toBe(1);
    });
  });
});

test('route preview deprioritizes tiny fast-free models for larger prompts', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'groq',
        providerName: 'Groq',
        qualityTier: 'tier_free_fast',
        models: [
          makeModel({
            id: 'tiny-fast',
            providerId: 'groq',
            name: 'Tiny Fast',
            qualityTier: 'tier_free_fast',
            contextWindow: 16384,
            maxOutputTokens: 2048,
            aliases: ['fast-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
          makeModel({
            id: 'roomy-fast',
            providerId: 'groq',
            name: 'Roomy Fast',
            qualityTier: 'tier_free_fast',
            contextWindow: 131072,
            maxOutputTokens: 4096,
            aliases: ['fast-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const largerPrompt = 'x '.repeat(3500);
      const preview = await previewRoute(makeRouteRequest({
        model_alias: 'fast-free',
        messages: [{ role: 'user', content: largerPrompt }],
      }));

      expect(preview.candidates.map(candidate => candidate.modelId)).toEqual(['roomy-fast', 'tiny-fast']);
      expect(preview.candidates[0]?.score).toBeGreaterThan(preview.candidates[1]?.score ?? 0);
    });
  });
});

test('repo scaffold requests using strong-code broaden toward planning-capable candidates', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'qwen3-coder',
            providerId: 'openrouter',
            name: 'Qwen3 Coder',
            qualityTier: 'tier_code_strong',
            contextWindow: 32768,
            maxOutputTokens: 8192,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'local',
        providerName: 'Local',
        qualityTier: 'tier_local_basic',
        models: [
          makeModel({
            id: 'devstral-small',
            providerId: 'local',
            name: 'Devstral Small',
            qualityTier: 'tier_local_basic',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['local-strong', 'strong-free'],
            capabilities: { chat: true, streaming: true, tools: true, structuredOutput: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'gemini',
        providerName: 'Gemini',
        qualityTier: 'tier_free_long_context',
        models: [
          makeModel({
            id: 'gemini-1.5-pro',
            providerId: 'gemini',
            name: 'Gemini 1.5 Pro',
            qualityTier: 'tier_free_long_context',
            contextWindow: 1048576,
            maxOutputTokens: 8192,
            aliases: ['strong-long-context', 'strong-free'],
            capabilities: { chat: true, streaming: true, tools: true, structuredOutput: true, longContext: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const preview = await previewRoute(makeRouteRequest({
        model_alias: 'strong-code',
        task_profile: 'repo_scaffold',
        tools: [{ type: 'function', function: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } } }],
        messages: [{ role: 'user', content: 'Create a new RPG game from scratch with a folder structure, starter files, assets, inventory system, and save/load support.' }],
      }));

      const rankedCandidates = preview.candidates.map(candidate => `${candidate.providerId}/${candidate.modelId}`);

      expect(preview.classifiedAs).toBe('repo_scaffold');
      expect(rankedCandidates[0]).toBe('gemini/gemini-1.5-pro');
      expect(rankedCandidates).toContain('local/devstral-small');
      expect(rankedCandidates).toContain('openrouter/qwen3-coder');
    });
  });
});

test('fast-free preview broadens into strong free/code models before cerebras for large tool-heavy prompts', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'cerebras',
        providerName: 'Cerebras',
        qualityTier: 'tier_free_fast',
        models: [
          makeModel({
            id: 'llama3.1-8b',
            providerId: 'cerebras',
            name: 'LLaMA 3.1 8B',
            qualityTier: 'tier_free_fast',
            contextWindow: 8192,
            maxOutputTokens: 4096,
            aliases: ['fast-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'qwen3-coder',
            providerId: 'openrouter',
            name: 'Qwen3 Coder',
            qualityTier: 'tier_code_strong',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
          makeModel({
            id: 'gpt-oss-20b',
            providerId: 'openrouter',
            name: 'GPT OSS 20B',
            qualityTier: 'tier_free_fast',
            contextWindow: 131072,
            maxOutputTokens: 4096,
            aliases: ['fast-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'local',
        providerName: 'Local',
        qualityTier: 'tier_local_basic',
        models: [
          makeModel({
            id: 'devstral-small',
            providerId: 'local',
            name: 'Devstral Small',
            qualityTier: 'tier_local_basic',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['local-fast', 'local-strong', 'strong-code', 'strong-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const preview = await previewRoute(makeRouteRequest({
        model_alias: 'fast-free',
        tools: [{ type: 'function', function: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } } }],
        messages: [{ role: 'user', content: 'x '.repeat(7000) }],
      }));

      expect(preview.candidates.map(candidate => `${candidate.providerId}/${candidate.modelId}`)).toEqual([
        'openrouter/gpt-oss-20b',
        'openrouter/qwen3-coder',
        'local/devstral-small',
      ]);
      expect(preview.skipCounts.provider_lane_unfit).toBe(1);
    });
  });
});

test('fast-free route falls through to broader free candidates and cools down exhausted cerebras models', async () => {
  await withIsolatedQuotaState(async () => {
    let cerebrasCalls = 0;
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'cerebras',
        providerName: 'Cerebras',
        qualityTier: 'tier_free_fast',
        models: [
          makeModel({
            id: 'llama3.1-8b',
            providerId: 'cerebras',
            name: 'LLaMA 3.1 8B',
            qualityTier: 'tier_free_fast',
            contextWindow: 131072,
            maxOutputTokens: 4096,
            aliases: ['fast-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        executeCompletionImpl: async () => {
          cerebrasCalls += 1;
          throw new ProviderError(
            'cerebras: HTTP 429 - {"message":"Tokens per minute limit exceeded - too many tokens processed.","type":"too_many_tokens_error","param":"quota","code":"token_quota_exceeded"}',
            'rate_limit',
            429,
            true,
          );
        },
      }),
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'qwen3-coder',
            providerId: 'openrouter',
            name: 'Qwen3 Coder',
            qualityTier: 'tier_code_strong',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        executeCompletionImpl: async () => ({
          id: 'ok',
          content: 'ok',
          finishReason: 'stop',
          usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 },
        }),
      }),
    ], async () => {
      const result = await route(makeRouteRequest({
        model_alias: 'fast-free',
        tools: [{ type: 'function', function: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } } }],
        messages: [{ role: 'user', content: 'Write a fix for this router bug.' }],
        cache_policy: 'bypass',
      }));

      expect(result.providerId).toBe('openrouter');
      expect(result.upstreamModel).toBe('qwen3-coder');
      expect(cerebrasCalls).toBe(0);
      expect(getModelHealth('cerebras', 'llama3.1-8b')).toBeNull();
    });
  });
});

test('route preview no longer leans on mistral first for strong-code when equal alternatives exist', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'mistral',
        providerName: 'Mistral',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'codestral-latest',
            providerId: 'mistral',
            name: 'Codestral Latest',
            qualityTier: 'tier_code_strong',
            contextWindow: 262144,
            maxOutputTokens: 16384,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'qwen3-coder',
            providerId: 'openrouter',
            name: 'Qwen3 Coder',
            qualityTier: 'tier_code_strong',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
      makeTestAdapter({
        providerId: 'local',
        providerName: 'Local',
        qualityTier: 'tier_local_basic',
        models: [
          makeModel({
            id: 'devstral-small',
            providerId: 'local',
            name: 'Devstral Small',
            qualityTier: 'tier_local_basic',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['local-strong', 'strong-code', 'strong-free'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
      }),
    ], async () => {
      const preview = await previewRoute(makeRouteRequest({ model_alias: 'strong-code' }));

      expect(preview.candidates.map(candidate => candidate.providerId)).toEqual(['openrouter', 'local', 'mistral']);
    });
  });
});

test('route falls through when the first candidate returns an empty assistant response', async () => {
  await withIsolatedQuotaState(async () => {
    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'qwen3-coder',
            providerId: 'openrouter',
            name: 'Qwen3 Coder',
            qualityTier: 'tier_code_strong',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        executeCompletionImpl: async () => ({
          id: 'empty',
          content: '   ',
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
        }),
      }),
      makeTestAdapter({
        providerId: 'local',
        providerName: 'Local',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'devstral-small',
            providerId: 'local',
            name: 'Devstral Small',
            qualityTier: 'tier_code_strong',
            contextWindow: 131072,
            maxOutputTokens: 8192,
            aliases: ['local-strong', 'strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        executeCompletionImpl: async () => ({
          id: 'ok',
          content: 'ok',
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        }),
      }),
    ], async () => {
      const result = await route(makeRouteRequest({
        model_alias: 'strong-code',
        messages: [{ role: 'user', content: 'Write a router fix.' }],
        max_provider_hops: 2,
        cache_policy: 'bypass',
      }));

      expect(result.providerId).toBe('local');
      expect(result.upstreamModel).toBe('devstral-small');
      expect(result.routeDecision.hopCount).toBe(1);
    });
  });
});

test('alias-based routing promotes max_provider_hops=1 to allow fallback attempts', async () => {
  await withIsolatedQuotaState(async () => {
    let cerebrasCalls = 0;
    let openrouterCalls = 0;

    await withMockedRegistry([
      makeTestAdapter({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'qwen3-coder',
            providerId: 'openrouter',
            name: 'Qwen3 Coder',
            qualityTier: 'tier_code_strong',
            contextWindow: 131072,
            maxOutputTokens: 4096,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        executeCompletionImpl: async () => {
          openrouterCalls += 1;
          throw new ProviderError('openrouter: HTTP 429 token_quota_exceeded', 'rate_limit', 429, true);
        },
      }),
      makeTestAdapter({
        providerId: 'local',
        providerName: 'Local',
        qualityTier: 'tier_code_strong',
        models: [
          makeModel({
            id: 'devstral-small',
            providerId: 'local',
            name: 'Devstral Small',
            qualityTier: 'tier_code_strong',
            contextWindow: 131072,
            maxOutputTokens: 4096,
            aliases: ['strong-code'],
            capabilities: { chat: true, streaming: true, tools: true },
            isFree: true,
          }),
        ],
        executeCompletionImpl: async () => {
          cerebrasCalls += 1;
          return {
            id: 'ok',
            content: 'fallback-ok',
            finishReason: 'stop',
            usage: { promptTokens: 30, completionTokens: 7, totalTokens: 37 },
          };
        },
      }),
    ], async () => {
      const result = await route(makeRouteRequest({
        model_alias: 'strong-code',
        max_provider_hops: 1,
        cache_policy: 'bypass',
      }));

      expect(result.providerId).toBe('local');
      expect(result.output).toBeTruthy();
      expect(openrouterCalls).toBe(1);
      expect(cerebrasCalls).toBe(1);
    });
  });
});

test('local adapter promotes configured coding and strong local models into strong lanes', async () => {
  await withIsolatedQuotaState(async () => {
    const previousLocalModels = process.env.LOCAL_MODELS;
    process.env.LOCAL_MODELS = 'devstral-small,qwen3-32b-instruct';
    reloadConfig();

    try {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const models = await adapter.listModels();
      const devModel = models.find(model => model.id === 'devstral-small');
      const generalModel = models.find(model => model.id === 'qwen3-32b-instruct');

      expect(devModel?.aliases).toEqual(expect.arrayContaining(['local-strong', 'strong-code', 'strong-free']));
      expect(generalModel?.aliases).toEqual(expect.arrayContaining(['local-strong', 'strong-free']));
    } finally {
      if (previousLocalModels === undefined) delete process.env.LOCAL_MODELS;
      else process.env.LOCAL_MODELS = previousLocalModels;
      reloadConfig();
    }
  });
});

test('persistent provider and model failures are quarantined instead of re-entering immediately', async () => {
  await withIsolatedQuotaState(async () => {
    recordProviderFailure('cohere', 'HTTP 404 page not found', 'unknown');
    recordProviderFailure('cohere', 'HTTP 404 page not found', 'unknown');
    recordProviderFailure('cohere', 'HTTP 404 page not found', 'unknown');

    recordModelFailure('cerebras', 'gpt-oss-120b', 'invalid model id: gpt-oss-120b', 'unknown');
    recordModelFailure('cerebras', 'gpt-oss-120b', 'invalid model id: gpt-oss-120b', 'unknown');
    recordModelFailure('cerebras', 'gpt-oss-120b', 'invalid model id: gpt-oss-120b', 'unknown');

    expect(getProviderHealth('cohere')?.quarantineUntil).toBeGreaterThan(Date.now());
    expect(getModelHealth('cerebras', 'gpt-oss-120b')?.quarantineUntil).toBeGreaterThan(Date.now());
  });
});

test('cohere defaults to utility-only routing when chat is disabled', async () => {
  await withIsolatedQuotaState(async () => {
    const previousEnabled = process.env.COHERE_ENABLED;
    const previousApiKey = process.env.COHERE_API_KEY;
    const previousChatEnabled = process.env.COHERE_CHAT_ENABLED;
    process.env.COHERE_ENABLED = 'true';
    process.env.COHERE_API_KEY = 'test-key';
    process.env.COHERE_CHAT_ENABLED = 'false';
    reloadConfig();

    try {
      const adapter = new CohereAdapter();
      await adapter.initialize();
      const models = await adapter.listModels();

      expect(models.map(model => model.id)).toEqual(['embed-english-v3.0', 'rerank-english-v3.0']);
      expect(models.every(model => model.capabilities.chat === false)).toBeTruthy();
    } finally {
      if (previousEnabled === undefined) delete process.env.COHERE_ENABLED;
      else process.env.COHERE_ENABLED = previousEnabled;
      if (previousApiKey === undefined) delete process.env.COHERE_API_KEY;
      else process.env.COHERE_API_KEY = previousApiKey;
      if (previousChatEnabled === undefined) delete process.env.COHERE_CHAT_ENABLED;
      else process.env.COHERE_CHAT_ENABLED = previousChatEnabled;
      reloadConfig();
    }
  });
});

test('cohere healthCheck probes the compatibility chat lane', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';
  const previousEnabled = process.env.COHERE_ENABLED;
  const previousApiKey = process.env.COHERE_API_KEY;
  const previousChatEnabled = process.env.COHERE_CHAT_ENABLED;
  process.env.COHERE_ENABLED = 'true';
  process.env.COHERE_API_KEY = 'test-key';
  process.env.COHERE_CHAT_ENABLED = 'true';
  reloadConfig();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      id: 'health-check',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const adapter = new CohereAdapter();
    await adapter.initialize();
    const result = await adapter.healthCheck();

    expect(result.healthy).toBeTruthy();
    expect(requestUrl).toContain('/compatibility/openai/v1/chat/completions');
    expect(JSON.parse(requestBody)).toMatchObject({
      model: 'command-r',
      max_tokens: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnabled === undefined) delete process.env.COHERE_ENABLED;
    else process.env.COHERE_ENABLED = previousEnabled;
    if (previousApiKey === undefined) delete process.env.COHERE_API_KEY;
    else process.env.COHERE_API_KEY = previousApiKey;
    if (previousChatEnabled === undefined) delete process.env.COHERE_CHAT_ENABLED;
    else process.env.COHERE_CHAT_ENABLED = previousChatEnabled;
    reloadConfig();
  }
});

test('warning formatting names provider pools explicitly', async () => {
  const warning: UsageWarning = {
    providerId: 'github-models',
    windowType: 'rpm',
    windowLabel: 'minute',
    metricKind: 'requests',
    metricLabel: 'requests',
    modelId: undefined,
    poolScope: 'provider',
    poolKey: 'github-models',
    pctUsed: 95,
    used: 19000,
    limit: 20000,
    level: 'warn95',
  };

  expect(formatUsageWarningMessage('github-models', 'gpt-4o-mini', warning)).toBe(
    'github-models provider pool (github-models) requests/minute: 95% used (19000/20000)'
  );
});

test('dedupeLimitStates collapses provider-wide snapshot duplicates', async () => {
  const deduped = dedupeLimitStates([
    {
      providerId: 'groq',
      modelId: undefined,
      windowType: 'rpm',
      windowScope: 'minute',
      windowLabel: 'minute',
      metricKind: 'requests',
      metricLabel: 'requests',
      used: 1,
      limit: 1000,
      remaining: 999,
      remainingPct: 100,
      confidence: 'official',
      usageCoverage: 'provider_synced',
      remainingKind: 'exact',
      resetPolicy: 'provider_reported',
      poolScope: 'provider',
      poolKey: 'groq',
      sourceLabel: 'groq rate-limit headers',
      freshnessMs: 20,
      exhausted: false,
      resetAt: Date.now() + 60_000,
      pctUsed: 0,
      warnAt70: false,
      warnAt85: false,
      warnAt95: false,
    },
    {
      providerId: 'groq',
      modelId: undefined,
      windowType: 'rpm',
      windowScope: 'minute',
      windowLabel: 'minute',
      metricKind: 'requests',
      metricLabel: 'requests',
      used: 1,
      limit: 1000,
      remaining: 999,
      remainingPct: 100,
      confidence: 'official',
      usageCoverage: 'provider_synced',
      remainingKind: 'exact',
      resetPolicy: 'provider_reported',
      poolScope: 'provider',
      poolKey: 'groq',
      sourceLabel: 'groq rate-limit headers',
      freshnessMs: 10,
      exhausted: false,
      resetAt: Date.now() + 60_000,
      pctUsed: 0,
      warnAt70: false,
      warnAt85: false,
      warnAt95: false,
    },
    {
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      windowType: 'rpd',
      windowScope: 'day',
      windowLabel: 'day',
      metricKind: 'requests',
      metricLabel: 'requests',
      used: 1,
      limit: 14400,
      remaining: 14399,
      remainingPct: 100,
      confidence: 'official',
      usageCoverage: 'hub_only',
      remainingKind: 'hub_headroom',
      resetPolicy: 'calendar',
      poolScope: 'model',
      poolKey: null,
      sourceLabel: 'Hub sliding-window counter',
      freshnessMs: null,
      exhausted: false,
      resetAt: Date.now() + 86_400_000,
      pctUsed: 0,
      warnAt70: false,
      warnAt85: false,
      warnAt95: false,
    },
  ]);

  expect(deduped).toHaveLength(2);
  expect(deduped.find(state => state.poolScope === 'provider')?.freshnessMs).toBe(10);
  expect(deduped.find(state => state.modelId === 'llama-3.3-70b-versatile')).toBeTruthy();
});

test('coding downgrades still require explicit approval', async () => {
  const result = await checkDowngrade(
    'tier_code_strong',
    'tier_free_fast',
    'copilot',
    'code_generation',
    false,
    false,
  );

  expect(result.allowed).toBe(false);
  expect(result.requiresApproval).toBe(true);
  expect(result.approvalToken).toBeTruthy();
  expect(result.warning).toContain('Explicit approval needed');
});

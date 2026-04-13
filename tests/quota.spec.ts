import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { reloadConfig } from '../src/config';
import { closeDb } from '../src/db';
import {
  buildFreeUsageSummary,
  getProviderLimitStates,
  type FreeUsageModelSource,
  type UsageWarning,
} from '../src/limits';
import { extractProviderQuotaSnapshots, recordProviderQuotaSnapshots } from '../src/quota-sync';
import { dedupeLimitStates } from '../src/routes/usage';
import { checkDowngrade, formatUsageWarningMessage } from '../src/warnings';
import type { ModelInfo } from '../src/types';

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
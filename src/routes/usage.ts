import type { FastifyInstance } from 'fastify';
import { getUsageSummary, getRecentLogs } from '../db';
import { getCacheStats } from '../cache';
import type { LimitState } from '../types';

export function dedupeLimitStates(limitStates: LimitState[]): LimitState[] {
  const deduped = new Map<string, LimitState>();

  for (const state of limitStates) {
    const key = [
      state.providerId,
      state.modelId ?? '*',
      state.windowType,
      state.windowScope,
      state.metricKind,
      state.poolScope,
      state.poolKey ?? '',
    ].join(':');

    const existing = deduped.get(key);
    if (!existing || (state.freshnessMs ?? Number.POSITIVE_INFINITY) < (existing.freshnessMs ?? Number.POSITIVE_INFINITY)) {
      deduped.set(key, state);
    }
  }

  return [...deduped.values()];
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/usage', async (req, reply) => {
    const since = (req.query as { since?: string }).since
      ? parseInt((req.query as { since: string }).since, 10)
      : Date.now() - 7 * 86_400_000; // last 7 days

    try {
      const summary = getUsageSummary(since);
      const cache = getCacheStats();
      const total = summary.reduce(
        (acc, s) => ({
          requests: acc.requests + s.totalRequests,
          promptTokens: acc.promptTokens + s.totalPromptTokens,
          completionTokens: acc.completionTokens + s.totalCompletionTokens,
          cacheHits: acc.cacheHits + s.cacheHits,
          errors: acc.errors + s.errors,
        }),
        { requests: 0, promptTokens: 0, completionTokens: 0, cacheHits: 0, errors: 0 },
      );

      reply.send({
        since,
        total,
        by_provider: summary,
        cache: {
          exact_entries: cache.exactEntries,
          exact_hits: cache.exactHits,
          semantic_entries: cache.semanticEntries,
          semantic_hits: cache.semanticHits,
          hit_rate: total.requests > 0
            ? Math.round(((cache.exactHits + cache.semanticHits) / total.requests) * 100)
            : 0,
        },
      });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  app.get('/v1/limits', async (_req, reply) => {
    const { registry } = await import('../registry');
    const { getProviderLimitStates } = await import('../limits');

    try {
      const adapters = registry.getReadyAdapters();
      const limits: LimitState[] = [];

      for (const adapter of adapters) {
        const models = await adapter.listModels().catch(() => []);
        for (const model of models) {
          if (model.limitConfig) {
            const states = getProviderLimitStates(adapter.providerId, model.limitConfig, model.id);
            limits.push(...states);
          }
        }
      }

      reply.send({ limits: dedupeLimitStates(limits) });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });
}

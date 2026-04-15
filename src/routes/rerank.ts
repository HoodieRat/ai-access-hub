import type { FastifyInstance } from 'fastify';
import { recordUsage } from '../limits';
import { recordProviderQuotaSnapshots } from '../quota-sync';
import { registry } from '../registry';

export async function rerankRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { query: string; documents: string[]; model?: string; top_n?: number; project_id?: string } }>(
    '/v1/rerank',
    async (req, reply) => {
      const { query, documents, model, top_n, project_id } = req.body;

      // Find rerank-capable adapter
      const adapters = registry.getReadyAdapters();
      const rerankAdapter = adapters.find(a => a.capabilities.rerank);

      if (!rerankAdapter) {
        reply.code(503).send({ error: { message: 'No rerank provider available', type: 'no_provider' } });
        return;
      }

      try {
        const models = await rerankAdapter.listModels();
        const rerankModel = models.find(m => m.capabilities.rerank);
        const result = await rerankAdapter.executeRerank({
          query,
          documents,
          model: model ?? rerankModel?.id,
          topN: top_n,
          projectId: project_id,
        });

        if (result.quotaSnapshots?.length) {
          recordProviderQuotaSnapshots(result.quotaSnapshots);
        }

        recordUsage({
          providerId: rerankAdapter.providerId,
          modelId: model ?? rerankModel?.id,
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          providerUnits: result.usage?.providerUnits,
        });

        reply.send({
          results: result.results,
          _hub: { provider_id: rerankAdapter.providerId },
        });
      } catch (e) {
        reply.code(500).send({ error: { message: String(e), type: 'rerank_error' } });
      }
    },
  );
}

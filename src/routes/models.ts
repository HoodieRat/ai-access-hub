import type { FastifyInstance } from 'fastify';
import { registry } from '../registry';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/models', async (_req, reply) => {
    try {
      const models = await registry.getAllModels();
      reply.send({
        object: 'list',
        data: models.map(m => ({
          id: m.id,
          object: 'model',
          provider_id: m.providerId,
          quality_tier: m.qualityTier,
          context_window: m.contextWindow,
          max_output_tokens: m.maxOutputTokens,
          aliases: m.aliases,
          capabilities: m.capabilities,
          is_free: m.isFree,
        })),
      });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  app.get('/v1/routes', async (_req, reply) => {
    // Return the current default alias→model mapping
    try {
      const aliasMap: Record<string, { provider: string; model: string; tier: string }[]> = {};
      const models = await registry.getAllModels();

      for (const model of models) {
        for (const alias of model.aliases) {
          if (!aliasMap[alias]) aliasMap[alias] = [];
          aliasMap[alias].push({
            provider: model.providerId,
            model: model.id,
            tier: model.qualityTier,
          });
        }
      }

      reply.send({ aliases: aliasMap });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { route } from '../router';
import type { RouteRequest } from '../types';

export async function embeddingRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { input: string | string[]; model?: string; model_alias?: string; project_id?: string } }>(
    '/v1/embeddings',
    async (req, reply) => {
      const { input, model, model_alias, project_id } = req.body;
      const projectId = (req as unknown as { projectId?: string }).projectId ?? project_id ?? null;

      const routeReq: RouteRequest = {
        messages: [{ role: 'user', content: typeof input === 'string' ? input : input.join('\n') }],
        model: model,
        model_alias: model_alias ?? 'embeddings-fast',
        route_policy: 'embeddings',
        project_id: projectId ?? undefined,
      };

      try {
        const result = await route(routeReq);
        reply.send({
          ...result.output as object,
          _hub: {
            provider_id: result.providerId,
            upstream_model: result.upstreamModel,
            quality_tier: result.qualityTier,
            cache_hit: result.cacheHit,
          },
        });
      } catch (e) {
        reply.code(500).send({ error: { message: String(e), type: 'embedding_error' } });
      }
    },
  );
}

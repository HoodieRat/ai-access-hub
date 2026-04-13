import type { FastifyInstance } from 'fastify';
import { HUB_VERSION } from '../version';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    reply.send({ status: 'ok', timestamp: Date.now(), version: HUB_VERSION });
  });
}

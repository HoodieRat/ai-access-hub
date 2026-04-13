import type { FastifyInstance } from 'fastify';
import { getActiveDbWarnings, resolveWarning } from '../warnings';

export async function warningRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/warnings', async (_req, reply) => {
    try {
      const warnings = getActiveDbWarnings();
      reply.send({ warnings });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  app.post<{ Params: { id: string } }>('/v1/warnings/:id/resolve', async (req, reply) => {
    resolveWarning(req.params.id);
    reply.send({ resolved: true });
  });

  app.post<{ Body: { approval_token: string } }>(
    '/v1/admin/approve-downgrade',
    async (req, reply) => {
      const { approval_token } = req.body;
      const { consumeApprovalToken } = await import('../secrets');
      const context = consumeApprovalToken(approval_token);
      if (!context) {
        reply.code(400).send({ error: 'Invalid or expired approval token' });
        return;
      }
      reply.send({ approved: true, context });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { registry } from '../registry';
import { getProviderLimitStates } from '../limits';
import type { ProviderStatus } from '../types';

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/providers', async (_req, reply) => {
    try {
      const statuses = await registry.getProviderStatuses();
      reply.send({
        providers: statuses.map(serializeProviderStatus),
      });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  app.get<{ Params: { providerId: string } }>('/v1/providers/:providerId', async (req, reply) => {
    const { providerId } = req.params;
    const statuses = await registry.getProviderStatuses();
    const status = statuses.find(item => item.id === providerId);
    const adapter = registry.getAdapter(providerId);

    if (!adapter || !status) {
      reply.code(404).send({ error: `Provider '${providerId}' not found` });
      return;
    }

    try {
      const models = status.models;
      const limits = models.flatMap(m =>
        m.limitConfig ? getProviderLimitStates(providerId, m.limitConfig, m.id) : []
      );

      reply.send({
        ...serializeProviderStatus(status),
        capabilities: status.capabilities,
        quality_tier: adapter.qualityTier,
        models,
        limits,
      });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });
}

function serializeProviderStatus(status: ProviderStatus) {
  return {
    id: status.id,
    name: status.name,
    enabled: status.enabled,
    authenticated: status.authenticated,
    healthy: status.healthy,
    status: status.status,
    routable: status.routable,
    blocking_reason: status.blockingReason,
    circuit_open: status.circuitOpen,
    cooldown_until: status.cooldownUntil,
    quarantine_until: status.quarantineUntil,
    recovery_at: status.recoveryAt,
    recovery_in_ms: status.recoveryInMs,
    last_check_at: status.lastCheckAt,
    last_latency_ms: status.lastLatencyMs,
    last_error: status.lastError,
    last_failure_type: status.lastFailureType,
    consecutive_failures: status.consecutiveFailures,
    capabilities: status.capabilities,
    model_count: status.models.length,
  };
}

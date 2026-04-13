/**
 * Admin routes.
 * All protected by admin token middleware (applied in server.ts).
 */

import type { FastifyInstance } from 'fastify';
import { registry } from '../registry';
import { recordFailure, recordSuccess, resetProviderHealth } from '../health';
import { getConfig } from '../config';
import { getSetting, setSetting } from '../db';
import { inferFailureTypeFromError } from '../adapters/base';
import { recordCooldown } from '../limits';
import { HEALTH_CHECK_INTERVAL_MS } from '../health-policy';
import {
  createClientToken,
  listClientTokens,
  revokeClientToken,
  setSecret,
  getSecret,
  listSecretKeys,
  maskSecret,
} from '../secrets';
import { startCopilotDeviceAuth, pollCopilotDeviceAuth } from '../adapters/copilot';
import { classifyRequest } from '../router';
import type { RouteRequest } from '../types';
import { cleanExpiredCache, getCacheStats } from '../cache';
import { cleanExpiredWindows } from '../limits';

// Re-export for server to import
export { startCopilotDeviceAuth, pollCopilotDeviceAuth } from '../adapters/copilot';

// Pending device codes (in-memory; short-lived)
const _pendingDeviceAuths = new Map<string, { deviceCode: string; interval: number; expiresAt: number }>();

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── Provider management ────────────────────────────────────────────────────
  app.post<{ Body: { provider_id: string } }>('/v1/admin/test-provider', async (req, reply) => {
    const { provider_id } = req.body;
    const adapter = registry.getAdapter(provider_id);
    if (!adapter) {
      reply.code(404).send({ error: `Provider '${provider_id}' not found` });
      return;
    }
    const result = await adapter.healthCheck().catch(e => ({
      healthy: false,
      latencyMs: 0,
      error: e instanceof Error ? e.message : String(e),
      failureType: adapter.classifyFailure(e),
    }));
    if (result.healthy) {
      recordSuccess(provider_id, result.latencyMs);
    } else {
      const error = result.error ?? 'health check failed';
      const failureType = result.failureType ?? inferFailureTypeFromError(error);
      recordFailure(provider_id, error, failureType);
      if (failureType === 'rate_limit' || failureType === 'quota_exhausted') {
        recordCooldown(provider_id, HEALTH_CHECK_INTERVAL_MS);
      }
    }
    registry.invalidateStatusCache();
    reply.send({ provider_id, ...result });
  });

  app.post<{ Body: { provider_id: string } }>('/v1/admin/reset-provider', async (req, reply) => {
    const { provider_id } = req.body;
    resetProviderHealth(provider_id);
    await registry.reinitialize(provider_id);
    registry.invalidateStatusCache();
    reply.send({ reset: true, provider_id });
  });

  // ── Route override ─────────────────────────────────────────────────────────
  app.post<{ Body: RouteRequest }>('/v1/admin/force-route', async (req, reply) => {
    // Preview routing decision without executing
    const body = req.body;
    const classified = classifyRequest(body);
    reply.send({
      classified_as: classified,
      request_body: body,
      note: 'Use preferred_provider and model fields in your request to force routing',
    });
  });

  app.post<{ Body: RouteRequest & { dry_run?: boolean } }>('/v1/classify-route', async (req, reply) => {
    const classified = classifyRequest(req.body);
    reply.send({ classified_as: classified });
  });

  // ── Mode toggles ───────────────────────────────────────────────────────────
  app.post<{ Body: { free_only?: boolean; local_only?: boolean; premium_enabled?: boolean } }>(
    '/v1/admin/modes',
    async (req, reply) => {
      const { free_only, local_only, premium_enabled } = req.body;
      if (free_only !== undefined) setSetting('free_only', String(free_only));
      if (local_only !== undefined) setSetting('local_only', String(local_only));
      if (premium_enabled !== undefined) setSetting('premium_enabled', String(premium_enabled));

      reply.send({
        free_only: getSetting('free_only') === 'true',
        local_only: getSetting('local_only') === 'true',
        premium_enabled: getSetting('premium_enabled') === 'true',
      });
    },
  );

  app.get('/v1/admin/modes', async (_req, reply) => {
    const cfg = getConfig();
    reply.send({
      free_only: getSetting('free_only') === 'true' || cfg.freeOnly,
      local_only: getSetting('local_only') === 'true' || cfg.localOnly,
      premium_enabled: getSetting('premium_enabled') === 'true' || cfg.premiumEnabled,
    });
  });

  // ── Client token management ───────────────────────────────────────────────
  app.get('/v1/admin/tokens', async (_req, reply) => {
    reply.send({ tokens: listClientTokens() });
  });

  app.post<{ Body: { label: string; project_id: string; read_only?: boolean } }>(
    '/v1/admin/tokens',
    async (req, reply) => {
      const { label, project_id, read_only } = req.body;
      if (!label || !project_id) {
        reply.code(400).send({ error: 'label and project_id are required' });
        return;
      }
      const token = createClientToken(label, project_id, read_only ?? false);
      reply.send({ token, label, project_id, read_only: read_only ?? false });
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/admin/tokens/:id', async (req, reply) => {
    revokeClientToken(req.params.id);
    reply.send({ revoked: true });
  });

  // ── Secrets management ────────────────────────────────────────────────────
  app.get('/v1/admin/secrets', async (_req, reply) => {
    const keys = listSecretKeys();
    reply.send({ keys: keys.map(k => ({ key: k, masked: '***' })) });
  });

  app.post<{ Body: { key: string; value: string } }>('/v1/admin/secrets', async (req, reply) => {
    const { key, value } = req.body;
    if (!key || !value) {
      reply.code(400).send({ error: 'key and value are required' });
      return;
    }
    setSecret(key, value);
    reply.send({ stored: true, key, masked: maskSecret(value) });
  });

  // ── Copilot device auth ───────────────────────────────────────────────────
  app.post('/v1/admin/copilot-auth/init', async (_req, reply) => {
    try {
      const { startCopilotDeviceAuth: initAuth } = await import('../adapters/copilot');
      const result = await initAuth();
      _pendingDeviceAuths.set(result.deviceCode, {
        deviceCode: result.deviceCode,
        interval: result.interval,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
      reply.send({
        user_code: result.userCode,
        verification_uri: result.verificationUri,
        device_code: result.deviceCode,
        expires_in: result.expiresIn,
        instructions: `Go to ${result.verificationUri} and enter code: ${result.userCode}`,
      });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  app.post<{ Body: { device_code: string } }>('/v1/admin/copilot-auth/complete', async (req, reply) => {
    const { device_code } = req.body;
    const pending = _pendingDeviceAuths.get(device_code);
    if (!pending || pending.expiresAt < Date.now()) {
      reply.code(400).send({ error: 'Device code expired or not found' });
      return;
    }
    try {
      const { pollCopilotDeviceAuth: poll } = await import('../adapters/copilot');
      const token = await poll(device_code, pending.interval);
      if (!token) {
        reply.code(202).send({ status: 'pending', message: 'User has not yet authorized. Try again.' });
        return;
      }
      setSecret('copilot_oauth_token', token);
      _pendingDeviceAuths.delete(device_code);
      await registry.reinitialize('copilot');

      const adapter = registry.getAdapter('copilot');
      if (!adapter) {
        reply.code(500).send({ error: 'Copilot adapter not available after authentication' });
        return;
      }

      const health = await adapter.healthCheck().catch(e => ({
        healthy: false,
        latencyMs: 0,
        error: e instanceof Error ? e.message : String(e),
        failureType: adapter.classifyFailure(e),
      }));

      if (health.healthy) {
        recordSuccess('copilot', health.latencyMs);
        reply.send({ status: 'authorized', message: 'Copilot authenticated successfully', health });
        return;
      }

      const error = health.error ?? 'Copilot authentication completed but provider check failed';
      const failureType = health.failureType ?? inferFailureTypeFromError(error);
      recordFailure('copilot', error, failureType);

      reply.send({
        status: 'authorized_but_unavailable',
        message: error,
        health,
      });
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  // ── Cache management ──────────────────────────────────────────────────────
  app.get('/v1/admin/cache', async (_req, reply) => {
    reply.send(getCacheStats());
  });

  app.delete('/v1/admin/cache', async (_req, reply) => {
    cleanExpiredCache();
    cleanExpiredWindows();
    reply.send({ cleaned: true });
  });

  // ── Usage export ──────────────────────────────────────────────────────────
  app.get('/v1/admin/export-usage', async (req, reply) => {
    const format = (req.query as { format?: string }).format ?? 'json';
    const { getUsageSummary, getRecentLogs } = await import('../db');
    const summary = getUsageSummary();
    const logs = getRecentLogs(500);

    if (format === 'csv') {
      const header = 'provider,total_requests,total_prompt_tokens,total_completion_tokens,cache_hits,errors';
      const rows = summary.map(s =>
        `${s.provider},${s.totalRequests},${s.totalPromptTokens},${s.totalCompletionTokens},${s.cacheHits},${s.errors}`
      );
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="usage.csv"');
      reply.send([header, ...rows].join('\n'));
    } else {
      reply.send({ summary, logs });
    }
  });

  app.get('/v1/admin/doctor', async (_req, reply) => {
    try {
      const { buildDoctorReport } = await import('../doctor');
      reply.send(await buildDoctorReport());
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  // ── Reload registry ───────────────────────────────────────────────────────
  app.post('/v1/admin/reload', async (_req, reply) => {
    await registry.reinitializeAll();
    reply.send({ reloaded: true });
  });

  app.post('/v1/admin/shutdown', async (_req, reply) => {
    const shutdown = (globalThis as unknown as Record<string, unknown>)._hubShutdown as
      | ((signal: string) => Promise<void>)
      | undefined;

    if (!shutdown) {
      reply.code(503).send({ error: 'Shutdown handler not available' });
      return;
    }

    reply.send({ shutting_down: true });
    setImmediate(() => {
      void shutdown('admin_api');
    });
  });
}

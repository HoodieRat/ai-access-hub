/**
 * Fastify server setup.
 *
 * Registers middleware, auth hooks, and all route plugins.
 * Binds to 127.0.0.1 by default to prevent accidental exposure.
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { getConfig } from './config';
import { verifyAdminToken, verifyClientToken } from './secrets';

// Route plugins
import { healthRoutes } from './routes/health';
import { modelRoutes } from './routes/models';
import { providerRoutes } from './routes/providers';
import { chatRoutes } from './routes/chat';
import { embeddingRoutes } from './routes/embeddings';
import { rerankRoutes } from './routes/rerank';
import { usageRoutes } from './routes/usage';
import { warningRoutes } from './routes/warnings';
import { adminRoutes } from './routes/admin';
import { dashboardRoutes } from './routes/dashboard';

const DASHBOARD_ADMIN_COOKIE = 'hub_admin_session';

function parseCookies(rawHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!rawHeader) return cookies;

  for (const part of rawHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function getRequestToken(req: { headers: { authorization?: string; cookie?: string } }): string {
  const authHeader = req.headers.authorization ?? '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const cookies = parseCookies(req.headers.cookie);
  return cookies[DASHBOARD_ADMIN_COOKIE] ?? '';
}

export function createServer() {
  const cfg = getConfig();

  const app = Fastify({
    logger: { level: cfg.logLevel },
    bodyLimit: 4 * 1024 * 1024,
    requestTimeout: 0,
    connectionTimeout: 120_000,
  });

  // ── CORS (off by default; local-only) ──────────────────────────────────────
  app.register(fastifyCors, {
    origin: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ── Request-level error handler ────────────────────────────────────────────
  app.setErrorHandler((err, _req, reply) => {
    const status = err.statusCode ?? 500;
    reply.status(status).send({
      error: {
        type: err.code ?? 'internal_error',
        message: err.message,
        status,
      },
    });
  });

  // ── Auth hooks ─────────────────────────────────────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;

    // Public paths – skip auth
    if (url === '/health' || url.startsWith('/dashboard') || url === '/') {
      return;
    }

    // /v1/admin/* requires admin token
    if (url.startsWith('/v1/admin/') || url === '/v1/classify-route') {
      const token = getRequestToken(req);
      if (!token || !verifyAdminToken(token)) {
        reply.status(401).send({ error: { type: 'auth_error', message: 'Admin token required', status: 401 } });
        return;
      }
      return;
    }

    // All other /v1/* routes accept admin token OR a valid client token
    if (url.startsWith('/v1/')) {
      const token = getRequestToken(req);
      if (!token) {
        reply.status(401).send({ error: { type: 'auth_error', message: 'Authorization header required', status: 401 } });
        return;
      }

      // Admin token is always accepted
      if (verifyAdminToken(token)) {
        return;
      }

      // Try client token
      const clientToken = verifyClientToken(token);
      if (!clientToken) {
        reply.status(401).send({ error: { type: 'auth_error', message: 'Invalid or revoked token', status: 401 } });
        return;
      }

      // Attach project ID to request for downstream use
      (req as unknown as Record<string, unknown>).projectId = clientToken.projectId;
    }
  });

  // ── Route registrations ────────────────────────────────────────────────────
  app.register(healthRoutes);
  app.register(dashboardRoutes);
  app.register(modelRoutes);
  app.register(providerRoutes);
  app.register(chatRoutes);
  app.register(embeddingRoutes);
  app.register(rerankRoutes);
  app.register(usageRoutes);
  app.register(warningRoutes);
  app.register(adminRoutes);

  return app;
}

export async function startServer(): Promise<void> {
  const cfg = getConfig();
  const app = createServer();

  const host = cfg.host;
  const port = cfg.port;

  try {
    const address = await app.listen({ host, port });
    app.log.info(`AI Access Hub running at ${address}`);
    app.log.info(`Dashboard: ${address}/dashboard`);
    app.log.info(`API:       ${address}/v1/`);

    // Expose for graceful shutdown
    (globalThis as unknown as Record<string, unknown>)._hubServer = app;
  } catch (err) {
    app.log.error(err);
    try {
      await app.close();
    } catch {
      // Ignore cleanup failures during startup error handling.
    }
    throw err;
  }
}

export async function stopServer(): Promise<void> {
  const app = (globalThis as unknown as Record<string, unknown>)._hubServer as
    | ReturnType<typeof createServer>
    | undefined;
  if (app) {
    await app.close();
    delete (globalThis as unknown as Record<string, unknown>)._hubServer;
  }
}

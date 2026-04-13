/**
 * Entry point.
 *
 * Boot sequence:
 *   1. Load .env
 *   2. Validate config (fails fast on missing secrets key / admin token)
 *   3. Init SQLite schema
 *   4. Register all provider adapters
 *   5. Start background health-check worker
 *   6. Clean stale cache / expired usage windows
 *   7. Start Fastify server
 *   8. Register SIGTERM / SIGINT for graceful shutdown
 */

import dotenv from 'dotenv';
import { getConfig } from './config';
import { getDb } from './db';
import { registry } from './registry';
import { startHealthCheckWorker, stopHealthCheckWorker } from './health';
import { cleanExpiredCache } from './cache';
import { cleanExpiredWindows } from './limits';
import { startServer, stopServer } from './server';
import { HUB_VERSION } from './version';

dotenv.config({ override: true });

let shuttingDown = false;

async function main(): Promise<void> {
  // 1. Validate config – throws on fatal misconfiguration
  const cfg = getConfig();

  console.log(`[hub] Starting AI Access Hub v${HUB_VERSION}`);
  console.log(`[hub] Mode: ${cfg.localOnly ? 'local-only' : cfg.freeOnly ? 'free-only' : 'standard'}`);

  // 2. Initialize database (creates tables if they don't exist)
  const db = getDb();
  console.log('[hub] Database ready');

  // 3. Register and initialize all adapters
  await registry.initialize();

  const statuses = await registry.getProviderStatuses();
  const ready = statuses.filter(s => s.enabled && s.authenticated).length;
  const total = statuses.filter(s => s.enabled).length;
  console.log(`[hub] Providers: ${ready}/${total} authenticated and ready`);

  // 4. Start background health worker (polls every 5 min; unref'd so it doesn't block exit)
  startHealthCheckWorker();

  // 5. Maintenance: clean stale entries from previous runs
  try {
    cleanExpiredCache();
    cleanExpiredWindows();
  } catch (e) {
    console.warn('[hub] Maintenance cleanup warning:', e);
  }

  // 6. Start HTTP server
  await startServer();
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`\n[hub] Received ${signal}, shutting down gracefully...`);
  try {
    stopHealthCheckWorker();
    await stopServer();
    // Close SQLite (getDb() returns the same instance; better-sqlite3 auto-closes on GC
    // but explicit close is cleaner)
    const db = getDb();
    db.close();
  } catch (e) {
    console.error('[hub] Error during shutdown:', e);
  }
  process.exit(0);
}

(globalThis as unknown as Record<string, unknown>)._hubShutdown = shutdown;

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[hub] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[hub] Unhandled rejection:', reason);
  process.exit(1);
});

main().catch((err) => {
  console.error('[hub] Fatal startup error:', err);
  process.exit(1);
});

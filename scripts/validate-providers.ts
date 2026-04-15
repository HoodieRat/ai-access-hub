import dotenv from 'dotenv';
import { registry } from '../src/registry';
import { closeDb } from '../src/db';
import type { FailureType } from '../src/types';

dotenv.config();

type ProviderValidationResult = {
  providerId: string;
  enabled: boolean;
  authenticated: boolean;
  healthy: boolean;
  latencyMs: number;
  failureType?: FailureType;
  error?: string;
};

async function main(): Promise<void> {
  const requestedProviders = new Set(
    process.argv.slice(2).map(value => value.trim()).filter(Boolean),
  );

  await registry.initialize();
  const adapters = registry.getAllAdapters().filter(adapter => {
    if (requestedProviders.size === 0) return adapter.isEnabled();
    return requestedProviders.has(adapter.providerId);
  });

  if (adapters.length === 0) {
    console.log(JSON.stringify({ error: 'No matching enabled providers found.' }, null, 2));
    return;
  }

  const results: ProviderValidationResult[] = [];

  for (const adapter of adapters) {
    if (!adapter.isEnabled()) {
      results.push({
        providerId: adapter.providerId,
        enabled: false,
        authenticated: adapter.isAuthenticated(),
        healthy: false,
        latencyMs: 0,
        error: 'Provider disabled',
      });
      continue;
    }

    if (!adapter.isAuthenticated()) {
      results.push({
        providerId: adapter.providerId,
        enabled: true,
        authenticated: false,
        healthy: false,
        latencyMs: 0,
        error: 'Missing authentication',
      });
      continue;
    }

    const health = await adapter.healthCheck().catch(error => ({
      healthy: false,
      latencyMs: 0,
      error: error instanceof Error ? error.message : String(error),
      failureType: adapter.classifyFailure(error),
    }));

    results.push({
      providerId: adapter.providerId,
      enabled: true,
      authenticated: true,
      healthy: health.healthy,
      latencyMs: health.latencyMs,
      failureType: health.failureType,
      error: health.error,
    });
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    providers: results,
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });

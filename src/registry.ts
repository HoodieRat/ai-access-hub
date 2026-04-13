/**
 * Provider registry.
 * Holds all adapter instances, maintains enable/disable state,
 * and provides unified query methods for the router.
 */

import type { BaseAdapter } from './adapters/base';
import type { FailureType, ModelInfo, ProviderCapabilities, ProviderState, ProviderStatus } from './types';
import { createAllAdapters } from './adapters';
import { getDb } from './db';
import { getCircuitRecoveryAt } from './health-policy';

interface LoadedHealth {
  healthy: boolean;
  lastCheckAt: number | null;
  latencyMs: number;
  lastError: string | null;
  lastFailureType: FailureType | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  cooldownUntil: number | null;
  quarantineUntil: number | null;
}

interface CacheRecord<T> {
  value: T;
  expiresAt: number;
}

const MODEL_SNAPSHOT_TTL_MS = 15_000;
const STATUS_CACHE_TTL_MS = 5_000;
const ADAPTER_INIT_TIMEOUT_MS = 20_000;

class ProviderRegistry {
  private adapters = new Map<string, BaseAdapter>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private modelsSnapshotCache: CacheRecord<Map<string, ModelInfo[]>> | null = null;
  private modelsSnapshotPromise: Promise<Map<string, ModelInfo[]>> | null = null;
  private providerStatusesCache: CacheRecord<ProviderStatus[]> | null = null;
  private providerStatusesPromise: Promise<ProviderStatus[]> | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    const all = createAllAdapters();
    this.adapters.clear();
    for (const adapter of all) {
      this.adapters.set(adapter.providerId, adapter);
    }

    this.initializePromise = (async () => {
      await Promise.all(all.map(async (adapter) => {
        try {
          await this.initializeAdapter(adapter);
        } catch (e) {
          console.warn(`[registry] Failed to initialize adapter ${adapter.providerId}:`, e);
        }
      }));

      this.initialized = true;
      this.invalidateCaches();
    })().finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
  }

  getAdapter(providerId: string): BaseAdapter | undefined {
    return this.adapters.get(providerId);
  }

  getAllAdapters(): BaseAdapter[] {
    return Array.from(this.adapters.values());
  }

  getEnabledAdapters(): BaseAdapter[] {
    return this.getAllAdapters().filter(a => a.isEnabled());
  }

  getReadyAdapters(): BaseAdapter[] {
    return this.getAllAdapters().filter(a => a.isEnabled() && a.isAuthenticated());
  }

  async getAllModels(): Promise<ModelInfo[]> {
    const modelsByProvider = await this.getModelsSnapshot();
    const results: ModelInfo[] = [];
    for (const models of modelsByProvider.values()) {
      results.push(...models);
    }
    return results;
  }

  async findModelsByAlias(alias: string): Promise<Array<{ model: ModelInfo; adapter: BaseAdapter }>> {
    const modelsByProvider = await this.getModelsSnapshot();
    const results: Array<{ model: ModelInfo; adapter: BaseAdapter }> = [];
    for (const adapter of this.getReadyAdapters()) {
      const models = modelsByProvider.get(adapter.providerId) ?? [];
      for (const model of models) {
        if (model.aliases.includes(alias)) {
          results.push({ model, adapter });
        }
      }
    }
    return results;
  }

  async findModelById(modelId: string): Promise<{ model: ModelInfo; adapter: BaseAdapter } | null> {
    const modelsByProvider = await this.getModelsSnapshot();
    for (const adapter of this.getReadyAdapters()) {
      const models = modelsByProvider.get(adapter.providerId) ?? [];
      const model = models.find(m => m.id === modelId);
      if (model) return { model, adapter };
    }
    return null;
  }

  async getProviderStatuses(): Promise<ProviderStatus[]> {
    const now = Date.now();
    if (this.providerStatusesCache && this.providerStatusesCache.expiresAt > now) {
      return this.providerStatusesCache.value;
    }
    if (this.providerStatusesPromise) {
      return this.providerStatusesPromise;
    }

    this.providerStatusesPromise = (async () => {
      const health = loadAllHealth();
      const modelsByProvider = await this.getModelsSnapshot();
      const statuses: ProviderStatus[] = [];

      for (const adapter of this.getAllAdapters()) {
        try {
          const models = adapter.isEnabled() && adapter.isAuthenticated()
            ? modelsByProvider.get(adapter.providerId) ?? []
            : [];

          const h = health.get(adapter.providerId);
          const activeCooldownUntil = getActiveUntil(h?.cooldownUntil ?? null, now);
          const activeQuarantineUntil = getActiveUntil(h?.quarantineUntil ?? null, now);
          const recoveryAt = h?.circuitOpen
            ? getCircuitRecoveryAt(h.lastCheckAt)
            : activeQuarantineUntil ?? activeCooldownUntil;
          const recoveryInMs = recoveryAt && recoveryAt > now ? recoveryAt - now : null;
          const healthy = h?.healthy ?? (adapter.isEnabled() && adapter.isAuthenticated());
          const { status, routable } = deriveProviderState({
            enabled: adapter.isEnabled(),
            authenticated: adapter.isAuthenticated(),
            healthy,
            circuitOpen: h?.circuitOpen ?? false,
            cooldownUntil: activeCooldownUntil,
            quarantineUntil: activeQuarantineUntil,
            recoveryAt,
          });

          statuses.push({
            id: adapter.providerId,
            name: adapter.providerName,
            enabled: adapter.isEnabled(),
            authenticated: adapter.isAuthenticated(),
            healthy,
            status,
            routable,
            blockingReason: getBlockingReason(status, h?.lastFailureType ?? null),
            circuitOpen: h?.circuitOpen ?? false,
            cooldownUntil: activeCooldownUntil,
            quarantineUntil: activeQuarantineUntil,
            recoveryAt,
            recoveryInMs,
            lastCheckAt: h?.lastCheckAt ?? null,
            lastLatencyMs: h?.latencyMs ?? 0,
            lastError: h?.lastError ?? null,
            lastFailureType: h?.lastFailureType ?? null,
            consecutiveFailures: h?.consecutiveFailures ?? 0,
            capabilities: adapter.capabilities,
            models,
            limits: adapter.getRateState(),
          });
        } catch {
          statuses.push({
            id: adapter.providerId,
            name: adapter.providerName,
            enabled: adapter.isEnabled(),
            authenticated: adapter.isAuthenticated(),
            healthy: false,
            status: adapter.isEnabled() ? 'degraded' : 'disabled',
            routable: false,
            blockingReason: adapter.isEnabled() ? 'status_load_failed' : 'provider_disabled',
            circuitOpen: false,
            cooldownUntil: null,
            quarantineUntil: null,
            recoveryAt: null,
            recoveryInMs: null,
            lastCheckAt: null,
            lastLatencyMs: 0,
            lastError: 'Failed to load status',
            lastFailureType: null,
            consecutiveFailures: 0,
            capabilities: adapter.capabilities,
            models: [],
            limits: [],
          });
        }
      }

      this.providerStatusesCache = {
        value: statuses,
        expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
      };

      return statuses;
    })();

    try {
      return await this.providerStatusesPromise;
    } finally {
      this.providerStatusesPromise = null;
    }
  }

  /** Re-initialize a specific adapter (e.g., after config change) */
  async reinitialize(providerId: string): Promise<void> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return;
    this.invalidateCaches();
    await adapter.initialize();
    this.invalidateCaches();
  }

  /** Re-initialize all adapters */
  async reinitializeAll(): Promise<void> {
    this.initialized = false;
    this.adapters.clear();
    this.invalidateCaches();
    await this.initialize();
  }

  private async getModelsSnapshot(): Promise<Map<string, ModelInfo[]>> {
    await this.initialize();

    const now = Date.now();
    if (this.modelsSnapshotCache && this.modelsSnapshotCache.expiresAt > now) {
      return this.modelsSnapshotCache.value;
    }
    if (this.modelsSnapshotPromise) {
      return this.modelsSnapshotPromise;
    }

    this.modelsSnapshotPromise = (async () => {
      const readyAdapters = this.getReadyAdapters();
      const entries = await Promise.all(readyAdapters.map(async adapter => {
        try {
          const models = await adapter.listModels();
          return [adapter.providerId, models] as const;
        } catch {
          return [adapter.providerId, [] as ModelInfo[]] as const;
        }
      }));

      const snapshot = new Map<string, ModelInfo[]>(entries);
      this.modelsSnapshotCache = {
        value: snapshot,
        expiresAt: Date.now() + MODEL_SNAPSHOT_TTL_MS,
      };

      return snapshot;
    })();

    try {
      return await this.modelsSnapshotPromise;
    } finally {
      this.modelsSnapshotPromise = null;
    }
  }

  private invalidateCaches(): void {
    this.modelsSnapshotCache = null;
    this.modelsSnapshotPromise = null;
    this.providerStatusesCache = null;
    this.providerStatusesPromise = null;
  }

  invalidateStatusCache(): void {
    this.providerStatusesCache = null;
    this.providerStatusesPromise = null;
  }

  private async initializeAdapter(adapter: BaseAdapter): Promise<void> {
    const initPromise = adapter.initialize();
    initPromise.catch(() => {});

    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        initPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Initialization timed out after ${ADAPTER_INIT_TIMEOUT_MS}ms`));
          }, ADAPTER_INIT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

// ─── Health state loader ──────────────────────────────────────────────────────
function loadAllHealth(): Map<string, LoadedHealth> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM provider_health').all() as Array<{
    provider_id: string;
    healthy: number;
    last_check_at: number;
    latency_ms: number;
    last_error: string | null;
    last_failure_type: FailureType | null;
    consecutive_failures: number;
    circuit_open: number;
    cooldown_until: number | null;
    quarantine_until: number | null;
  }>;

  const map = new Map<string, LoadedHealth>();
  for (const row of rows) {
    map.set(row.provider_id, {
      healthy: row.healthy === 1,
      lastCheckAt: row.last_check_at > 0 ? row.last_check_at : null,
      latencyMs: row.latency_ms,
      lastError: row.last_error,
      lastFailureType: row.last_failure_type,
      consecutiveFailures: row.consecutive_failures,
      circuitOpen: row.circuit_open === 1,
      cooldownUntil: row.cooldown_until,
      quarantineUntil: row.quarantine_until,
    });
  }
  return map;
}

function getActiveUntil(until: number | null, now: number): number | null {
  return until && until > now ? until : null;
}

function deriveProviderState(params: {
  enabled: boolean;
  authenticated: boolean;
  healthy: boolean;
  circuitOpen: boolean;
  cooldownUntil: number | null;
  quarantineUntil: number | null;
  recoveryAt: number | null;
}): { status: ProviderState; routable: boolean } {
  const now = Date.now();

  if (!params.enabled) {
    return { status: 'disabled', routable: false };
  }

  if (!params.authenticated) {
    return { status: 'missing_auth', routable: false };
  }

  if (params.quarantineUntil) {
    return { status: 'quarantined', routable: false };
  }

  if (params.cooldownUntil) {
    return { status: 'cooling_down', routable: false };
  }

  if (params.circuitOpen) {
    if (params.recoveryAt && params.recoveryAt > now) {
      return { status: 'circuit_open', routable: false };
    }

    return { status: 'recovering', routable: true };
  }

  if (params.healthy) {
    return { status: 'healthy', routable: true };
  }

  return { status: 'degraded', routable: true };
}

function getBlockingReason(status: ProviderState, failureType: FailureType | null): string | null {
  switch (status) {
    case 'disabled':
      return 'provider_disabled';
    case 'missing_auth':
      return 'missing_authentication';
    case 'quarantined':
      return failureType === 'auth_failure' ? 'auth_failure_quarantine' : 'provider_quarantined';
    case 'cooling_down':
      if (failureType === 'quota_exhausted') return 'quota_exhausted';
      if (failureType === 'rate_limit') return 'rate_limited';
      return 'cooldown_active';
    case 'circuit_open':
      return 'circuit_open';
    default:
      return null;
  }
}

// Singleton
export const registry = new ProviderRegistry();

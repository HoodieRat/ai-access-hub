import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { getConfig } from './config';
import { closeDb, getDb, getUsageSummary } from './db';
import { registry } from './registry';
import { getCacheStats } from './cache';
import { getActiveDbWarnings } from './warnings';
import type { HubModes, ProviderState, ProviderStatus } from './types';
import { getEffectiveModes } from './modes';

export type DoctorCheckLevel = 'ok' | 'warn' | 'error';
export type DoctorOverallStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  id: string;
  level: DoctorCheckLevel;
  message: string;
  details?: string;
}

export interface DoctorProviderSummary {
  id: string;
  name: string;
  status: ProviderState;
  routable: boolean;
  blockingReason: string | null;
  lastFailureType: ProviderStatus['lastFailureType'];
  lastError: string | null;
  lastLatencyMs: number;
  consecutiveFailures: number;
  recoveryAt: number | null;
  recoveryInMs: number | null;
  modelCount: number;
}

export interface DoctorReportSummary {
  totalProviders: number;
  enabledProviders: number;
  authenticatedProviders: number;
  healthyProviders: number;
  routableProviders: number;
  blockedProviders: number;
  activeWarnings: number;
  criticalWarnings: number;
  requests24h: number;
  providersByState: Record<ProviderState, number>;
}

export interface DoctorReport {
  generatedAt: number;
  overallStatus: DoctorOverallStatus;
  summary: DoctorReportSummary;
  environment: {
    host: string;
    port: number;
    dataDir: string;
    logDir: string;
    modes: HubModes;
  };
  database: {
    path: string;
    exists: boolean;
    sizeBytes: number;
  };
  cache: ReturnType<typeof getCacheStats>;
  warnings: {
    active: number;
    critical: number;
    warn: number;
    info: number;
  };
  providers: DoctorProviderSummary[];
  checks: DoctorCheck[];
}

export interface SanitizedDoctorReport {
  generatedAt: number;
  overallStatus: DoctorOverallStatus;
  summary: DoctorReportSummary;
  environment: {
    host: string;
    port: number;
    modes: HubModes;
  };
  database: {
    exists: boolean;
    sizeBytes: number;
  };
  cache: ReturnType<typeof getCacheStats>;
  warnings: DoctorReport['warnings'];
  providers: DoctorProviderSummary[];
  checks: DoctorCheck[];
}

const PROVIDER_STATES: ProviderState[] = [
  'disabled',
  'missing_auth',
  'healthy',
  'degraded',
  'cooling_down',
  'quarantined',
  'circuit_open',
  'recovering',
];

const LEVEL_RANK: Record<DoctorCheckLevel, number> = {
  ok: 0,
  warn: 1,
  error: 2,
};

function buildEmptyStateCounts(): Record<ProviderState, number> {
  return {
    disabled: 0,
    missing_auth: 0,
    healthy: 0,
    degraded: 0,
    cooling_down: 0,
    quarantined: 0,
    circuit_open: 0,
    recovering: 0,
  };
}

function getOverallStatus(checks: DoctorCheck[]): DoctorOverallStatus {
  const worst = checks.reduce((max, check) => Math.max(max, LEVEL_RANK[check.level]), 0);
  if (worst >= LEVEL_RANK.error) return 'error';
  if (worst >= LEVEL_RANK.warn) return 'warn';
  return 'ok';
}

function formatModes(modes: HubModes): string {
  return `free_only=${modes.freeOnly} local_only=${modes.localOnly} premium_enabled=${modes.premiumEnabled}`;
}

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return 'ready now';
  if (ms < 1_000) return `${ms}ms`;

  const totalSeconds = Math.ceil(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

function formatFailure(type: DoctorProviderSummary['lastFailureType']): string {
  return type ? type.replace(/_/g, ' ') : 'none';
}

function formatBlockingReason(reason: string | null): string {
  return reason ? reason.replace(/_/g, ' ') : 'none';
}

function renderCheck(check: DoctorCheck): string {
  const level = check.level.toUpperCase().padEnd(5, ' ');
  return `- ${level} ${check.message}${check.details ? ` (${check.details})` : ''}`;
}

export async function buildDoctorReport(): Promise<DoctorReport> {
  const cfg = getConfig();
  const modes = getEffectiveModes(cfg);
  getDb();
  await registry.initialize();

  const statuses = await registry.getProviderStatuses();
  const warnings = getActiveDbWarnings().filter(w => !w.resolvedAt);
  const cache = getCacheStats();
  const usage24h = getUsageSummary(Date.now() - 86_400_000);
  const requests24h = usage24h.reduce((sum, item) => sum + item.totalRequests, 0);

  const providersByState = buildEmptyStateCounts();
  for (const status of statuses) {
    providersByState[status.status] += 1;
  }

  const summary: DoctorReportSummary = {
    totalProviders: statuses.length,
    enabledProviders: statuses.filter(status => status.enabled).length,
    authenticatedProviders: statuses.filter(status => status.authenticated).length,
    healthyProviders: statuses.filter(status => status.status === 'healthy').length,
    routableProviders: statuses.filter(status => status.routable).length,
    blockedProviders: statuses.filter(status => status.enabled && !status.routable).length,
    activeWarnings: warnings.length,
    criticalWarnings: warnings.filter(warning => warning.level === 'critical').length,
    requests24h,
    providersByState,
  };

  const providerRows: DoctorProviderSummary[] = statuses.map(status => ({
    id: status.id,
    name: status.name,
    status: status.status,
    routable: status.routable,
    blockingReason: status.blockingReason,
    lastFailureType: status.lastFailureType,
    lastError: status.lastError,
    lastLatencyMs: status.lastLatencyMs,
    consecutiveFailures: status.consecutiveFailures,
    recoveryAt: status.recoveryAt,
    recoveryInMs: status.recoveryInMs,
    modelCount: status.models.length,
  }));

  const databasePath = path.join(cfg.dataDir, 'hub.db');
  const databaseExists = fs.existsSync(databasePath);
  const databaseSizeBytes = databaseExists ? fs.statSync(databasePath).size : 0;

  const missingAuth = statuses.filter(status => status.enabled && !status.authenticated).map(status => status.id);
  const blocked = statuses.filter(status => status.enabled && !status.routable).map(status => status.id);
  const degraded = statuses.filter(status => ['degraded', 'recovering'].includes(status.status)).map(status => status.id);
  const cohereChatDisabled = cfg.providers.cohere?.enabled && cfg.providers.cohere?.chatEnabled !== true;

  const checks: DoctorCheck[] = [
    {
      id: 'storage',
      level: 'ok',
      message: 'Data and log directories are available.',
      details: `${cfg.dataDir} | ${cfg.logDir}`,
    },
    summary.enabledProviders === 0
      ? {
          id: 'providers-enabled',
          level: 'error',
          message: 'No providers are enabled.',
          details: 'Enable at least one provider in .env before starting the hub.',
        }
      : summary.routableProviders === 0
        ? {
            id: 'providers-routable',
            level: 'error',
            message: 'No providers are currently routable.',
            details: blocked.length > 0 ? blocked.join(', ') : 'All enabled providers are blocked or missing auth.',
          }
        : blocked.length > 0
          ? {
              id: 'providers-routable',
              level: 'warn',
              message: `${blocked.length} enabled provider(s) are currently blocked from routing.`,
              details: blocked.join(', '),
            }
          : {
              id: 'providers-routable',
              level: 'ok',
              message: 'All enabled providers are currently routable.',
            },
    missingAuth.length > 0
      ? {
          id: 'provider-auth',
          level: 'warn',
          message: `${missingAuth.length} enabled provider(s) are missing authentication.`,
          details: missingAuth.join(', '),
        }
      : {
          id: 'provider-auth',
          level: 'ok',
          message: 'All enabled providers have credentials or interactive auth in place.',
        },
    cohereChatDisabled
      ? {
          id: 'cohere-chat-disabled',
          level: 'warn',
          message: 'Cohere chat routing is intentionally disabled.',
          details: 'COHERE_CHAT_ENABLED=false keeps Cohere out of strong-free and fast-free until the compatibility chat endpoint is verified healthy.',
        }
      : {
          id: 'cohere-chat-disabled',
          level: 'ok',
          message: 'Cohere chat routing is enabled.',
        },
    summary.criticalWarnings > 0
      ? {
          id: 'warnings',
          level: 'error',
          message: `${summary.criticalWarnings} critical warning(s) are active.`,
          details: 'Open the dashboard warnings page or query /v1/warnings for details.',
        }
      : summary.activeWarnings > 0
        ? {
            id: 'warnings',
            level: 'warn',
            message: `${summary.activeWarnings} warning(s) are active.`,
            details: 'Routing will continue, but at least one provider is near or over a limit.',
          }
        : {
            id: 'warnings',
            level: 'ok',
            message: 'No active warning records.',
          },
    degraded.length > 0
      ? {
          id: 'provider-health',
          level: 'warn',
          message: `${degraded.length} provider(s) are degraded or recovering.`,
          details: degraded.join(', '),
        }
      : {
          id: 'provider-health',
          level: 'ok',
          message: 'No providers are currently marked degraded or recovering.',
        },
    {
      id: 'modes',
      level: 'ok',
      message: 'Mode flags loaded from config and persisted overrides.',
      details: formatModes(modes),
    },
  ];

  return {
    generatedAt: Date.now(),
    overallStatus: getOverallStatus(checks),
    summary,
    environment: {
      host: cfg.host,
      port: cfg.port,
      dataDir: cfg.dataDir,
      logDir: cfg.logDir,
      modes,
    },
    database: {
      path: databasePath,
      exists: databaseExists,
      sizeBytes: databaseSizeBytes,
    },
    cache,
    warnings: {
      active: warnings.length,
      critical: warnings.filter(warning => warning.level === 'critical').length,
      warn: warnings.filter(warning => warning.level === 'warn').length,
      info: warnings.filter(warning => warning.level === 'info').length,
    },
    providers: providerRows,
    checks,
  };
}

export function sanitizeDoctorReport(report: DoctorReport): SanitizedDoctorReport {
  return {
    generatedAt: report.generatedAt,
    overallStatus: report.overallStatus,
    summary: report.summary,
    environment: {
      host: report.environment.host,
      port: report.environment.port,
      modes: report.environment.modes,
    },
    database: {
      exists: report.database.exists,
      sizeBytes: report.database.sizeBytes,
    },
    cache: report.cache,
    warnings: report.warnings,
    providers: report.providers,
    checks: report.checks,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    'AI Access Hub Doctor',
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Overall:   ${report.overallStatus.toUpperCase()}`,
    `Server:    http://${report.environment.host}:${report.environment.port}`,
    `Modes:     ${formatModes(report.environment.modes)}`,
    `Providers: ${report.summary.routableProviders}/${report.summary.enabledProviders} routable (${report.summary.totalProviders} total)` ,
    `Warnings:  ${report.summary.activeWarnings} active (${report.summary.criticalWarnings} critical)`,
    `Requests:  ${report.summary.requests24h} in the last 24h`,
    `Cache:     ${report.cache.exactEntries} exact / ${report.cache.semanticEntries} semantic entries`,
    '',
    'Checks',
    ...report.checks.map(renderCheck),
    '',
    'Providers',
  ];

  for (const provider of report.providers) {
    const parts = [
      `${provider.id}: ${provider.status}`,
      provider.routable ? 'routable' : `blocked (${formatBlockingReason(provider.blockingReason)})`,
      `${provider.modelCount} model(s)`,
      provider.lastLatencyMs > 0 ? `${provider.lastLatencyMs}ms` : 'no latency yet',
      provider.consecutiveFailures > 0 ? `${provider.consecutiveFailures} failure(s)` : '0 failures',
      `last failure=${formatFailure(provider.lastFailureType)}`,
    ];

    if (provider.recoveryInMs) {
      parts.push(`recovery=${formatDuration(provider.recoveryInMs)}`);
    }

    if (provider.lastError) {
      parts.push(`error=${provider.lastError}`);
    }

    lines.push(`- ${parts.join(' | ')}`);
  }

  return lines.join('\n');
}

async function runDoctorCli(): Promise<void> {
  dotenv.config({ override: true });

  try {
    const report = await buildDoctorReport();
    const json = process.argv.includes('--json');

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderDoctorReport(report));
    }

    process.exitCode = report.overallStatus === 'error' ? 1 : 0;
  } finally {
    closeDb();
  }
}

if (require.main === module) {
  void runDoctorCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
    closeDb();
  });
}

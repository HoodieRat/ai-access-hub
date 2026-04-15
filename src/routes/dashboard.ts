import type { FastifyInstance } from 'fastify';
import { getCacheStats } from '../cache';
import { getConfig } from '../config';
import { HUB_VERSION } from '../version';
import { getUsageSummary } from '../db';
import { buildFreeUsageSummary, type FreeUsageModelSource } from '../limits';
import { registry } from '../registry';
import type { ModelInfo, ProviderStatus } from '../types';
import { getActiveDbWarnings } from '../warnings';

const DASHBOARD_ADMIN_COOKIE_NAME = 'hub_admin_session';

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function buildDashboardAdminCookie(): string {
  const token = encodeURIComponent(getConfig().adminToken);
  return `${DASHBOARD_ADMIN_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function serializeDashboardProviderStatus(status: ProviderStatus) {
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

function serializeDashboardModel(model: ModelInfo) {
  return {
    id: model.id,
    object: 'model',
    provider_id: model.providerId,
    quality_tier: model.qualityTier,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    aliases: model.aliases,
    capabilities: model.capabilities,
    is_free: model.isFree,
  };
}

function buildDashboardAliasMap(models: ModelInfo[]) {
  const aliasMap: Record<string, { provider: string; model: string; tier: string }[]> = {};

  for (const model of models) {
    for (const alias of model.aliases) {
      if (!aliasMap[alias]) aliasMap[alias] = [];
      aliasMap[alias].push({
        provider: model.providerId,
        model: model.id,
        tier: model.qualityTier,
      });
    }
  }

  return aliasMap;
}

async function buildDashboardFreeUsageSummary() {
  await registry.initialize();

  const sources: FreeUsageModelSource[] = [];

  for (const adapter of registry.getReadyAdapters()) {
    const models = await adapter.listModels().catch(() => []);
    for (const model of models) {
      sources.push({
        providerId: adapter.providerId,
        providerName: adapter.providerName,
        defaultLimitConfig: adapter.defaultLimitConfig,
        model,
      });
    }
  }

  return buildFreeUsageSummary(sources);
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_req, reply) => {
    reply.redirect('/dashboard');
  });

  app.get('/dashboard', async (req, reply) => {
    const hasServerAdminAccess = isLoopbackAddress(req.ip);
    if (hasServerAdminAccess) {
      reply.header('Set-Cookie', buildDashboardAdminCookie());
    }
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.send(getDashboardHtml({ hasServerAdminAccess }));
  });

  app.get('/dashboard/api/overview', async (_req, reply) => {
    const { buildDoctorReport, sanitizeDoctorReport } = await import('../doctor');

    const report = sanitizeDoctorReport(await buildDoctorReport());

    reply.send({
      hub_version: HUB_VERSION,
      uptime_ms: process.uptime() * 1000,
      modes: {
        free_only: report.environment.modes.freeOnly,
        local_only: report.environment.modes.localOnly,
        premium_enabled: report.environment.modes.premiumEnabled,
      },
      providers: {
        total: report.summary.totalProviders,
        ready: report.summary.routableProviders,
        healthy: report.summary.healthyProviders,
        blocked: report.summary.blockedProviders,
        by_state: report.summary.providersByState,
      },
      usage_24h: report.summary.requests24h,
      cache: report.cache,
      active_warnings: report.summary.activeWarnings,
      doctor: {
        overall_status: report.overallStatus,
        issue_count: report.checks.filter(check => check.level !== 'ok').length,
        checks: report.checks.filter(check => check.level !== 'ok').slice(0, 4),
      },
      provider_statuses: report.providers,
    });
  });

  app.get('/dashboard/api/doctor', async (_req, reply) => {
    const { buildDoctorReport, sanitizeDoctorReport } = await import('../doctor');
    reply.send(sanitizeDoctorReport(await buildDoctorReport()));
  });

  app.get('/dashboard/api/providers', async (_req, reply) => {
    await registry.initialize();
    const statuses = await registry.getProviderStatuses();
    reply.send({ providers: statuses.map(serializeDashboardProviderStatus) });
  });

  app.get('/dashboard/api/models', async (_req, reply) => {
    await registry.initialize();
    const models = await registry.getAllModels();
    reply.send({
      object: 'list',
      data: models.map(serializeDashboardModel),
      aliases: buildDashboardAliasMap(models),
    });
  });

  app.get('/dashboard/api/usage', async (req, reply) => {
    const since = (req.query as { since?: string }).since
      ? parseInt((req.query as { since: string }).since, 10)
      : Date.now() - 7 * 86_400_000;

    const summary = getUsageSummary(since);
    const cache = getCacheStats();
    const total = summary.reduce(
      (acc, item) => ({
        requests: acc.requests + item.totalRequests,
        promptTokens: acc.promptTokens + item.totalPromptTokens,
        completionTokens: acc.completionTokens + item.totalCompletionTokens,
        cacheHits: acc.cacheHits + item.cacheHits,
        errors: acc.errors + item.errors,
      }),
      { requests: 0, promptTokens: 0, completionTokens: 0, cacheHits: 0, errors: 0 },
    );

    reply.send({
      since,
      total,
      by_provider: summary,
      cache: {
        exact_entries: cache.exactEntries,
        exact_hits: cache.exactHits,
        semantic_entries: cache.semanticEntries,
        semantic_hits: cache.semanticHits,
        hit_rate: total.requests > 0
          ? Math.round(((cache.exactHits + cache.semanticHits) / total.requests) * 100)
          : 0,
      },
    });
  });

  app.get('/dashboard/api/free-usage', async (_req, reply) => {
    try {
      reply.send(await buildDashboardFreeUsageSummary());
    } catch (e) {
      reply.code(500).send({ error: String(e) });
    }
  });

  app.get('/dashboard/api/warnings', async (_req, reply) => {
    const warnings = getActiveDbWarnings()
      .filter(warning => !warning.resolvedAt)
      .map(warning => ({
        id: warning.id,
        providerId: warning.providerId,
        level: warning.level,
        message: warning.message,
        sameTierAlternatives: warning.sameTierAlternatives,
        lowerTierAlternatives: warning.lowerTierAlternatives,
        createdAt: warning.createdAt,
        resolvedAt: warning.resolvedAt,
      }));

    reply.send({ warnings });
  });
}

function getDashboardHtml(options: { hasServerAdminAccess: boolean }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Access Hub</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --purple: #bc8cff;
    --font: 'Segoe UI', system-ui, -apple-system, sans-serif;
    --mono: 'Consolas', 'SFMono-Regular', ui-monospace, monospace;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font); line-height: 1.5; }
  a { color: var(--accent); text-decoration: none; }
  .app { min-height: 100vh; display: grid; grid-template-columns: 220px 1fr; }
  .nav { background: var(--surface); border-right: 1px solid var(--border); padding: 20px 16px; display: flex; flex-direction: column; gap: 8px; }
  .nav-logo { font-size: 18px; font-weight: 700; padding: 0 8px 10px; }
  .nav-item { padding: 9px 12px; border-radius: 8px; color: var(--text); cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
  .nav-item:hover, .nav-item.active { background: rgba(88,166,255,0.12); color: var(--accent); }
  .content { padding: 24px; overflow: auto; }
  .page { display: none; }
  .page.active { display: block; }
  h1 { font-size: 28px; line-height: 1.15; margin-bottom: 4px; }
  h2 { font-size: 14px; color: var(--muted); font-weight: 500; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 8px; border-top: 1px solid var(--border); text-align: left; vertical-align: top; }
  tr:first-child th { border-top: none; }
  input, select, textarea { width: 100%; background: rgba(13,17,23,0.7); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-family: inherit; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-family: var(--font); font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: var(--accent); color: #000; }
  .btn-secondary { background: var(--border); color: var(--text); }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-success { background: var(--green); color: #000; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .card-title { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
  .grid { display: grid; gap: 16px; }
  .grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat-value { font-size: 30px; font-weight: 700; line-height: 1; }
  .stat-label { font-size: 12px; color: var(--muted); margin-top: 8px; }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; font-size: 11px; line-height: 1; border: 1px solid transparent; }
  .badge-blue { background: rgba(88,166,255,0.14); color: var(--accent); border-color: rgba(88,166,255,0.25); }
  .badge-green { background: rgba(63,185,80,0.14); color: var(--green); border-color: rgba(63,185,80,0.25); }
  .badge-yellow { background: rgba(210,153,34,0.14); color: var(--yellow); border-color: rgba(210,153,34,0.25); }
  .badge-red { background: rgba(248,81,73,0.14); color: var(--red); border-color: rgba(248,81,73,0.25); }
  .badge-purple { background: rgba(188,140,255,0.14); color: var(--purple); border-color: rgba(188,140,255,0.25); }
  .badge-muted { background: rgba(139,148,158,0.14); color: var(--muted); border-color: rgba(139,148,158,0.25); }
  .alert { padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
  .alert-warn { background: rgba(210,153,34,0.12); border: 1px solid rgba(210,153,34,0.3); color: var(--yellow); }
  .alert-error { background: rgba(248,81,73,0.12); border: 1px solid rgba(248,81,73,0.3); color: var(--red); }
  .alert-info { background: rgba(88,166,255,0.12); border: 1px solid rgba(88,166,255,0.3); color: var(--accent); }
  .toggle-label { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 8px 0; }
  .toggle { position: relative; width: 40px; height: 22px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; inset: 0; background: var(--border); border-radius: 11px; transition: 0.2s; }
  .toggle-slider::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
  .toggle input:checked + .toggle-slider { background: var(--accent); }
  .toggle input:checked + .toggle-slider::before { transform: translateX(18px); }
  .spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); }
  .flex { display: flex; align-items: center; }
  .gap-8 { gap: 8px; }
  .mb-16 { margin-bottom: 16px; }
  .mb-8 { margin-bottom: 8px; }
  .w-full { width: 100%; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .dot-green { background: var(--green); }
  .dot-yellow { background: var(--yellow); }
  .dot-red { background: var(--red); }
  .dot-blue { background: var(--accent); }
  .dot-muted { background: var(--muted); }
  .quota-summary-grid { display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 14px; }
  .quota-summary-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(48,54,61,0.8); border-radius: 10px; padding: 14px; }
  .quota-summary-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 6px; }
  .quota-summary-value { font-size: 30px; font-weight: 700; line-height: 1; margin-bottom: 8px; }
  .quota-legend { display: grid; gap: 8px; margin-bottom: 16px; }
  .quota-section { margin-top: 18px; }
  .quota-section:first-of-type { margin-top: 0; }
  .quota-section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .quota-section-heading { font-size: 16px; font-weight: 600; }
  .quota-service-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .quota-service-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(48,54,61,0.8); border-radius: 10px; padding: 16px; }
  .quota-service-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .quota-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .quota-service-metric { font-size: 22px; font-weight: 700; line-height: 1.25; margin-bottom: 6px; }
  .quota-service-subtitle { font-size: 12px; color: var(--muted); }
  .quota-window-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .quota-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: rgba(255,255,255,0.04); font-size: 11px; }
  .quota-progress { width: 100%; height: 10px; border-radius: 999px; overflow: hidden; background: rgba(139,148,158,0.15); margin-top: 10px; }
  .quota-progress-fill { height: 100%; border-radius: 999px; }
  .quota-note-list { display: grid; gap: 6px; margin-top: 10px; }
  .quota-note { padding: 8px 10px; border-radius: 8px; background: rgba(13,17,23,0.55); color: var(--muted); font-size: 12px; }
  .quota-empty { padding: 14px; border-radius: 8px; background: rgba(88,166,255,0.08); border: 1px solid rgba(88,166,255,0.25); color: var(--text); }
  .quota-filter-toolbar { display: grid; gap: 10px; margin-bottom: 14px; }
  .quota-filter-group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .quota-filter-label { font-size: 12px; color: var(--muted); min-width: 88px; }
  .quota-filter-btn { padding: 5px 10px; border-radius: 999px; border: 1px solid rgba(48,54,61,0.9); background: rgba(255,255,255,0.02); color: var(--text); cursor: pointer; font-size: 12px; }
  .quota-filter-btn.active { border-color: rgba(88,166,255,0.5); background: rgba(88,166,255,0.12); color: var(--accent); }
  .quota-row-hidden { display: none; }
  .quota-cell-stack { display: grid; gap: 4px; }
  .quota-provider-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: rgba(255,255,255,0.04); font-size: 11px; }
  .quota-pill-list { display: flex; flex-wrap: wrap; gap: 6px; }
  @media (max-width: 1100px) {
    .grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 900px) {
    .app { grid-template-columns: 1fr; }
    .nav { border-right: none; border-bottom: 1px solid var(--border); flex-direction: row; flex-wrap: wrap; }
    .nav-logo { width: 100%; }
    .grid-4, .grid-3, .grid-2, .quota-summary-grid, .quota-service-grid { grid-template-columns: 1fr; }
    .quota-service-head, .quota-section-header { flex-direction: column; }
    .quota-badges { justify-content: flex-start; }
  }
</style>
</head>
<body>
<div class="app">
  <nav class="nav">
    <div class="nav-logo">AI Access Hub</div>
    <a class="nav-item active" data-page="overview">Overview</a>
    <a class="nav-item" data-page="providers">Providers</a>
    <a class="nav-item" data-page="models">Models</a>
    <a class="nav-item" data-page="usage">Usage</a>
    <a class="nav-item" data-page="warnings">Warnings</a>
    <a class="nav-item" data-page="controls">Controls</a>
    <a class="nav-item" data-page="doctor">Doctor</a>
    <a class="nav-item" data-page="logs">Logs</a>
    <a class="nav-item" data-page="tokens">Client Tokens</a>
    <a class="nav-item" data-page="copilot-auth">Copilot Auth</a>
  </nav>
  <main class="content">
    <div id="banner"></div>

    <div class="page active" id="page-overview">
      <h1>Overview</h1>
      <h2>Hub health, routing coverage, and visible free-service headroom</h2>
      <div id="overview-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-providers">
      <h1>Providers</h1>
      <h2>State, recovery, and manual actions per provider</h2>
      <div id="providers-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-models">
      <h1>Models</h1>
      <h2>Normalized aliases and upstream model mapping</h2>
      <div id="models-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-usage">
      <h1>Usage</h1>
      <h2>Request counts, token estimates, cache stats, and free-usage windows</h2>
      <div id="usage-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-warnings">
      <h1>Warnings</h1>
      <h2>Active quota warnings and downgrade approval requests</h2>
      <div id="warnings-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-controls">
      <h1>Controls</h1>
      <h2>Mode toggles and manual provider management</h2>
      <div id="controls-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-doctor">
      <h1>Doctor</h1>
      <h2>Runtime diagnostics and provider recovery signals</h2>
      <div id="doctor-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-logs">
      <h1>Logs</h1>
      <h2>Recent request log (last 100)</h2>
      <div id="logs-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-tokens">
      <h1>Client Tokens</h1>
      <h2>Per-project API tokens for local apps</h2>
      <div id="tokens-content"><div class="spinner"></div></div>
    </div>

    <div class="page" id="page-copilot-auth">
      <h1>Copilot Auth</h1>
      <h2>GitHub Copilot device flow authentication</h2>
      <div id="copilot-content">
        <div class="card">
          <div class="card-title">GitHub Copilot OAuth</div>
          <p class="muted mb-16">Sign in with your GitHub account to use Copilot as a premium coding provider.</p>
          <button class="btn btn-primary" onclick="initCopilotAuth()">Start Device Auth Flow</button>
          <div id="copilot-auth-result" style="margin-top:16px"></div>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
const ADMIN_TOKEN = localStorage.getItem('hub_admin_token') || '';
const HAS_SERVER_ADMIN_ACCESS = ${options.hasServerAdminAccess ? 'true' : 'false'};
const PROVIDER_STATE_ORDER = ['healthy', 'degraded', 'recovering', 'cooling_down', 'circuit_open', 'quarantined', 'missing_auth', 'disabled'];
const FETCH_TIMEOUT_MS = 15000;
const READ_ONLY_AUTO_REFRESH_PAGES = new Set(['overview', 'providers', 'models', 'usage', 'warnings', 'doctor']);
const ADMIN_ONLY_PAGES = new Set(['controls', 'logs', 'tokens', 'copilot-auth']);
const PAGE_CONTENT_IDS = {
  overview: 'overview-content',
  providers: 'providers-content',
  models: 'models-content',
  usage: 'usage-content',
  warnings: 'warnings-content',
  controls: 'controls-content',
  doctor: 'doctor-content',
  logs: 'logs-content',
  tokens: 'tokens-content',
  'copilot-auth': 'copilot-content',
};

function hasAdminAccess() {
  return HAS_SERVER_ADMIN_ACCESS || Boolean(ADMIN_TOKEN);
}

async function api(path, opts = {}) {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...fetchOpts } = opts;
  const headers = { ...(fetchOpts.headers || {}) };
  if (fetchOpts.body !== undefined && fetchOpts.body !== null) {
    if (headers['Content-Type'] === undefined && headers['content-type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }
  }
  if (ADMIN_TOKEN) headers['Authorization'] = 'Bearer ' + ADMIN_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(path, { ...fetchOpts, headers, signal: controller.signal });
    if (!res.ok) {
      const raw = await res.text();
      let message = raw || ('HTTP ' + res.status);
      try {
        const parsed = JSON.parse(raw);
        message = parsed?.error?.message ?? parsed?.error ?? message;
      } catch {
        // Leave message as raw text.
      }
      const err = new Error(message);
      err.status = res.status;
      err.raw = raw;
      throw err;
    }
    return res.json();
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error('Request timed out after ' + Math.round(timeoutMs / 1000) + 's');
      err.status = 408;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function clearBanner() {
  const banner = document.getElementById('banner');
  if (banner) banner.innerHTML = '';
}

function showBanner(level, title, details = '') {
  const banner = document.getElementById('banner');
  if (!banner) return;
  const levelClass = level === 'error' ? 'alert-error' : level === 'warn' ? 'alert-warn' : 'alert-info';
  banner.innerHTML = '<div class="alert ' + levelClass + '">' + '<strong>' + title + '</strong>' + (details ? '<div style="margin-top:6px">' + details + '</div>' : '') + '</div>';
}

function getPageContentEl(name) {
  const id = PAGE_CONTENT_IDS[name];
  return id ? document.getElementById(id) : null;
}

function renderPageMessage(name, level, title, message, details = '') {
  const el = getPageContentEl(name);
  if (!el) return;
  const levelClass = level === 'error' ? 'alert-error' : level === 'warn' ? 'alert-warn' : 'alert-info';
  el.innerHTML = '<div class="card">'
    + '<div class="alert ' + levelClass + '">'
    + '<div><strong>' + title + '</strong></div>'
    + '<div style="margin-top:6px">' + message + '</div>'
    + (details ? '<div class="muted" style="margin-top:6px">' + details + '</div>' : '')
    + '</div>'
    + '</div>';
}

function renderLockedPage(name, message = 'This dashboard session does not currently have admin access.') {
  renderPageMessage(
    name,
    'warn',
    'Admin token required',
    message,
    "Open the dashboard locally so the hub can auto-authorize it, or run localStorage.setItem('hub_admin_token', 'YOUR_TOKEN') as a manual fallback and refresh."
  );
}

function isAdminPage(name) {
  return ADMIN_ONLY_PAGES.has(name);
}

function formatLoadError(error) {
  if (!error) return 'Unknown error';
  if (error.message) return error.message;
  return String(error);
}

document.querySelectorAll('[data-page]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const page = el.getAttribute('data-page');
    document.querySelectorAll('.nav-item').forEach(navItem => navItem.classList.remove('active'));
    document.querySelectorAll('.page').forEach(pageEl => pageEl.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('page-' + page).classList.add('active');
    loadPage(page);
  });
});

async function loadPage(name, opts = {}) {
  if (!opts.background) clearBanner();

  if (isAdminPage(name) && !hasAdminAccess()) {
    renderLockedPage(name);
    return;
  }

  try {
    switch (name) {
      case 'overview': await loadOverview(); break;
      case 'providers': await loadProviders(); break;
      case 'models': await loadModels(); break;
      case 'usage': await loadUsage(); break;
      case 'warnings': await loadWarnings(); break;
      case 'controls': await loadControls(); break;
      case 'doctor': await loadDoctor(); break;
      case 'logs': await loadLogs(); break;
      case 'tokens': await loadTokens(); break;
      case 'copilot-auth': await loadCopilotAuthPage(); break;
      default: break;
    }
  } catch (e) {
    console.error(e);
    if (!opts.background) {
      if (e?.status === 401 && isAdminPage(name)) {
        renderLockedPage(name, 'This page needs a valid admin token to read or modify protected data.');
      } else {
        renderPageMessage(name, 'error', humanizeText(name) + ' failed to load', formatLoadError(e));
      }
      showBanner('error', 'Failed to load ' + humanizeText(name) + '.', formatLoadError(e));
    }
  }
}

function quotaTone(window) {
  if (!window) return { badgeClass: 'badge-muted', color: 'var(--muted)' };
  if (window.exhausted || window.warnAt95) return { badgeClass: 'badge-red', color: 'var(--red)' };
  if (window.warnAt85 || window.warnAt70) return { badgeClass: 'badge-yellow', color: 'var(--yellow)' };
  return { badgeClass: 'badge-green', color: 'var(--green)' };
}

const quotaMatrixFilterState = { metric: 'all', window: 'all', evidence: 'all' };

function quotaWindowLabel(window) {
  if (!window) return 'unknown';
  return String(window.metricLabel || 'quota') + '/' + String(window.windowLabel || 'window');
}

function quotaSectionBadgeClass(key) {
  if (key === 'official') return 'badge-blue';
  if (key === 'estimated') return 'badge-yellow';
  return 'badge-muted';
}

function quotaEvidenceBadgeClass(evidence) {
  if (evidence === 'official') return 'badge-blue';
  if (evidence === 'observed' || evidence === 'inferred') return 'badge-yellow';
  return 'badge-muted';
}

function quotaEvidenceLabel(evidence, sectionKey) {
  if (sectionKey === 'estimated' && evidence !== 'unknown') {
    return evidence === 'observed' ? 'observed' : evidence === 'inferred' ? 'inferred' : 'estimated';
  }
  return evidence === 'unknown' ? 'unknown' : String(evidence);
}

function quotaCoverageBadgeClass(coverage) {
  if (coverage === 'provider_synced') return 'badge-green';
  if (coverage === 'hub_only') return 'badge-blue';
  if (coverage === 'partial') return 'badge-yellow';
  return 'badge-muted';
}

function quotaCoverageLabel(coverage) {
  if (coverage === 'provider_synced') return 'provider synced';
  if (coverage === 'hub_only') return 'hub only';
  if (coverage === 'partial') return 'partial';
  return 'unknown';
}

function quotaServiceClassLabel(serviceClass) {
  switch (serviceClass) {
    case 'strong_chat': return 'strong chat';
    case 'fast_chat': return 'fast chat';
    case 'vision_chat': return 'vision chat';
    case 'embeddings': return 'embeddings';
    case 'rerank': return 'rerank';
    default: return 'specialty';
  }
}

function quotaRemainingVerb(window) {
  if (!window) return 'unknown';
  if (window.remainingKind === 'exact') return 'remaining';
  if (window.remainingKind === 'hub_headroom') return 'headroom';
  if (window.remainingKind === 'estimate') return 'estimate';
  return 'unknown';
}

function formatQuotaHeadline(window) {
  if (!window) return 'No tracked quota window';
  return fmtNum(window.remaining)
    + ' / '
    + fmtNum(window.limit)
    + ' '
    + quotaWindowLabel(window)
    + ' '
    + quotaRemainingVerb(window);
}

function formatQuotaReset(resetAt) {
  if (!resetAt) return 'not availableÂ';
  const remainingMs = Math.max(0, resetAt - Date.now());
  return '<strong>' + fmtDuration(remainingMs) + '</strong> <span class="muted">(' + formatTimestamp(resetAt) + ')</span>';
}

function formatQuotaFreshness(window) {
  if (!window || window.freshnessMs == null) return 'No hub traffic recorded yet';
  return 'Updated ' + fmtDuration(window.freshnessMs) + ' ago';
}

function quotaFillWidth(pct) {
  if (!pct || pct <= 0) return '0%';
  return Math.max(6, Math.min(100, pct)) + '%';
}

function renderQuotaSummaryCards(summary) {
  if (!summary.summaryCards || !summary.summaryCards.length) return '';
  return '<div class="quota-summary-grid">' + summary.summaryCards.map(card => (
    '<div class="quota-summary-card">'
      + '<div class="quota-summary-label">' + card.label + '</div>'
      + '<div class="quota-summary-value">' + fmtNum(card.value) + '</div>'
      + '<div class="muted">' + card.description + '</div>'
    + '</div>'
  )).join('') + '</div>';
}

function renderQuotaLegend(summary) {
  return '<div class="quota-legend">'
    + '<div class="alert alert-info">'
      + '<strong>Visibility rule:</strong> every free service stays visible. Local models are excluded here, but official, estimated, and unknown services all remain on screen.'
    + '</div>'
    + '<div class="alert alert-warn">'
      + '<strong>Accuracy rule:</strong> unless a coverage badge says provider synced, remaining values are hub-local headroom against the displayed ceiling, not full provider-account truth.'
      + '<div style="margin-top:6px" class="muted">Tracked services: ' + fmtNum(summary.trackedServiceCount || 0) + ' of ' + fmtNum(summary.serviceCount || 0) + ' visible free services.</div>'
    + '</div>'
  + '</div>';
}

function renderQuotaWindowPills(windows, primaryWindow) {
  const primaryKey = primaryWindow ? String(primaryWindow.metricKind) + ':' + String(primaryWindow.windowType) : '';
  const extras = (windows || []).filter(window => String(window.metricKind) + ':' + String(window.windowType) !== primaryKey);
  if (!extras.length) return '<span class="muted">No other tracked windows.</span>';

  return '<div class="quota-window-pills">' + extras.map(window => {
    const tone = quotaTone(window);
    return '<span class="quota-pill">'
      + '<span class="badge ' + tone.badgeClass + '">' + quotaWindowLabel(window) + '</span>'
      + '<span>' + fmtNum(window.remaining) + ' / ' + fmtNum(window.limit) + '</span>'
    + '</span>';
  }).join('') + '</div>';
}

function renderQuotaNotes(notes) {
  if (!notes || !notes.length) return '';
  return '<div class="quota-note-list">' + notes.map(note => '<div class="quota-note">' + note + '</div>').join('') + '</div>';
}

function renderFreeUsageServiceCard(service, sectionKey) {
  const tone = quotaTone(service.primaryWindow);
  const badges = [
    '<span class="badge badge-muted">' + quotaServiceClassLabel(service.serviceClass) + '</span>',
    '<span class="badge ' + quotaEvidenceBadgeClass(service.evidence) + '">' + quotaEvidenceLabel(service.evidence, sectionKey) + '</span>',
    '<span class="badge ' + quotaCoverageBadgeClass(service.usageCoverage) + '">' + quotaCoverageLabel(service.usageCoverage) + '</span>',
  ];

  (service.capabilityBadges || []).forEach(tag => {
    badges.push('<span class="badge badge-muted">' + tag + '</span>');
  });

  if (service.poolScope && service.poolScope !== 'unknown' && service.poolScope !== 'model') {
    const poolLabel = service.poolKey ? service.poolScope + ': ' + service.poolKey : service.poolScope;
    badges.push('<span class="badge badge-purple">' + poolLabel + '</span>');
  }

  let body = '<div class="quota-empty">No quota window is configured for this service yet.</div>';
  if (service.primaryWindow) {
    body = '<div class="quota-service-metric">' + formatQuotaHeadline(service.primaryWindow) + '</div>'
      + '<div class="quota-service-subtitle">Reset: ' + formatQuotaReset(service.primaryWindow.resetAt) + ' - ' + formatQuotaFreshness(service.primaryWindow) + '</div>'
      + '<div class="quota-progress"><div class="quota-progress-fill" style="width:' + quotaFillWidth(service.primaryWindow.remainingPct) + ';background:' + tone.color + '"></div></div>'
      + renderQuotaWindowPills(service.windows, service.primaryWindow);
  }

  return '<div class="quota-service-card">'
    + '<div class="quota-service-head">'
      + '<div>'
        + '<div class="mono">' + service.providerId + '/' + service.modelId + '</div>'
        + '<div class="muted" style="margin-top:4px">' + service.modelName + '</div>'
      + '</div>'
      + '<div class="quota-badges">' + badges.join(' ') + '</div>'
    + '</div>'
    + body
    + renderQuotaNotes(service.notes)
  + '</div>';
}

function renderFreeUsageSection(section) {
  const badgeClass = quotaSectionBadgeClass(section.key);
  const header = '<div class="quota-section-header">'
    + '<div>'
      + '<div class="quota-section-heading">' + section.label + '</div>'
      + '<div class="muted">' + section.description + '</div>'
    + '</div>'
    + '<span class="badge ' + badgeClass + '">' + fmtNum(section.serviceCount) + ' visible</span>'
  + '</div>';

  if (!section.serviceCount) {
    return '<div class="quota-section">' + header + '<div class="quota-empty">Nothing in this section right now.</div></div>';
  }

  return '<div class="quota-section">'
    + header
    + '<div class="quota-service-grid">'
      + section.services.map(service => renderFreeUsageServiceCard(service, section.key)).join('')
    + '</div>'
  + '</div>';
}

function renderFreeUsageHero(summary) {
  if (!summary.serviceCount) {
    return '<div class="card mb-16">'
      + '<div class="card-title">Free Usage Left</div>'
      + '<div class="muted mb-16">No free services are currently visible. Local models remain excluded from this board.</div>'
    + '</div>';
  }

  return '<div class="card mb-16">'
    + '<div class="card-title">Free Usage Left</div>'
    + '<div class="muted mb-16">All visible free services. Every window names both its unit and reset scope.</div>'
    + renderQuotaSummaryCards(summary)
    + renderQuotaLegend(summary)
    + (summary.sections || []).map(renderFreeUsageSection).join('')
  + '</div>';
}

function renderQuotaFilterButton(group, value, label) {
  const active = quotaMatrixFilterState[group] === value;
  return '<button type="button" class="quota-filter-btn' + (active ? ' active' : '') + '" data-quota-filter-group="' + group + '" data-quota-filter-value="' + value + '" onclick="setQuotaMatrixFilter(&quot;' + group + '&quot;,&quot;' + value + '&quot;)">' + label + '</button>';
}

function renderQuotaFilterToolbar() {
  return '<div class="quota-filter-toolbar">'
    + '<div class="quota-filter-group"><div class="quota-filter-label">Metric</div>'
      + renderQuotaFilterButton('metric', 'all', 'All')
      + renderQuotaFilterButton('metric', 'requests', 'Requests')
      + renderQuotaFilterButton('metric', 'tokens', 'Tokens')
      + renderQuotaFilterButton('metric', 'provider_units', 'Provider Units')
      + renderQuotaFilterButton('metric', 'unknown', 'Unknown')
    + '</div>'
    + '<div class="quota-filter-group"><div class="quota-filter-label">Window</div>'
      + renderQuotaFilterButton('window', 'all', 'All')
      + renderQuotaFilterButton('window', 'minute', 'Minute')
      + renderQuotaFilterButton('window', 'day', 'Day')
      + renderQuotaFilterButton('window', 'month', 'Month')
      + renderQuotaFilterButton('window', 'unknown', 'Unknown')
    + '</div>'
    + '<div class="quota-filter-group"><div class="quota-filter-label">Confidence</div>'
      + renderQuotaFilterButton('evidence', 'all', 'All')
      + renderQuotaFilterButton('evidence', 'official', 'Official')
      + renderQuotaFilterButton('evidence', 'estimated', 'Estimated')
      + renderQuotaFilterButton('evidence', 'unknown', 'Unknown')
    + '</div>'
  + '</div>';
}

function renderQuotaMatrixRow(service, sectionKey, window) {
  const tone = quotaTone(window);
  const notes = (service.notes || []).join(' ');
  const poolLabel = service.poolScope && service.poolScope !== 'unknown'
    ? (service.poolKey ? service.poolScope + ': ' + service.poolKey : service.poolScope)
    : 'model';

  return '<tr data-quota-row="true" data-metric="' + String(window.metricKind) + '" data-window="' + String(window.windowScope) + '" data-evidence="' + sectionKey + '">'
    + '<td><div class="quota-cell-stack"><div class="mono">' + service.providerId + '/' + service.modelId + '</div><div class="muted">' + service.modelName + '</div></div></td>'
    + '<td><span class="badge badge-muted">' + quotaServiceClassLabel(service.serviceClass) + '</span></td>'
    + '<td><span class="badge ' + quotaEvidenceBadgeClass(service.evidence) + '">' + quotaEvidenceLabel(service.evidence, sectionKey) + '</span></td>'
    + '<td><span class="badge ' + quotaCoverageBadgeClass(window.usageCoverage) + '">' + quotaCoverageLabel(window.usageCoverage) + '</span></td>'
    + '<td><span class="badge ' + tone.badgeClass + '">' + quotaWindowLabel(window) + '</span></td>'
    + '<td>' + fmtNum(window.used) + '</td>'
    + '<td>' + fmtNum(window.limit) + '</td>'
    + '<td><div class="quota-cell-stack"><div>' + fmtNum(window.remaining) + '</div><div class="muted">' + quotaRemainingVerb(window) + '</div></div></td>'
    + '<td><div class="quota-cell-stack"><div>' + formatQuotaReset(window.resetAt) + '</div><div class="muted">' + formatQuotaFreshness(window) + '</div></div></td>'
    + '<td>' + poolLabel + '</td>'
    + '<td class="muted">' + (notes || 'not availableÂ') + '</td>'
  + '</tr>';
}

function renderQuotaUnknownRow(service, sectionKey) {
  const notes = (service.notes || []).join(' ');
  return '<tr data-quota-row="true" data-metric="unknown" data-window="unknown" data-evidence="' + sectionKey + '">'
    + '<td><div class="quota-cell-stack"><div class="mono">' + service.providerId + '/' + service.modelId + '</div><div class="muted">' + service.modelName + '</div></div></td>'
    + '<td><span class="badge badge-muted">' + quotaServiceClassLabel(service.serviceClass) + '</span></td>'
    + '<td><span class="badge ' + quotaEvidenceBadgeClass(service.evidence) + '">' + quotaEvidenceLabel(service.evidence, sectionKey) + '</span></td>'
    + '<td><span class="badge badge-muted">unknown</span></td>'
    + '<td><span class="badge badge-muted">unknown</span></td>'
    + '<td>not availableÂ</td>'
    + '<td>not availableÂ</td>'
    + '<td>not availableÂ</td>'
    + '<td>not availableÂ</td>'
    + '<td>' + (service.poolScope && service.poolScope !== 'unknown' ? service.poolScope : 'unknown') + '</td>'
    + '<td class="muted">' + (notes || 'No quota window configured yet.') + '</td>'
  + '</tr>';
}

function renderFreeUsageDetails(summary) {
  const rows = [];
  (summary.sections || []).forEach(section => {
    (section.services || []).forEach(service => {
      if (!service.windows || !service.windows.length) {
        rows.push(renderQuotaUnknownRow(service, section.key));
        return;
      }
      service.windows.forEach(window => rows.push(renderQuotaMatrixRow(service, section.key, window)));
    });
  });

  return '<div class="card mb-16">'
    + '<div class="card-title">Free Usage Matrix</div>'
    + '<div class="muted mb-16">Every free service stays visible. Filter by metric, window, and confidence without collapsing the board into a single bottleneck.</div>'
    + renderQuotaLegend(summary)
    + renderQuotaFilterToolbar()
    + '<table id="quota-matrix-table">'
      + '<tr><th>Service</th><th>Class</th><th>Evidence</th><th>Coverage</th><th>Metric / Window</th><th>Used</th><th>Limit</th><th>Remaining</th><th>Reset</th><th>Pool</th><th>Notes</th></tr>'
      + rows.join('')
    + '</table>'
  + '</div>';
}

function setQuotaMatrixFilter(group, value) {
  quotaMatrixFilterState[group] = value;
  syncQuotaFilterButtons();
  applyQuotaMatrixFilters();
}

function syncQuotaFilterButtons() {
  document.querySelectorAll('[data-quota-filter-group]').forEach(btn => {
    const group = btn.getAttribute('data-quota-filter-group');
    const value = btn.getAttribute('data-quota-filter-value');
    btn.classList.toggle('active', quotaMatrixFilterState[group] === value);
  });
}

function applyQuotaMatrixFilters() {
  document.querySelectorAll('[data-quota-row]').forEach(row => {
    const metric = row.getAttribute('data-metric') || 'unknown';
    const windowScope = row.getAttribute('data-window') || 'unknown';
    const evidence = row.getAttribute('data-evidence') || 'unknown';
    const visible = (quotaMatrixFilterState.metric === 'all' || quotaMatrixFilterState.metric === metric)
      && (quotaMatrixFilterState.window === 'all' || quotaMatrixFilterState.window === windowScope)
      && (quotaMatrixFilterState.evidence === 'all' || quotaMatrixFilterState.evidence === evidence);
    row.classList.toggle('quota-row-hidden', !visible);
  });
}

function quotaProviderRank(sectionKey, service) {
  const sectionWeight = sectionKey === 'official' ? 0 : sectionKey === 'estimated' ? 1 : 2;
  if (!service || !service.primaryWindow) return sectionWeight * 1000 + 999;
  return sectionWeight * 1000 + service.primaryWindow.remainingPct;
}

function buildQuotaProviderIndex(summary) {
  const index = {};
  (summary.sections || []).forEach(section => {
    (section.services || []).forEach(service => {
      const existing = index[service.providerId];
      if (!existing) {
        index[service.providerId] = { sectionKey: section.key, service, count: 1 };
        return;
      }
      existing.count += 1;
      if (quotaProviderRank(section.key, service) < quotaProviderRank(existing.sectionKey, existing.service)) {
        existing.sectionKey = section.key;
        existing.service = service;
      }
    });
  });
  return index;
}

function renderWarningAlternative(providerId, providerIndex) {
  const info = providerIndex[providerId];
  if (!info) {
    return '<span class="quota-provider-pill"><span class="badge badge-muted">' + providerId + '</span><span class="muted">quota unknown</span></span>';
  }

  const service = info.service;
  let detail = 'no quota window';
  if (service.primaryWindow) {
    detail = fmtNum(service.primaryWindow.remaining) + ' ' + quotaWindowLabel(service.primaryWindow) + ' ' + quotaRemainingVerb(service.primaryWindow);
  }

  return '<span class="quota-provider-pill">'
    + '<span class="badge ' + quotaSectionBadgeClass(info.sectionKey) + '">' + providerId + '</span>'
    + '<span>' + detail + '</span>'
  + '</span>';
}

async function loadOverview() {
  const [data, freeUsage] = await Promise.all([
    api('/dashboard/api/overview'),
    api('/dashboard/api/free-usage'),
  ]);
  const el = document.getElementById('overview-content');
  const uptimeSec = Math.round(data.uptime_ms / 1000);
  const uptimeStr = uptimeSec > 3600 ? Math.round(uptimeSec / 3600) + 'h' : uptimeSec + 's';
  const issueChecks = data.doctor.checks || [];
  const providerRows = (data.provider_statuses || []).map(normalizeProvider);
  const stateBadges = PROVIDER_STATE_ORDER.filter(state => (data.providers.by_state?.[state] || 0) > 0).map(state => \`<span class="badge \${stateMeta(state).badgeClass}">\${humanizeText(state)}: \${data.providers.by_state[state]}</span>\`).join(' ');
  const doctorColor = severityColor(data.doctor.overall_status);

  el.innerHTML = \`
    <div class="grid grid-4 mb-16">
      <div class="card"><div class="card-title">Uptime</div><div class="stat-value">\${uptimeStr}</div></div>
      <div class="card"><div class="card-title">Routable Providers</div><div class="stat-value">\${data.providers.ready} / \${data.providers.total}</div></div>
      <div class="card"><div class="card-title">Requests (24h)</div><div class="stat-value">\${data.usage_24h}</div></div>
      <div class="card"><div class="card-title">Doctor</div><div class="stat-value" style="color:\${doctorColor}">\${String(data.doctor.overall_status).toUpperCase()}</div><div class="stat-label">\${data.doctor.issue_count} active issue(s)</div></div>
    </div>
    \${renderFreeUsageHero(freeUsage)}
    <div class="grid grid-3 mb-16">
      <div class="card">
        <div class="card-title">Modes</div>
        \${modesBadges(data.modes)}
      </div>
      <div class="card">
        <div class="card-title">Provider States</div>
        <div class="flex gap-8" style="flex-wrap:wrap;margin-top:4px">\${stateBadges || '<span class="muted">No provider state data yet.</span>'}</div>
      </div>
      <div class="card">
        <div class="card-title">Cache</div>
        <div>Exact entries: <strong>\${data.cache.exactEntries}</strong></div>
        <div>Semantic entries: <strong>\${data.cache.semanticEntries}</strong></div>
        <div>Total hits: <strong>\${data.cache.exactHits + data.cache.semanticHits}</strong></div>
      </div>
    </div>
    <div class="card mb-16">
      <div class="card-title">Doctor Checks</div>
      \${issueChecks.length ? \`
        <table>
          <tr><th>Level</th><th>Check</th><th>Details</th></tr>
          \${issueChecks.map(check => \`
            <tr>
              <td>\${renderLevelBadge(check.level)}</td>
              <td>\${check.message}</td>
              <td class="muted">\${check.details ?? 'not availableÂ'}</td>
            </tr>
          \`).join('')}
        </table>
      \` : '<div class="alert alert-info">No active doctor issues.</div>'}
    </div>
    <div class="card">
      <div class="card-title">Provider State</div>
      <table>
        <tr><th>Provider</th><th>Status</th><th>Routable</th><th>Failure</th><th>Recovery</th><th>Latency</th></tr>
        \${providerRows.map(provider => \`
          <tr>
            <td class="mono">\${provider.id}</td>
            <td>\${renderProviderState(provider)}</td>
            <td>\${provider.routable ? '<span class="badge badge-green">yes</span>' : '<span class="badge badge-red">no</span>'}</td>
            <td>\${provider.lastFailureType ? \`<span class="badge badge-muted">\${humanizeText(provider.lastFailureType)}</span>\` : 'not availableÂ'}</td>
            <td>\${formatRecovery(provider)}</td>
            <td>\${provider.lastLatencyMs > 0 ? provider.lastLatencyMs + 'ms' : 'not availableÂ'}</td>
          </tr>
        \`).join('')}
      </table>
    </div>
  \`;

  if (!hasAdminAccess()) {
    el.insertAdjacentHTML('afterbegin', \`
      <div class="alert alert-warn mb-16">
        Local admin access is not active for this dashboard session. Reopen the dashboard locally, or use <code>localStorage.setItem('hub_admin_token', 'YOUR_TOKEN')</code> as a manual fallback.
      </div>
    \`);
  }
}

function modesBadges(modes) {
  const parts = [];
  parts.push(\`<span class="badge \${modes.free_only ? 'badge-blue' : 'badge-muted'}">free-only: \${modes.free_only}</span>\`);
  parts.push(\`<span class="badge \${modes.local_only ? 'badge-purple' : 'badge-muted'}">local-only: \${modes.local_only}</span>\`);
  parts.push(\`<span class="badge \${modes.premium_enabled ? 'badge-yellow' : 'badge-muted'}">premium: \${modes.premium_enabled}</span>\`);
  return \`<div class="flex gap-8" style="flex-wrap:wrap;margin-top:4px">\${parts.join('')}</div>\`;
}

async function loadProviders() {
  const data = await api('/dashboard/api/providers');
  const el = document.getElementById('providers-content');
  const providers = data.providers.map(normalizeProvider);
  const canManageProviders = hasAdminAccess();

  el.innerHTML = \`
    <div class="card">
      <table>
        <tr><th>Provider</th><th>Status</th><th>Routable</th><th>Models</th><th>Latency</th><th>Failures</th><th>Recovery</th><th>Last Error</th><th>Actions</th></tr>
        \${providers.map(provider => \`
          <tr>
            <td class="mono">\${provider.id}</td>
            <td>\${renderProviderState(provider)}</td>
            <td>\${provider.routable ? '<span class="badge badge-green">yes</span>' : '<span class="badge badge-red">no</span>'}</td>
            <td>\${provider.modelCount}</td>
            <td>\${provider.lastLatencyMs > 0 ? provider.lastLatencyMs + 'ms' : 'not availableÂ'}</td>
            <td>\${provider.consecutiveFailures}\${provider.lastFailureType ? \`<div class="muted" style="font-size:11px;margin-top:4px">\${humanizeText(provider.lastFailureType)}</div>\` : ''}</td>
            <td>\${formatRecovery(provider)}</td>
            <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${provider.lastError ?? 'not availableÂ'}</td>
            <td>
              \${canManageProviders
                ? \`<button class="btn btn-secondary btn-sm" onclick="testProvider('\${provider.id}')">Test</button><button class="btn btn-secondary btn-sm" onclick="resetProvider('\${provider.id}')" style="margin-left:4px">Reset</button>\`
                : '<span class="muted">Read-only</span>'}
            </td>
          </tr>
        \`).join('')}
      </table>
    </div>
    \${canManageProviders ? '' : '<div class="card"><div class="alert alert-info">Provider actions stay read-only until the dashboard has admin access.</div></div>'}
  \`;
}

async function testProvider(id) {
  try {
    const res = await api('/v1/admin/test-provider', { method: 'POST', body: JSON.stringify({ provider_id: id }) });
    alert(\`\${id}: \${res.healthy ? 'Healthy' : 'Unhealthy'} (\${res.latencyMs}ms)\${res.error ? '\\nError: ' + res.error : ''}\`);
  } catch (e) {
    alert('Error: ' + e);
  }
}

async function resetProvider(id) {
  try {
    await api('/v1/admin/reset-provider', { method: 'POST', body: JSON.stringify({ provider_id: id }) });
    alert(id + ' reset successfully');
    await Promise.all([
      loadProviders(),
      loadOverview(),
    ]);
    loadProviders();
  } catch (e) {
    alert('Error: ' + e);
  }
}

async function loadModels() {
  const data = await api('/dashboard/api/models');
  const el = document.getElementById('models-content');

  const aliasRows = Object.entries(data.aliases || {}).map(([alias, targets]) => \`
    <tr>
      <td><span class="badge badge-blue">\${alias}</span></td>
      <td>\${targets.map(target => \`<span class="mono" style="font-size:11px">\${target.provider}/\${target.model}</span>\`).join('<br>')}</td>
      <td>\${targets.map(target => \`<span class="badge badge-muted">\${target.tier}</span>\`).join(' ')}</td>
    </tr>
  \`).join('');

  el.innerHTML = \`
    <div class="card mb-16">
      <div class="card-title">Model Aliases</div>
      <table>
        <tr><th>Alias</th><th>Upstream Models</th><th>Quality Tier</th></tr>
        \${aliasRows}
      </table>
    </div>
    <div class="card">
      <div class="card-title">All Available Models (\${data.data.length})</div>
      <table>
        <tr><th>Model ID</th><th>Provider</th><th>Tier</th><th>Context</th><th>Caps</th></tr>
        \${data.data.map(model => \`
          <tr>
            <td class="mono" style="font-size:12px">\${model.id}</td>
            <td>\${model.provider_id}</td>
            <td><span class="badge badge-muted">\${model.quality_tier}</span></td>
            <td>\${model.context_window ? (model.context_window / 1024).toFixed(0) + 'K' : 'not availableÂ'}</td>
            <td style="font-size:11px">\${capsBadges(model.capabilities)}</td>
          </tr>
        \`).join('')}
      </table>
    </div>
  \`;
}

function capsBadges(caps) {
  const parts = [];
  if (caps.streaming) parts.push('stream');
  if (caps.tools) parts.push('tools');
  if (caps.vision) parts.push('vision');
  if (caps.embeddings) parts.push('embed');
  if (caps.rerank) parts.push('rerank');
  if (caps.longContext) parts.push('long-ctx');
  return parts.map(part => \`<span class="badge badge-muted" style="margin:1px">\${part}</span>\`).join('');
}

async function loadUsage() {
  const [data, freeUsage] = await Promise.all([
    api('/dashboard/api/usage'),
    api('/dashboard/api/free-usage'),
  ]);
  const el = document.getElementById('usage-content');

  el.innerHTML = \`
    <div class="grid grid-4 mb-16">
      <div class="card"><div class="card-title">Total Requests</div><div class="stat-value">\${data.total.requests}</div></div>
      <div class="card"><div class="card-title">Prompt Tokens</div><div class="stat-value">\${fmtNum(data.total.promptTokens)}</div></div>
      <div class="card"><div class="card-title">Completion Tokens</div><div class="stat-value">\${fmtNum(data.total.completionTokens)}</div></div>
      <div class="card"><div class="card-title">Cache Hit Rate</div><div class="stat-value">\${data.cache.hit_rate}%</div></div>
    </div>
    \${renderFreeUsageDetails(freeUsage)}
    <div class="grid grid-2 mb-16">
      <div class="card">
        <div class="card-title">By Provider</div>
        <table>
          <tr><th>Provider</th><th>Requests</th><th>Tokens</th><th>Errors</th></tr>
          \${data.by_provider.map(provider => \`
            <tr>
              <td class="mono">\${provider.provider}</td>
              <td>\${provider.totalRequests}</td>
              <td>\${fmtNum(provider.totalPromptTokens + provider.totalCompletionTokens)}</td>
              <td>\${provider.errors > 0 ? \`<span style="color:var(--red)">\${provider.errors}</span>\` : '0'}</td>
            </tr>
          \`).join('')}
        </table>
      </div>
      <div class="card">
        <div class="card-title">Cache</div>
        <div class="mb-8">Exact cache entries: <strong>\${data.cache.exact_entries}</strong></div>
        <div class="mb-8">Exact cache hits: <strong>\${data.cache.exact_hits}</strong></div>
        <div class="mb-8">Semantic cache entries: <strong>\${data.cache.semantic_entries}</strong></div>
        <div class="mb-8">Semantic cache hits: <strong>\${data.cache.semantic_hits}</strong></div>
      </div>
    </div>
  \`;

  syncQuotaFilterButtons();
  applyQuotaMatrixFilters();
}

async function loadWarnings() {
  const [data, freeUsage] = await Promise.all([
    hasAdminAccess()
      ? api('/v1/warnings')
      : api('/dashboard/api/warnings'),
    api('/dashboard/api/free-usage'),
  ]);
  const el = document.getElementById('warnings-content');
  const active = data.warnings.filter(warning => !warning.resolvedAt);
  const canManageWarnings = hasAdminAccess();
  const providerIndex = buildQuotaProviderIndex(freeUsage);

  if (active.length === 0) {
    el.innerHTML = '<div class="alert alert-info">No active warnings.</div>';
    return;
  }

  el.innerHTML = active.map(warning => \`
    <div class="card mb-16">
      <div class="flex gap-8 mb-8">
        <span class="badge \${warning.level === 'critical' ? 'badge-red' : warning.level === 'warn' ? 'badge-yellow' : 'badge-blue'}">\${warning.level}</span>
        <span class="mono">\${warning.providerId}</span>
      </div>
      <div class="mb-8">\${warning.message}</div>
      \${warning.sameTierAlternatives.length ? \`<div class="mb-8"><strong>Same-tier alternatives:</strong><div class="quota-pill-list" style="margin-top:6px">\${warning.sameTierAlternatives.map(item => renderWarningAlternative(item, providerIndex)).join('')}</div></div>\` : ''}
      \${warning.lowerTierAlternatives.length ? \`<div class="mb-8"><strong>Lower-tier alternatives:</strong><div class="quota-pill-list" style="margin-top:6px">\${warning.lowerTierAlternatives.map(item => renderWarningAlternative(item, providerIndex)).join('')}</div></div>\` : ''}
      \${canManageWarnings && warning.approvalToken ? \`<div class="alert alert-warn mb-8">Downgrade requires approval. Token: <code class="mono">\${warning.approvalToken}</code></div><button class="btn btn-danger btn-sm" onclick="approveDowngrade('\${warning.approvalToken}','\${warning.id}')">Approve Downgrade</button>\` : ''}
      \${canManageWarnings
        ? \`<button class="btn btn-secondary btn-sm" onclick="resolveWarning('\${warning.id}')" style="margin-left:\${warning.approvalToken ? '8px' : '0'}">Dismiss</button>\`
        : '<div class="muted">Read-only warning view. Enable dashboard admin access to dismiss or approve actions.</div>'}
    </div>
  \`).join('');
}

async function resolveWarning(id) {
  await api('/v1/warnings/' + id + '/resolve', { method: 'POST', body: '{}' });
  loadWarnings();
}

async function approveDowngrade(token, warnId) {
  try {
    const res = await api('/v1/admin/approve-downgrade', { method: 'POST', body: JSON.stringify({ approval_token: token }) });
    alert('Approved: ' + res.context);
    resolveWarning(warnId);
  } catch (e) {
    alert('Error: ' + e);
  }
}

async function loadControls() {
  const modes = await api('/v1/admin/modes');
  const el = document.getElementById('controls-content');

  el.innerHTML = \`
    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Mode Flags</div>
        <label class="toggle-label">
          <span class="toggle"><input type="checkbox" id="toggle-free-only" \${modes.free_only ? 'checked' : ''} onchange="setMode('free_only', this.checked)"><span class="toggle-slider"></span></span>
          Free-only mode (block paid or membership providers)
        </label>
        <label class="toggle-label">
          <span class="toggle"><input type="checkbox" id="toggle-local-only" \${modes.local_only ? 'checked' : ''} onchange="setMode('local_only', this.checked)"><span class="toggle-slider"></span></span>
          Local-only mode (only route to local endpoints)
        </label>
        <label class="toggle-label">
          <span class="toggle"><input type="checkbox" id="toggle-premium" \${modes.premium_enabled ? 'checked' : ''} onchange="setMode('premium_enabled', this.checked)"><span class="toggle-slider"></span></span>
          Premium-enabled (allow Copilot or Codex lanes)
        </label>
      </div>
      <div class="card">
        <div class="card-title">Provider Test</div>
        <div class="form-group">
          <label>Provider ID</label>
          <select id="test-provider-select">
            <option value="local">local</option>
            <option value="gemini">gemini</option>
            <option value="groq">groq</option>
            <option value="openrouter">openrouter</option>
            <option value="mistral">mistral</option>
            <option value="cerebras">cerebras</option>
            <option value="cloudflare">cloudflare</option>
            <option value="github-models">github-models</option>
            <option value="sambanova">sambanova</option>
            <option value="cohere">cohere</option>
            <option value="fireworks">fireworks</option>
            <option value="copilot">copilot</option>
            <option value="codex">codex</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="testProvider(document.getElementById('test-provider-select').value)">Test Provider</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Request Classifier and Route Preview</div>
      <div class="form-group">
        <label>Sample prompt</label>
        <textarea id="classify-input" rows="3" placeholder="Type a request to see how it gets classified..."></textarea>
      </div>
      <div class="grid grid-2">
        <div class="form-group">
          <label>Route alias (optional)</label>
          <select id="preview-route-alias">
            <option value="">Auto</option>
            <option value="fast-free">fast-free</option>
            <option value="strong-free">strong-free</option>
            <option value="strong-code">strong-code</option>
            <option value="strong-long-context">strong-long-context</option>
            <option value="local-fast">local-fast</option>
            <option value="local-strong">local-strong</option>
            <option value="premium-code">premium-code</option>
            <option value="premium-review">premium-review</option>
            <option value="frontier-manual">frontier-manual</option>
            <option value="embeddings-fast">embeddings-fast</option>
            <option value="embeddings-strong">embeddings-strong</option>
            <option value="rerank-strong">rerank-strong</option>
          </select>
        </div>
        <div class="form-group">
          <label>Preferred provider (optional)</label>
          <input id="preview-preferred-provider" placeholder="github-models">
        </div>
      </div>
      <div class="grid grid-2">
        <div class="form-group">
          <label>Exact model (optional)</label>
          <input id="preview-model" placeholder="gpt-4o-mini">
        </div>
        <div class="form-group">
          <label>Stability</label>
          <select id="preview-stability-level">
            <option value="normal">normal</option>
            <option value="strict">strict</option>
          </select>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="form-group">
          <label class="toggle-label">
            <span class="toggle"><input type="checkbox" id="preview-forbid-paid"><span class="toggle-slider"></span></span>
            Exclude paid providers for this preview
          </label>
          <label class="toggle-label">
            <span class="toggle"><input type="checkbox" id="preview-prefer-local"><span class="toggle-slider"></span></span>
            Prefer local routes for this preview
          </label>
        </div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-secondary" onclick="classifyRequest()">Classify</button>
        <button class="btn btn-primary" onclick="previewRouteDecision()">Preview Route</button>
      </div>
      <div id="classify-result" style="margin-top:8px"></div>
      <div id="route-preview-result" style="margin-top:12px"></div>
    </div>
  \`;
}

async function setMode(key, value) {
  try {
    await api('/v1/admin/modes', { method: 'POST', body: JSON.stringify({ [key]: value }) });
  } catch (e) {
    alert('Error: ' + e);
  }
}

async function classifyRequest() {
  const text = document.getElementById('classify-input').value;
  if (!text) return;
  try {
    const res = await api('/v1/classify-route', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    });
    document.getElementById('classify-result').innerHTML = '<span class="badge badge-blue">' + escapeHtml(res.classified_as) + '</span>';
  } catch (e) {
    alert('Error: ' + e);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderModeFlagBadges(modes) {
  const flags = [
    { label: 'free_only', enabled: Boolean(modes?.freeOnly) },
    { label: 'local_only', enabled: Boolean(modes?.localOnly) },
    { label: 'premium_enabled', enabled: Boolean(modes?.premiumEnabled) },
  ];

  return flags.map(flag => '<span class="badge ' + (flag.enabled ? 'badge-blue' : 'badge-muted') + '">' + flag.label + ': ' + (flag.enabled ? 'on' : 'off') + '</span>').join(' ');
}

function renderRoutePreview(preview) {
  const candidates = preview?.candidates ?? [];
  const skipped = preview?.skipped ?? [];
  const skipCounts = Object.entries(preview?.skipCounts ?? {}).sort((left, right) => right[1] - left[1]);
  const priorityOrder = preview?.priorityOrder ?? [];
  const stabilityLevel = preview?.stabilityLevel ?? 'normal';
  const visibleSkipped = skipped.slice(0, 12);
  const hiddenSkippedCount = Math.max(0, skipped.length - visibleSkipped.length);

  const candidateRows = candidates.map((candidate, index) => {
    const aliasList = (candidate.aliases ?? []).length
      ? '<div class="muted mono" style="font-size:11px;margin-top:4px">' + (candidate.aliases ?? []).map(alias => escapeHtml(alias)).join(', ') + '</div>'
      : '';
    const matchBadgeClass = candidate.aliasMatch === 'exact'
      ? 'badge-blue'
      : candidate.aliasMatch === 'broadened'
        ? 'badge-yellow'
        : 'badge-muted';
    const matchReason = candidate.aliasMatchReason
      ? '<div class="muted" style="font-size:11px;margin-top:4px">' + escapeHtml(candidate.aliasMatchReason) + '</div>'
      : '';

    return '<tr>'
      + '<td>' + (index + 1) + '</td>'
      + '<td class="mono">' + escapeHtml(candidate.providerId) + '</td>'
      + '<td><div class="mono">' + escapeHtml(candidate.modelId) + '</div>' + aliasList + '</td>'
      + '<td>' + escapeHtml(candidate.qualityTier) + '</td>'
      + '<td><span class="badge ' + matchBadgeClass + '">' + escapeHtml(candidate.aliasMatch) + '</span>' + matchReason + '</td>'
      + '<td class="mono">' + Number(candidate.score ?? 0).toFixed(3) + '</td>'
      + '<td>' + (candidate.isFree ? '<span class="badge badge-green">free</span>' : '<span class="badge badge-purple">paid</span>') + '</td>'
      + '</tr>';
  }).join('');

  const skipSummary = skipCounts.length
    ? '<div class="quota-pill-list" style="margin-top:8px">'
      + skipCounts.map(([reason, count]) => '<span class="badge badge-muted">' + escapeHtml(humanizeText(reason)) + ': ' + count + '</span>').join('')
      + '</div>'
    : '<div class="muted" style="margin-top:8px">No providers or models were skipped.</div>';

  const priorityPills = priorityOrder.length
    ? '<div class="quota-pill-list" style="margin-top:8px">'
      + priorityOrder.map(providerId => '<span class="badge badge-blue">' + escapeHtml(providerId) + '</span>').join('')
      + '</div>'
    : '<div class="muted" style="margin-top:8px">Default scorer ordering.</div>';

  const skippedTable = visibleSkipped.length
    ? '<div style="overflow-x:auto">'
      + '<table>'
      + '<tr><th>Provider</th><th>Model</th><th>Reason</th><th>Detail</th></tr>'
      + visibleSkipped.map(entry => '<tr>'
        + '<td class="mono">' + escapeHtml(entry.providerId) + '</td>'
        + '<td class="mono">' + escapeHtml(entry.modelId ?? 'not available') + '</td>'
        + '<td>' + escapeHtml(humanizeText(entry.reason)) + '</td>'
        + '<td>' + escapeHtml(entry.detail ?? (entry.score !== undefined ? ('score=' + Number(entry.score).toFixed(3)) : '')) + '</td>'
        + '</tr>').join('')
      + '</table>'
      + '</div>'
    : '<div class="muted">No detailed skips recorded.</div>';

  return '<div class="card">'
    + '<div class="card-title">Route Preview</div>'
    + '<div class="mb-16">'
    + '<div><strong>Classified as:</strong> <span class="badge badge-blue">' + escapeHtml(preview?.classifiedAs ?? 'unknown') + '</span>'
    + (preview?.alias ? ' <span class="badge badge-purple">alias ' + escapeHtml(preview.alias) + '</span>' : '')
    + '</div>'
    + '<div style="margin-top:8px"><strong>Stability:</strong> <span class="badge badge-muted">' + escapeHtml(stabilityLevel) + '</span></div>'
    + '<div style="margin-top:8px"><strong>Effective modes:</strong> ' + renderModeFlagBadges(preview?.effectiveModes) + '</div>'
    + '</div>'
    + '<div class="grid grid-2">'
    + '<div>'
    + '<div class="card-title">Candidate Order (' + candidates.length + ')</div>'
    + (candidateRows
      ? '<div style="overflow-x:auto"><table><tr><th>#</th><th>Provider</th><th>Model</th><th>Tier</th><th>Match</th><th>Score</th><th>Billing</th></tr>' + candidateRows + '</table></div>'
      : '<div class="alert alert-warn">No candidates survived this route preview.</div>')
    + '</div>'
    + '<div>'
    + '<div class="card-title">Priority and Skips</div>'
    + '<div><strong>Priority order</strong>' + priorityPills + '</div>'
    + '<div style="margin-top:12px"><strong>Skip summary</strong>' + skipSummary + '</div>'
    + '</div>'
    + '</div>'
    + '<div style="margin-top:16px">'
    + '<div class="card-title">Skipped Details</div>'
    + skippedTable
    + (hiddenSkippedCount > 0 ? '<div class="muted" style="margin-top:8px">Showing first ' + visibleSkipped.length + ' of ' + skipped.length + ' skipped entries.</div>' : '')
    + '</div>'
    + '</div>';
}

async function previewRouteDecision() {
  const promptEl = document.getElementById('classify-input');
  const resultEl = document.getElementById('route-preview-result');
  const text = (promptEl?.value ?? '').trim();

  if (!resultEl) return;
  if (!text) {
    resultEl.innerHTML = '<div class="alert alert-warn">Enter a sample prompt first.</div>';
    return;
  }

  const alias = (document.getElementById('preview-route-alias')?.value ?? '').trim();
  const preferredProvider = (document.getElementById('preview-preferred-provider')?.value ?? '').trim();
  const model = (document.getElementById('preview-model')?.value ?? '').trim();
  const stabilityLevel = (document.getElementById('preview-stability-level')?.value ?? 'normal').trim();
  const forbidPaid = Boolean(document.getElementById('preview-forbid-paid')?.checked);
  const preferLocal = Boolean(document.getElementById('preview-prefer-local')?.checked);
  const payload = {
    messages: [{ role: 'user', content: text }],
  };

  if (alias) payload.model_alias = alias;
  if (preferredProvider) payload.preferred_provider = preferredProvider;
  if (model) payload.model = model;
  payload.stability_level = stabilityLevel || 'normal';
  if (forbidPaid) payload.forbid_paid = true;
  if (preferLocal) payload.prefer_local = true;

  resultEl.innerHTML = '<div class="spinner"></div>';

  try {
    const res = await api('/v1/admin/force-route', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    resultEl.innerHTML = renderRoutePreview(res.preview);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    resultEl.innerHTML = '<div class="alert alert-error">Error: ' + escapeHtml(message) + '</div>';
  }
}

async function loadDoctor() {
  const data = await api('/dashboard/api/doctor');
  const el = document.getElementById('doctor-content');
  const providers = data.providers.map(normalizeProvider);

  el.innerHTML = \`
    <div class="grid grid-4 mb-16">
      <div class="card">
        <div class="card-title">Overall</div>
        <div class="stat-value" style="color:\${severityColor(data.overallStatus)}">\${String(data.overallStatus).toUpperCase()}</div>
      </div>
      <div class="card">
        <div class="card-title">Routable</div>
        <div class="stat-value">\${data.summary.routableProviders}</div>
        <div class="stat-label">of \${data.summary.enabledProviders} enabled providers</div>
      </div>
      <div class="card">
        <div class="card-title">Blocked</div>
        <div class="stat-value" style="color:\${data.summary.blockedProviders > 0 ? 'var(--yellow)' : 'var(--green)'}">\${data.summary.blockedProviders}</div>
      </div>
      <div class="card">
        <div class="card-title">Warnings</div>
        <div class="stat-value" style="color:\${data.summary.activeWarnings > 0 ? 'var(--yellow)' : 'var(--green)'}">\${data.summary.activeWarnings}</div>
        <div class="stat-label">\${data.summary.criticalWarnings} critical</div>
      </div>
    </div>
    <div class="grid grid-3 mb-16">
      <div class="card">
        <div class="card-title">Server</div>
        <div class="mono" style="font-size:12px;color:var(--accent)">http://\${data.environment.host}:\${data.environment.port}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">Run <span class="mono">npm run doctor</span> for the CLI view.</div>
      </div>
      <div class="card">
        <div class="card-title">Modes</div>
        \${modesBadges({ free_only: data.environment.modes.freeOnly, local_only: data.environment.modes.localOnly, premium_enabled: data.environment.modes.premiumEnabled })}
      </div>
      <div class="card">
        <div class="card-title">Storage</div>
        <div>Database present: <strong>\${data.database.exists ? 'yes' : 'no'}</strong></div>
        <div>Database size: <strong>\${fmtBytes(data.database.sizeBytes)}</strong></div>
        <div>Cache entries: <strong>\${data.cache.exactEntries + data.cache.semanticEntries}</strong></div>
      </div>
    </div>
    <div class="card mb-16">
      <div class="card-title">Checks</div>
      <table>
        <tr><th>Level</th><th>Check</th><th>Details</th></tr>
        \${data.checks.map(check => \`
          <tr>
            <td>\${renderLevelBadge(check.level)}</td>
            <td>\${check.message}</td>
            <td class="muted">\${check.details ?? 'not availableÂ'}</td>
          </tr>
        \`).join('')}
      </table>
    </div>
    <div class="card">
      <div class="card-title">Provider Details</div>
      <table>
        <tr><th>Provider</th><th>Status</th><th>Routable</th><th>Failure</th><th>Recovery</th><th>Models</th><th>Latency</th><th>Last Error</th></tr>
        \${providers.map(provider => \`
          <tr>
            <td class="mono">\${provider.id}</td>
            <td>\${renderProviderState(provider)}</td>
            <td>\${provider.routable ? '<span class="badge badge-green">yes</span>' : '<span class="badge badge-red">no</span>'}</td>
            <td>\${provider.lastFailureType ? \`<span class="badge badge-muted">\${humanizeText(provider.lastFailureType)}</span>\` : 'not availableÂ'}</td>
            <td>\${formatRecovery(provider)}</td>
            <td>\${provider.modelCount}</td>
            <td>\${provider.lastLatencyMs > 0 ? provider.lastLatencyMs + 'ms' : 'not availableÂ'}</td>
            <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${provider.lastError ?? 'not availableÂ'}</td>
          </tr>
        \`).join('')}
      </table>
    </div>
  \`;
}

async function loadLogs() {
  const { logs } = await api('/v1/admin/export-usage');
  const el = document.getElementById('logs-content');

  if (!logs || !logs.length) {
    el.innerHTML = '<div class="muted">No logs yet.</div>';
    return;
  }

  el.innerHTML = \`
    <div class="card">
      <table>
        <tr><th>Time</th><th>Provider/Model</th><th>Class</th><th>Tokens</th><th>Cache</th><th>Status</th><th>Latency</th></tr>
        \${logs.slice(0, 100).map(log => \`
          <tr>
            <td class="mono muted" style="white-space:nowrap">\${new Date(log.timestamp).toLocaleTimeString()}</td>
            <td class="mono" style="font-size:11px">\${log.selected_provider}/<br>\${log.selected_model}</td>
            <td><span class="badge badge-muted">\${log.classified_as}</span></td>
            <td>\${log.prompt_tokens + log.completion_tokens}</td>
            <td>\${log.cache_hit ? '<span class="badge badge-green">hit</span>' : '<span class="badge badge-muted">miss</span>'}</td>
            <td>\${log.success ? '<span class="badge badge-green">ok</span>' : '<span class="badge badge-red">fail</span>'}</td>
            <td>\${log.latency_ms}ms</td>
          </tr>
        \`).join('')}
      </table>
    </div>
  \`;
}

async function loadTokens() {
  const data = await api('/v1/admin/tokens');
  const el = document.getElementById('tokens-content');

  el.innerHTML = \`
    <div class="card mb-16">
      <div class="card-title">Create Token</div>
      <div class="grid grid-3">
        <div class="form-group"><label>Label</label><input type="text" id="new-label" placeholder="my-app"></div>
        <div class="form-group"><label>Project ID</label><input type="text" id="new-project" placeholder="project-id"></div>
        <div class="form-group"><label>&nbsp;</label><button class="btn btn-primary w-full" onclick="createToken()">Create Token</button></div>
      </div>
      <div id="new-token-result"></div>
    </div>
    <div class="card">
      <div class="card-title">Existing Tokens</div>
      <table>
        <tr><th>Label</th><th>Project</th><th>Read-only</th><th>Created</th><th>Last Used</th><th>Action</th></tr>
        \${(data.tokens || []).map(token => \`
          <tr>
            <td>\${token.label}</td>
            <td class="mono">\${token.projectId}</td>
            <td>\${token.readOnly ? 'yes' : 'no'}</td>
            <td>\${new Date(token.createdAt).toLocaleDateString()}</td>
            <td>\${token.lastUsed ? new Date(token.lastUsed).toLocaleDateString() : 'not availableÂ'}</td>
            <td><button class="btn btn-danger btn-sm" onclick="revokeToken('\${token.id}')">Revoke</button></td>
          </tr>
        \`).join('')}
      </table>
    </div>
  \`;
}

async function createToken() {
  const label = document.getElementById('new-label').value;
  const projectId = document.getElementById('new-project').value;
  if (!label || !projectId) { alert('Label and project ID required'); return; }
  try {
    const res = await api('/v1/admin/tokens', { method: 'POST', body: JSON.stringify({ label, project_id: projectId }) });
    document.getElementById('new-token-result').innerHTML = \`
      <div class="alert alert-info" style="margin-top:8px">
        Token created (copy it now - it will not be shown again):<br>
        <strong class="mono">\${res.token}</strong>
      </div>
    \`;
    loadTokens();
  } catch (e) {
    alert('Error: ' + e);
  }
}

async function revokeToken(id) {
  if (!confirm('Revoke this token?')) return;
  await api('/v1/admin/tokens/' + id, { method: 'DELETE' });
  loadTokens();
}

async function loadCopilotAuthPage() {
  const el = document.getElementById('copilot-auth-result');
  if (el) el.innerHTML = '';
}

async function initCopilotAuth() {
  const el = document.getElementById('copilot-auth-result');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await api('/v1/admin/copilot-auth/init', { method: 'POST', body: '{}' });
    el.innerHTML = \`
      <div class="alert alert-info mb-16">
        <strong>Step 1:</strong> Go to <a href="\${data.verification_uri}" target="_blank">\${data.verification_uri}</a><br>
        <strong>Step 2:</strong> Enter code: <strong class="mono">\${data.user_code}</strong>
      </div>
      <button class="btn btn-success" onclick="completeCopilotAuth('\${data.device_code}')">I have authorized - Complete</button>
    \`;
  } catch (e) {
    el.innerHTML = \`<div class="alert alert-error">Error: \${e}</div>\`;
  }
}

async function completeCopilotAuth(deviceCode) {
  const el = document.getElementById('copilot-auth-result');
  try {
    const data = await api('/v1/admin/copilot-auth/complete', { method: 'POST', body: JSON.stringify({ device_code: deviceCode }) });
    if (data.status === 'pending') {
      el.innerHTML += '<div class="alert alert-warn">Still pending. Try again in a few seconds.</div>';
    } else {
      el.innerHTML = '<div class="alert alert-info">Copilot authenticated successfully.</div>';
    }
  } catch (e) {
    el.innerHTML += \`<div class="alert alert-error">Error: \${e}</div>\`;
  }
}

function normalizeProvider(provider) {
  return {
    ...provider,
    status: provider.status ?? provider.state ?? 'degraded',
    modelCount: provider.modelCount ?? provider.model_count ?? provider.models?.length ?? 0,
    lastLatencyMs: provider.lastLatencyMs ?? provider.last_latency_ms ?? 0,
    lastError: provider.lastError ?? provider.last_error ?? null,
    lastFailureType: provider.lastFailureType ?? provider.last_failure_type ?? null,
    blockingReason: provider.blockingReason ?? provider.blocking_reason ?? null,
    consecutiveFailures: provider.consecutiveFailures ?? provider.consecutive_failures ?? 0,
    recoveryAt: provider.recoveryAt ?? provider.recovery_at ?? null,
    recoveryInMs: provider.recoveryInMs ?? provider.recovery_in_ms ?? null,
    routable: provider.routable ?? false,
  };
}

function humanizeText(value) {
  return String(value ?? '').replace(/_/g, ' ');
}

function stateMeta(state) {
  switch (state) {
    case 'healthy':
      return { badgeClass: 'badge-green', dotClass: 'dot-green' };
    case 'degraded':
    case 'cooling_down':
      return { badgeClass: 'badge-yellow', dotClass: 'dot-yellow' };
    case 'recovering':
      return { badgeClass: 'badge-blue', dotClass: 'dot-blue' };
    case 'circuit_open':
    case 'quarantined':
    case 'missing_auth':
      return { badgeClass: 'badge-red', dotClass: 'dot-red' };
    default:
      return { badgeClass: 'badge-muted', dotClass: 'dot-muted' };
  }
}

function renderProviderState(provider) {
  const meta = stateMeta(provider.status);
  const reason = provider.blockingReason ? \`<div class="muted" style="font-size:11px;margin-top:4px">\${humanizeText(provider.blockingReason)}</div>\` : '';
  return \`<span class="dot \${meta.dotClass}"></span> <span class="badge \${meta.badgeClass}">\${humanizeText(provider.status)}</span>\${reason}\`;
}

function renderLevelBadge(level) {
  if (level === 'error') return '<span class="badge badge-red">error</span>';
  if (level === 'warn') return '<span class="badge badge-yellow">warn</span>';
  return '<span class="badge badge-green">ok</span>';
}

function severityColor(level) {
  if (level === 'error') return 'var(--red)';
  if (level === 'warn') return 'var(--yellow)';
  return 'var(--green)';
}

function formatRecovery(provider) {
  if (provider.recoveryInMs) {
    return \`\${fmtDuration(provider.recoveryInMs)}<div class="muted" style="font-size:11px;margin-top:4px">\${formatTimestamp(provider.recoveryAt)}</div>\`;
  }
  if (provider.status === 'recovering') {
    return '<span class="badge badge-blue">probe open</span>';
  }
  return 'not availableÂ';
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  if (ms < 1000) return ms + 'ms';
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(hours + 'h');
  if (minutes > 0) parts.push(minutes + 'm');
  if (seconds > 0 || parts.length === 0) parts.push(seconds + 's');
  return parts.join(' ');
}

function formatTimestamp(ts) {
  if (!ts) return 'not availableÂ';
  return new Date(ts).toLocaleTimeString();
}

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

loadPage('overview');

setInterval(() => {
  const activePage = document.querySelector('.page.active');
  if (!activePage) return;
  const pageName = activePage.id.replace('page-', '');
  if (!READ_ONLY_AUTO_REFRESH_PAGES.has(pageName)) return;
  loadPage(pageName, { background: true });
}, 30000);
</script>
</body>
</html>`;
}





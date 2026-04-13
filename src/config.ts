import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

function env(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val !== undefined && val !== '') return val;
  if (fallback !== undefined) return fallback;
  return '';
}

function envBool(key: string, fallback = false): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val.toLowerCase() === 'true' || val === '1';
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function resolveDir(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(process.cwd(), raw);
}

// ─── Config structure ─────────────────────────────────────────────────────────
export interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  accountId?: string;
  gatewayName?: string;
  siteUrl?: string;
  siteName?: string;
  cliEnabled?: boolean;
  cliPath?: string;
  timeoutMs?: number;
}

export interface HubConfig {
  host: string;
  port: number;
  adminToken: string;
  secretKey: string;
  logLevel: string;
  dataDir: string;
  logDir: string;

  // Mode flags
  freeOnly: boolean;
  localOnly: boolean;
  premiumEnabled: boolean;

  // Providers
  providers: Record<string, ProviderConfig>;
}

function buildConfig(): HubConfig {
  const dataDir = resolveDir(env('HUB_DATA_DIR', './data'));
  const logDir = resolveDir(env('HUB_LOG_DIR', './logs'));

  // Ensure directories exist
  for (const dir of [dataDir, logDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const secretKey = env('HUB_SECRET_KEY');
  if (!secretKey || secretKey.length < 32) {
    throw new Error('HUB_SECRET_KEY must be set and at least 32 characters long');
  }

  const adminToken = env('HUB_ADMIN_TOKEN');
  if (!adminToken || adminToken.length < 16) {
    throw new Error('HUB_ADMIN_TOKEN must be set and at least 16 characters long');
  }

  return {
    host: env('HUB_HOST', '127.0.0.1'),
    port: envInt('HUB_PORT', 3000),
    adminToken,
    secretKey,
    logLevel: env('HUB_LOG_LEVEL', 'info'),
    dataDir,
    logDir,

    freeOnly: envBool('FREE_ONLY_MODE', false),
    localOnly: envBool('LOCAL_ONLY_MODE', false),
    premiumEnabled: envBool('PREMIUM_ENABLED', false),

    providers: {
      local: {
        enabled: envBool('LOCAL_ENABLED', true),
        baseUrl: env('LOCAL_BASE_URL', 'http://localhost:1234/v1'),
        models: env('LOCAL_MODELS') ? env('LOCAL_MODELS').split(',').map(s => s.trim()) : [],
      },
      gemini: {
        enabled: envBool('GEMINI_ENABLED', false),
        apiKey: env('GEMINI_API_KEY'),
      },
      groq: {
        enabled: envBool('GROQ_ENABLED', false),
        apiKey: env('GROQ_API_KEY'),
      },
      openrouter: {
        enabled: envBool('OPENROUTER_ENABLED', false),
        apiKey: env('OPENROUTER_API_KEY'),
        siteUrl: env('OPENROUTER_SITE_URL', 'http://localhost:3000'),
        siteName: env('OPENROUTER_SITE_NAME', 'ai-access-hub'),
      },
      mistral: {
        enabled: envBool('MISTRAL_ENABLED', false),
        apiKey: env('MISTRAL_API_KEY'),
      },
      cerebras: {
        enabled: envBool('CEREBRAS_ENABLED', false),
        apiKey: env('CEREBRAS_API_KEY'),
      },
      cloudflare: {
        enabled: envBool('CLOUDFLARE_ENABLED', false),
        apiKey: env('CLOUDFLARE_API_TOKEN'),
        accountId: env('CLOUDFLARE_ACCOUNT_ID'),
        gatewayName: env('CLOUDFLARE_GATEWAY_NAME'),
      },
      'github-models': {
        enabled: envBool('GITHUB_MODELS_ENABLED', false),
        apiKey: env('GITHUB_MODELS_TOKEN'),
      },
      sambanova: {
        enabled: envBool('SAMBANOVA_ENABLED', false),
        apiKey: env('SAMBANOVA_API_KEY'),
      },
      cohere: {
        enabled: envBool('COHERE_ENABLED', false),
        apiKey: env('COHERE_API_KEY'),
      },
      fireworks: {
        enabled: envBool('FIREWORKS_ENABLED', false),
        apiKey: env('FIREWORKS_API_KEY'),
      },
      copilot: {
        enabled: envBool('COPILOT_ENABLED', false),
      },
      codex: {
        enabled: envBool('CODEX_ENABLED', false),
        apiKey: env('OPENAI_API_KEY'),
        cliEnabled: envBool('CODEX_CLI_ENABLED', false),
        cliPath: env('CODEX_CLI_PATH', process.platform === 'win32' ? 'codex.cmd' : 'codex'),
        timeoutMs: envInt('CODEX_CLI_TIMEOUT_MS', 120_000),
      },
    },
  };
}

let _config: HubConfig | null = null;

export function getConfig(): HubConfig {
  if (!_config) _config = buildConfig();
  return _config;
}

/** Reload config (e.g., after env changes via admin API) */
export function reloadConfig(): HubConfig {
  _config = null;
  return getConfig();
}

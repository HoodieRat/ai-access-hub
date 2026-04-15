/**
 * GitHub Copilot membership adapter.
 *
 * Authentication flow:
 * 1. User triggers /v1/admin/copilot-auth/init to start GitHub device OAuth flow.
 * 2. Device code and verification URL presented to user.
 * 3. After user authorizes, exchange for GitHub OAuth token stored in secrets.
 * 4. On each request, exchange GitHub OAuth token for a short-lived Copilot session token.
 *    (Session tokens expire ~30 minutes; auto-refreshed.)
 *
 * The Copilot API is OpenAI-compatible at https://api.githubcopilot.com.
 */

import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderLimitConfig,
  AdapterRequest,
  AdapterResponse,
  LimitState,
  FailureType,
} from '../types';
import {
  BaseAdapter,
  HealthCheckResult,
  ProviderError,
  classifyHttpError,
  doFetch,
  estimateMessagesTokens,
} from './base';
import { OpenAICompatAdapter } from './openai-compat';
import { getSecret, setSecret } from '../secrets';
import { getConfig } from '../config';
import { Readable } from 'stream';

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // GitHub Copilot VS Code app client ID (public)
const COPILOT_BASE = 'https://api.githubcopilot.com';
const SESSION_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

const CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: false,
  structuredOutput: false, embeddings: false, rerank: false, longContext: true,
};

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o',
    providerId: 'copilot', name: 'GPT-4o (Copilot)',
    qualityTier: 'tier_membership_premium', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: CAPS, aliases: ['premium-code', 'premium-review'], isFree: false,
  },
  {
    id: 'gpt-4o-mini',
    providerId: 'copilot', name: 'GPT-4o Mini (Copilot)',
    qualityTier: 'tier_membership_premium', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: CAPS, aliases: [], isFree: false,
  },
  {
    id: 'claude-3.5-sonnet',
    providerId: 'copilot', name: 'Claude 3.5 Sonnet (Copilot)',
    qualityTier: 'tier_membership_frontier', contextWindow: 200_000, maxOutputTokens: 8_192,
    capabilities: CAPS, aliases: ['frontier-manual'], isFree: false,
  },
  {
    id: 'o1-mini',
    providerId: 'copilot', name: 'o1 Mini (Copilot)',
    qualityTier: 'tier_membership_frontier', contextWindow: 128_000, maxOutputTokens: 65_536,
    capabilities: { ...CAPS, tools: false }, aliases: ['frontier-manual'], isFree: false,
  },
];

function formatCopilotAuthError(rawText: string): string {
  if (!rawText) return 'Copilot auth failed';

  try {
    const data = JSON.parse(rawText) as {
      error_details?: { message?: string; title?: string };
      message?: string;
    };
    const detail = data.error_details?.message ?? data.error_details?.title ?? data.message;
    if (detail) return `Copilot auth failed: ${detail}`;
  } catch {
    // Fall back to raw text below.
  }

  return `Copilot auth failed: ${rawText.slice(0, 200)}`;
}

// ─── Device auth flow ─────────────────────────────────────────────────────────
export interface DeviceCodeResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export async function startCopilotDeviceAuth(): Promise<DeviceCodeResult> {
  const resp = await doFetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: '' }),
    timeoutMs: 15_000,
  });
  if (!resp.ok) throw new Error(`Device auth failed: HTTP ${resp.status}`);
  const data = await resp.json() as {
    device_code: string; user_code: string; verification_uri: string;
    expires_in: number; interval: number;
  };
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

export async function pollCopilotDeviceAuth(deviceCode: string, intervalSec: number): Promise<string | null> {
  const resp = await doFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    timeoutMs: 15_000,
  });
  if (!resp.ok) return null;
  const data = await resp.json() as { access_token?: string; error?: string };
  return data.access_token ?? null;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────
export class CopilotAdapter extends BaseAdapter {
  readonly providerId = 'copilot';
  readonly providerName = 'GitHub Copilot';
  readonly authType = 'oauth';
  readonly capabilities = CAPS;
  readonly qualityTier = 'tier_membership_premium' as const;
  readonly defaultLimitConfig: ProviderLimitConfig = {
    rpm: null,
    rpd: null,
    tpm: null,
    tpd: null,
    monthlyRequests: 1_500,
    monthlyTokens: null,
    confidence: 'official',
    poolScope: 'provider',
    poolKey: 'copilot-pro-plus',
    sourceLabel: 'GitHub Copilot Pro+ premium request allowance',
  };

  private sessionToken: string | null = null;
  private sessionTokenExpiresAt = 0;

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    this._enabled = cfg.providers.copilot.enabled && cfg.premiumEnabled;
    const githubToken = getSecret('copilot_oauth_token');
    this._authenticated = !!githubToken;
  }

  private async ensureSessionToken(): Promise<string> {
    if (this.sessionToken && Date.now() < this.sessionTokenExpiresAt - 60_000) {
      return this.sessionToken;
    }
    const githubToken = getSecret('copilot_oauth_token');
    if (!githubToken) throw new ProviderError('Copilot: not authenticated', 'auth_failure');

    const resp = await doFetch(SESSION_TOKEN_URL, {
      headers: {
        Authorization: `token ${githubToken}`,
        'User-Agent': 'GitHubCopilotChat/0.22.4',
        Accept: 'application/json',
        Editor: 'vscode',
        'Editor-Version': 'vscode/1.92.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
      timeoutMs: 15_000,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        throw new ProviderError(formatCopilotAuthError(txt), 'auth_failure', resp.status);
      }
      throw new ProviderError(`Copilot token refresh failed: ${resp.status} ${txt.slice(0, 100)}`, 'server_error', resp.status);
    }

    const data = await resp.json() as { token: string; expires_at?: number };
    this.sessionToken = data.token;
    this.sessionTokenExpiresAt = data.expires_at
      ? data.expires_at * 1000
      : Date.now() + 29 * 60_000;
    return this.sessionToken;
  }

  override async healthCheck(): Promise<HealthCheckResult> {
    if (!this._authenticated) return { healthy: false, latencyMs: 0, error: 'Not authenticated' };
    const start = Date.now();
    try {
      await this.ensureSessionToken();
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (e) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: String(e),
        failureType: e instanceof ProviderError ? e.failureType : this.classifyFailure(e),
      };
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    return DEFAULT_MODELS;
  }

  override async executeCompletion(req: AdapterRequest): Promise<AdapterResponse> {
    const token = await this.ensureSessionToken();
    const url = `${COPILOT_BASE}/chat/completions`;

    const body: Record<string, unknown> = {
      model: req.model || 'gpt-4o',
      messages: req.messages,
      stream: req.stream ?? false,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.tools?.length) body.tools = req.tools;

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Copilot-Integration-Id': 'vscode-chat',
      'User-Agent': 'GitHubCopilotChat/0.22.4',
      Editor: 'vscode',
      'Editor-Version': 'vscode/1.92.0',
      'openai-intent': 'conversation-panel',
    };

    const resp = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const failureType = classifyHttpError(resp.status, text);
      throw new ProviderError(`copilot: HTTP ${resp.status} – ${text.slice(0, 200)}`, failureType, resp.status);
    }

    if (req.stream) {
      if (!resp.body) throw new ProviderError('No body', 'unknown');
      const nodeStream = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
      const promptTokens = estimateMessagesTokens(req.messages);
      return {
        id: `copilot-stream-${Date.now()}`,
        content: '', finishReason: null,
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
        streamResponse: nodeStream,
      };
    }

    const data = await resp.json() as { id?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
    const choice = data.choices?.[0];
    return {
      id: data.id ?? `copilot-${Date.now()}`,
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage: this.normalizeUsage(data.usage),
      rawResponse: data,
    };
  }

  override getRateState(): LimitState[] { return []; }

  override classifyFailure(error: unknown): FailureType {
    if (error instanceof ProviderError) return error.failureType;
    const msg = String(error).toLowerCase();
    if (msg.includes('timeout') || msg.includes('abort')) return 'timeout';
    return 'unknown';
  }

  override normalizeUsage(rawUsage: unknown): import('../types').UsageEstimate {
    const u = rawUsage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
    if (!u) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    return {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
    };
  }
}

/**
 * Codex / OpenAI premium adapter.
 *
 * Supports either the OpenAI API (via OPENAI_API_KEY) or a locally installed,
 * logged-in Codex CLI (via CODEX_CLI_ENABLED).
 * Only enabled when premiumEnabled=true.
 * Used primarily for premium coding and reasoning requests.
 */

import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import type { AdapterRequest, AdapterResponse, FailureType, ModelInfo, ProviderCapabilities } from '../types';
import { ProviderError, estimateMessagesTokens, estimateTokens } from './base';
import { getConfig } from '../config';
import { OpenAICompatAdapter } from './openai-compat';

const API_CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: true, vision: true,
  structuredOutput: true, embeddings: true, rerank: false, longContext: true,
};

const CLI_CAPS: ProviderCapabilities = {
  chat: true, streaming: true, tools: false, vision: false,
  structuredOutput: false, embeddings: false, rerank: false, longContext: true,
};

const DEFAULT_CLI_MODEL_ID = 'codex-default';

const API_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o',
    providerId: 'codex', name: 'GPT-4o (OpenAI)',
    qualityTier: 'tier_membership_premium', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: API_CAPS, aliases: ['premium-code', 'premium-review'], isFree: false,
  },
  {
    id: 'o1-mini',
    providerId: 'codex', name: 'o1 Mini (OpenAI)',
    qualityTier: 'tier_membership_frontier', contextWindow: 128_000, maxOutputTokens: 65_536,
    capabilities: { ...API_CAPS, tools: false }, aliases: ['frontier-manual'], isFree: false,
  },
  {
    id: 'o3-mini',
    providerId: 'codex', name: 'o3 Mini (OpenAI)',
    qualityTier: 'tier_membership_frontier', contextWindow: 200_000, maxOutputTokens: 100_000,
    capabilities: { ...API_CAPS, tools: false }, aliases: ['frontier-manual'], isFree: false,
  },
  {
    id: 'gpt-4o-mini',
    providerId: 'codex', name: 'GPT-4o Mini (OpenAI)',
    qualityTier: 'tier_membership_premium', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: API_CAPS, aliases: [], isFree: false,
  },
];

const CLI_MODELS: ModelInfo[] = [
  {
    id: DEFAULT_CLI_MODEL_ID,
    providerId: 'codex',
    name: 'Codex CLI Default (ChatGPT Login)',
    qualityTier: 'tier_membership_frontier',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    capabilities: CLI_CAPS,
    aliases: ['premium-code', 'premium-review', 'frontier-manual'],
    isFree: false,
  },
];

type CodexMode = 'api' | 'cli' | 'disabled';

interface CodexRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class CodexAdapter extends OpenAICompatAdapter {
  private mode: CodexMode = 'disabled';
  private cliEnabled = false;
  private cliPath = 'codex';
  private cliTimeoutMs = 120_000;

  constructor() {
    const cfg = getConfig();
    const pCfg = cfg.providers.codex;
    super({
      providerId: 'codex',
      providerName: 'OpenAI / Codex (Premium)',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: pCfg.apiKey ?? '',
      capabilities: API_CAPS,
      qualityTier: 'tier_membership_frontier',
      defaultLimitConfig: {
        rpm: 60, rpd: null, tpm: 90_000, tpd: null,
        monthlyRequests: null, monthlyTokens: null, confidence: 'official',
      },
      defaultModels: API_MODELS,
      supportsModelList: false,
    });
  }

  override async initialize(): Promise<void> {
    const cfg = getConfig();
    const pCfg = cfg.providers.codex;

    this._enabled = pCfg.enabled && cfg.premiumEnabled;
    this.apiKey = pCfg.apiKey ?? '';
    this.cliEnabled = !!pCfg.cliEnabled;
    this.cliPath = normalizeCliPath(pCfg.cliPath);
    this.cliTimeoutMs = pCfg.timeoutMs && pCfg.timeoutMs > 0 ? pCfg.timeoutMs : 120_000;
    this.mode = 'disabled';
    this._models = API_MODELS;

    if (!this._enabled) {
      this._authenticated = false;
      return;
    }

    if (this.apiKey) {
      this.mode = 'api';
      this._authenticated = true;
      this._models = API_MODELS;
      return;
    }

    if (!this.cliEnabled) {
      this._authenticated = false;
      return;
    }

    this.mode = 'cli';
    this._models = CLI_MODELS;
    this._authenticated = await this.isCliLoggedIn();
  }

  override async healthCheck(): Promise<import('./base').HealthCheckResult> {
    if (this.mode !== 'cli') {
      return super.healthCheck();
    }

    const start = Date.now();
    try {
      const status = await this.getCliStatus();
      return {
        healthy: status.loggedIn,
        latencyMs: Date.now() - start,
        error: status.loggedIn ? undefined : status.message,
      };
    } catch (e) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  override async executeCompletion(req: AdapterRequest): Promise<AdapterResponse> {
    if (this.mode !== 'cli') {
      return super.executeCompletion(req);
    }

    this.assertCliRequestSupported(req);

    const tempDir = await mkdtemp(join(tmpdir(), 'ai-access-hub-codex-'));
    const outputPath = join(tempDir, 'last-message.txt');
    const prompt = renderCodexPrompt(req.messages);
    const cliArgs = ['-s', 'read-only', 'exec', '-C', tempDir, '--skip-git-repo-check', '--ephemeral', '-o', outputPath];
    const requestedModel = this.resolveCliModelArg(req.model);
    if (requestedModel) {
      cliArgs.push('-m', requestedModel);
    }
    cliArgs.push('-');

    try {
      const result = await this.runCodex(cliArgs, prompt, tempDir, this.cliTimeoutMs);
      const combinedOutput = combineProcessOutput(result.stdout, result.stderr);

      if (result.timedOut) {
        throw new ProviderError(`codex cli timed out after ${this.cliTimeoutMs}ms`, 'timeout', undefined, true);
      }

      if (result.code !== 0) {
        throw buildCodexCliError(result, combinedOutput, this.cliPath);
      }

      let content = '';
      try {
        content = (await readFile(outputPath, 'utf8')).replace(/\r\n/g, '\n').trimEnd();
      } catch {
        // The CLI writes the final answer to the output file when successful.
      }

      if (!content) {
        throw new ProviderError('codex cli returned no final message', 'unknown');
      }

      const promptTokens = estimateMessagesTokens(req.messages);
      const completionTokens = estimateTokens(content);
      const usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
      const responseId = `codex-cli-${Date.now()}`;

      return {
        id: responseId,
        content,
        finishReason: 'stop',
        usage,
        rawResponse: {
          mode: 'codex-cli',
          command: this.cliPath,
          output: combinedOutput,
        },
        streamResponse: req.stream
          ? buildSyntheticCodexStream(responseId, req.model || DEFAULT_CLI_MODEL_ID, content)
          : undefined,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  override classifyFailure(error: unknown): FailureType {
    if (error instanceof ProviderError) return error.failureType;

    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
      if (msg.includes('not logged in') || msg.includes('login required') || msg.includes('authenticate')) return 'auth_failure';
      if (msg.includes('enoent') || msg.includes('not recognized as an internal or external command') || msg.includes('command not found')) {
        return 'network_error';
      }
    }

    return super.classifyFailure(error);
  }

  private async isCliLoggedIn(): Promise<boolean> {
    const status = await this.getCliStatus();
    return status.loggedIn;
  }

  private async getCliStatus(): Promise<{ loggedIn: boolean; message?: string }> {
    try {
      const result = await this.runCodex(['login', 'status'], undefined, process.cwd(), Math.min(this.cliTimeoutMs, 15_000));
      const combinedOutput = combineProcessOutput(result.stdout, result.stderr);
      if (result.timedOut) {
        return { loggedIn: false, message: 'Codex CLI login status timed out' };
      }
      if (result.code === 0 && /logged in/i.test(combinedOutput)) {
        return { loggedIn: true };
      }
      return {
        loggedIn: false,
        message: extractCodexCliMessage(combinedOutput) || `Codex CLI status failed with exit code ${result.code ?? 'unknown'}`,
      };
    } catch (e) {
      return {
        loggedIn: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private assertCliRequestSupported(req: AdapterRequest): void {
    if (req.tools?.length || req.toolChoice !== undefined) {
      throw new ProviderError('codex cli mode does not support tool calling', 'unknown');
    }
    if (req.responseFormat) {
      throw new ProviderError('codex cli mode does not support structured response_format enforcement', 'unknown');
    }
    if (hasVisionInputs(req.messages)) {
      throw new ProviderError('codex cli mode does not support image inputs', 'unknown');
    }
  }

  private resolveCliModelArg(modelId: string): string | null {
    return modelId && modelId !== DEFAULT_CLI_MODEL_ID ? modelId : null;
  }

  private runCodex(args: string[], input?: string, cwd?: string, timeoutMs = this.cliTimeoutMs): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const child = process.platform === 'win32'
        ? spawn(buildWindowsCodexCommand(this.cliPath, args), {
            cwd,
            stdio: 'pipe',
            windowsHide: true,
            shell: true,
          })
        : spawn(this.cliPath, args, {
            cwd,
            stdio: 'pipe',
            windowsHide: true,
          });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, timedOut });
      });

      if (input !== undefined) {
        child.stdin.end(input, 'utf8');
      } else {
        child.stdin.end();
      }
    });
  }
}

function renderCodexPrompt(messages: AdapterRequest['messages']): string {
  const header = [
    'You are running inside ai-access-hub via the local Codex CLI.',
    'Use only the conversation provided below as context.',
    'Do not inspect local files, repositories, or shell state.',
    'Answer directly and do not mention this wrapper unless the user asks.',
  ].join(' ');

  const renderedMessages = messages.map(message => {
    const parts = [`${message.role.toUpperCase()}:`];
    const content = renderMessageContent(message.content);
    if (content) parts.push(content);
    if (message.name) parts.push(`Name: ${message.name}`);
    if (message.tool_call_id) parts.push(`Tool call id: ${message.tool_call_id}`);
    if (message.tool_calls?.length) parts.push(`Tool calls: ${JSON.stringify(message.tool_calls, null, 2)}`);
    return parts.join('\n');
  });

  return [header, ...renderedMessages].join('\n\n');
}

function renderMessageContent(content: AdapterRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';

  return content.map(part => {
    if (part.type === 'text') return part.text ?? '';
    return '[Image omitted by ai-access-hub Codex CLI mode]';
  }).join('\n');
}

function hasVisionInputs(messages: AdapterRequest['messages']): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
}

function combineProcessOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

function extractCodexCliMessage(output: string): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const errorLine = lines.find(line => line.startsWith('ERROR:'));
  if (errorLine) {
    const jsonText = errorLine.slice('ERROR:'.length).trim();
    try {
      const parsed = JSON.parse(jsonText) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      return jsonText;
    }
  }
  return lines.slice(-3).join(' ').slice(0, 300);
}

function buildCodexCliError(result: CodexRunResult, output: string, cliPath: string): ProviderError {
  const message = extractCodexCliMessage(output);
  const normalized = message.toLowerCase();

  if (normalized.includes('not logged in') || normalized.includes('login required') || normalized.includes('authenticate')) {
    return new ProviderError(`codex cli: ${message}`, 'auth_failure');
  }
  if (normalized.includes('rate limit') || normalized.includes('too many requests') || normalized.includes('status":429')) {
    return new ProviderError(`codex cli: ${message}`, 'rate_limit', undefined, true);
  }
  if (normalized.includes('context') || normalized.includes('token')) {
    return new ProviderError(`codex cli: ${message}`, 'context_too_long');
  }
  if (normalized.includes('not recognized as an internal or external command') || normalized.includes('enoent') || normalized.includes('command not found')) {
    return new ProviderError(`codex cli executable not found: ${cliPath}`, 'network_error');
  }
  if (result.signal) {
    return new ProviderError(`codex cli exited via signal ${result.signal}`, 'server_error', undefined, true);
  }
  return new ProviderError(`codex cli: ${message || `process exited with code ${result.code ?? 'unknown'}`}`, 'unknown');
}

function buildSyntheticCodexStream(id: string, model: string, content: string): NodeJS.ReadableStream {
  const created = Math.floor(Date.now() / 1000);
  const chunks: string[] = [];

  if (content) {
    chunks.push(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`);
  }

  chunks.push(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`);

  return Readable.from(chunks);
}

function normalizeCliPath(cliPath?: string): string {
  const trimmed = cliPath?.trim();
  if (trimmed) {
    if (process.platform === 'win32' && trimmed.toLowerCase() === 'codex') return 'codex.cmd';
    return trimmed;
  }
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

function buildWindowsCodexCommand(command: string, args: string[]): string {
  return [quoteWindowsShellArg(command), ...args.map(quoteWindowsShellArg)].join(' ');
}

function quoteWindowsShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

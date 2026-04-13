import { LocalAdapter } from './local';
import { GeminiAdapter } from './gemini';
import { GroqAdapter } from './groq';
import { OpenRouterAdapter } from './openrouter';
import { MistralAdapter } from './mistral';
import { CerebrasAdapter } from './cerebras';
import { CloudflareAdapter } from './cloudflare';
import { GitHubModelsAdapter } from './github-models';
import { SambaNovaAdapter } from './sambanova';
import { CohereAdapter } from './cohere';
import { FireworksAdapter } from './fireworks';
import { CopilotAdapter } from './copilot';
import { CodexAdapter } from './codex';
import type { BaseAdapter } from './base';

export function createAllAdapters(): BaseAdapter[] {
  return [
    new LocalAdapter(),
    new GeminiAdapter(),
    new GroqAdapter(),
    new OpenRouterAdapter(),
    new MistralAdapter(),
    new CerebrasAdapter(),
    new CloudflareAdapter(),
    new GitHubModelsAdapter(),
    new SambaNovaAdapter(),
    new CohereAdapter(),
    new FireworksAdapter(),
    new CopilotAdapter(),
    new CodexAdapter(),
  ];
}

export { BaseAdapter } from './base';
export { LocalAdapter } from './local';
export { GeminiAdapter } from './gemini';
export { GroqAdapter } from './groq';
export { OpenRouterAdapter } from './openrouter';
export { MistralAdapter } from './mistral';
export { CerebrasAdapter } from './cerebras';
export { CloudflareAdapter } from './cloudflare';
export { GitHubModelsAdapter } from './github-models';
export { SambaNovaAdapter } from './sambanova';
export { CohereAdapter } from './cohere';
export { FireworksAdapter } from './fireworks';
export { CopilotAdapter, startCopilotDeviceAuth, pollCopilotDeviceAuth } from './copilot';
export { CodexAdapter } from './codex';

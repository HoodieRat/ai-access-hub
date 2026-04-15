# AI Access Hub

AI Access Hub is a local AI traffic router. You run it on your own machine, connect the AI services you already have access to, and your apps use one local OpenAI-compatible endpoint instead of dealing with every provider separately.

In plain English:

- your app talks to one local URL
- the hub picks the best enabled provider for the job
- it prefers free or already-included usage first
- it falls back when a provider is down, unhealthy, or rate-limited
- you can watch usage, warnings, and provider health in a browser dashboard

Current scope: 13 providers across free, membership, premium, and local lanes.

See [COMMANDS.md](COMMANDS.md) for the canonical command list, [FOR-DUMMIES.md](FOR-DUMMIES.md) for the plain-language hookup and stack guide, and [todo.md](todo.md) for the live implementation checklist.

---

## What This Project Actually Is

This is not a chatbot product, not a hosted AI website, and not a company that gives you a brand-new AI subscription.

It is local middleware for your own apps, tools, scripts, and agent frameworks.

Your project sends requests to one local endpoint:

```text
http://127.0.0.1:3099/v1
```

The hub then decides which configured provider should answer, based on quality, availability, and your routing rules.

## How Much Free AI Does It Give?

Short answer: the hub itself gives you `0` provider credits until you connect providers.

What it really gives you is one place to combine the recurring free or included quotas from multiple services, so your apps can use those lanes through one endpoint instead of ten different integrations.

Selected recurring free or included lanes documented in this repo as of April 2026:

| Provider lane | Rough recurring included usage |
|---|---|
| Gemini Flash | 45,000 requests/month |
| Gemini Pro | 1,500 requests/month |
| Groq fast lane | 432,000 requests/month |
| Groq strong lane | 30,000 requests/month |
| GitHub Models low-tier | 4,500 requests/month |
| OpenRouter free | 1,500 to 30,000 free-model requests/month |
| Cerebras free inference | 30,000,000 tokens/month |
| Mistral Experiment | 1,000,000,000 tokens/month |
| Cloudflare Workers AI | 300,000 neurons/month |
| Cohere trial/eval | 1,000 API calls/month |

Important: these are separate buckets, not one giant shared monthly allowance. Some providers meter requests, some meter tokens, some meter neurons, and local models are limited by your hardware instead of a provider quota.

Practical takeaway: once you connect several of the common free providers, the hub can give you access to a large amount of recurring free usage, often ranging from thousands to hundreds of thousands of chat requests per month plus large token-based allowances on providers like Cerebras and Mistral, before you need paid routes.

## How To Read The Dashboard

The dashboard is designed to avoid fake precision.

- `provider synced` means the vendor reported live remaining quota, so the number is true remaining for that pool.
- `hub only` means the hub is subtracting only traffic that passed through this hub instance from the configured ceiling.
- `ceiling only` means the hub knows the published vendor limit but does not have live remaining coverage for that unit yet.

Examples:

- GitHub Models, Groq, and SambaNova can become `provider synced` when their APIs expose usable rate-limit headers.
- Mistral and Cohere can show meaningful monthly headroom because the hub tracks requests or tokens locally against the configured monthly ceiling.
- Cloudflare Workers AI currently shows the published neuron ceiling, but not live remaining neurons, because the hub does not yet receive provider-reported neuron consumption.

This means the dashboard is a reliable planning and routing surface, but you still need to read the coverage badge before treating any remaining number as full provider-account truth.

---

## Quick Start

### Windows

```bat
install.bat   # one-time setup
start.bat     # launch hub
stop.bat      # clean shutdown
```

Windows stack packages now start with the OpenClaw flow:

```bat
setup-openclaw.bat   # adopt existing OpenClaw, wire hub, optional Docker Qdrant
```

### Linux / macOS

```sh
chmod +x install.sh start.sh
./install.sh  # one-time setup
./start.sh    # launch hub
./stop.sh     # clean shutdown
```

Then open **http://127.0.0.1:3099/dashboard**

For Hermes game-planning sessions, this repo includes an opt-in AFK runner that can auto-send `continue`, detect hard failure patterns, and switch to a conservative caveman recovery mode when you explicitly invoke it. It does not alter default Hermes behavior for normal projects.

Quick usage:

```sh
npm run hermes:afk:rpg
```

Conservative game-recovery usage:

```sh
npm run hermes:afk:caveman
```

Generic usage:

```sh
npm run hermes:afk -- --prompt-file ./your-prompt.txt --auto-continue --max-continues 12 --done-marker YOUR_DONE_MARKER
```

Scope boundary: these scripts supervise Hermes sessions from outside. They do not remove Hermes core sandbox/tool/provider restrictions.

If you are building the Windows OpenClaw stack rather than only the hub, see [SETUP.md](SETUP.md) and [FOR-DUMMIES.md](FOR-DUMMIES.md) for the new setup package flow.

Before publishing or handing this off for production use, run:

```sh
npm run verify
```

The checked-in launchers now return success only after `GET /health` reports `status: ok`.

---

## Use It

The hub exposes an OpenAI-compatible API. Point any OpenAI SDK at it:

If you want the plain-language hookup steps, project connection examples, and the top free orchestration recommendations for Windows and Linux, see [SETUP.md](SETUP.md).

```python
from openai import OpenAI

client = OpenAI(
  base_url="http://127.0.0.1:3099/v1",
  api_key="YOUR_HUB_CLIENT_TOKEN",
)

response = client.chat.completions.create(
    model="fast-free",   # or any alias / upstream model ID
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

---

## Supported Providers

| Provider | Tier | Auth | Notes |
|---|---|---|---|
| **Local** | local | none | Any OpenAI-compat local runtime (LM Studio, Ollama…) |
| **Gemini** | free | API key | 1M token context; flash + pro |
| **Groq** | free | API key | Fast inference; llama-3.3-70b, llama-3.1-8b |
| **OpenRouter** | free | API key | Free model routing; metarouter |
| **Mistral** | free | API key | Codestral for coding |
| **Cerebras** | free | API key | Ultra-fast llama inference |
| **Cloudflare** | free | API + Account ID | Workers AI; llama, gemma, qwen |
| **GitHub Models** | free | PAT | GPT-4o, Phi-3.5, llama-405b |
| **SambaNova** | free | API key | llama-3.1-405b |
| **Cohere** | free | API key | Strong embeddings + rerank |
| **Fireworks** | paid / one-time credit | API key | Not counted as recurring free quota in the hub dashboard |
| **GitHub Copilot** | membership | OAuth | Requires GitHub Copilot Pro+ |
| **Codex / OpenAI** | premium | API key or local Codex CLI login | OpenAI API key or logged-in ChatGPT Codex CLI |

---

## Model Aliases

Use short aliases instead of model IDs — the hub picks the best available:

| Alias | Selects |
|---|---|
| `fast-free` | Fastest free model (Groq / Cerebras) |
| `strong-free` | Strongest free model (Gemini / llama-405b) |
| `strong-code` | Best coding model (Copilot / Codestral) |
| `agent-build` | Planning-first lane for large scaffold and tool-heavy agent work |
| `strong-long-context` | Longest context (Gemini 1.5 Pro) |
| `local-fast` | Local runtime fast model |
| `local-strong` | Local runtime capable model |
| `premium-code` | GitHub Copilot (membership lane) |
| `embeddings-fast` | Fastest embedding provider |
| `embeddings-strong` | Best embedding quality (Cohere) |
| `rerank-strong` | Cohere rerank |

---

## API Reference

All routes accept `Authorization: Bearer <token>`.  
Admin routes (`/v1/admin/*`) require the admin token.

### Core

| Method | Path | Description |
|---|---|---|
| GET | /health | Liveness check |
| GET | /v1/models | List all available models |
| GET | /v1/routes | Alias→provider mapping |
| GET | /v1/providers | Provider status list |
| POST | /v1/chat/completions | Chat completions (streaming supported) |
| POST | /v1/responses | Alias for chat completions |
| POST | /v1/embeddings | Text embeddings |
| POST | /v1/rerank | Document reranking (Cohere) |

### Usage & Warnings

| Method | Path | Description |
|---|---|---|
| GET | /v1/usage | 24h usage summary by provider |
| GET | /v1/limits | Current quota window states |
| GET | /v1/warnings | Active quota warnings |
| POST | /v1/warnings/:id/resolve | Dismiss a warning |

### Admin

| Method | Path | Description |
|---|---|---|
| GET | /v1/admin/modes | Read free_only / local_only / premium_enabled |
| POST | /v1/admin/modes | Toggle mode flags |
| GET | /v1/admin/tokens | List client tokens |
| POST | /v1/admin/tokens | Create client token |
| DELETE | /v1/admin/tokens/:id | Revoke client token |
| GET | /v1/admin/secrets | List stored secret keys (masked) |
| POST | /v1/admin/secrets | Store encrypted secret |
| POST | /v1/admin/test-provider | Live health-check a provider |
| POST | /v1/admin/reset-provider | Clear circuit breaker + quarantine |
| POST | /v1/admin/force-route | Debug route resolution |
| POST | /v1/classify-route | Classify a request without routing |
| GET | /v1/admin/cache | Cache stats |
| DELETE | /v1/admin/cache | Clear all caches |
| GET | /v1/admin/doctor | Full diagnostics report |
| GET | /v1/admin/export-usage | Export logs (JSON or CSV) |
| POST | /v1/admin/copilot-auth/init | Start Copilot device OAuth flow |
| POST | /v1/admin/copilot-auth/complete | Complete Copilot OAuth |
| POST | /v1/admin/reload | Reload config and reinitialize adapters |
| POST | /v1/admin/shutdown | Graceful hub shutdown |

### Hub Request Extensions

Add these fields to any `/v1/chat/completions` request body:

```json
{
  "model": "strong-code",
  "messages": [...],
  "route_policy": "quality",
  "model_alias": "strong-free",
  "task_profile": "repo_scaffold",
  "forbid_paid": true,
  "prefer_local": false,
  "max_provider_hops": 3,
  "cache_policy": "default",
  "allow_downgrade_with_approval": false
}
```

Useful task profiles:

- `tiny_reply` for very short utility answers
- `general_chat` for normal back-and-forth
- `planning` for higher-stability reasoning/planning turns
- `codegen` for focused implementation requests
- `repo_scaffold` for large project/app/game scaffolding
- `long_context` when context size should dominate routing

---

## Environment Variables

See `.env.example` for the full list. Minimum required:

```env
HUB_SECRET_KEY=<32+ char random string>
HUB_ADMIN_TOKEN=<16+ char admin password>
```

Then add API keys for the providers you want to use.

---

## Security

- Listens on `127.0.0.1` only by default
- All provider API keys encrypted at rest with AES-256-GCM
- Admin routes require bearer token (constant-time comparison)
- Client tokens are scoped per-project
- No provider credentials are ever returned in API responses

For production use on a single machine, keep `HUB_HOST=127.0.0.1`. Only change the bind host intentionally when you are putting the hub behind a trusted LAN or an explicit reverse proxy.

---

## Data Files

All state is stored in `data/`:

```
data/
  hub.db     SQLite: usage, cache, health, secrets, logs, tokens
```

---

## License

MIT

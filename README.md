# AI Access Hub

A local, unified API router for 13 AI providers. Drop-in OpenAI-compatible endpoint that routes requests across free, membership, and local providers — with smart fallback, caching, quota tracking, and a browser dashboard.

See [COMMANDS.md](COMMANDS.md) for the canonical command list, [FOR-DUMMIES.md](FOR-DUMMIES.md) for the plain-language hookup and stack guide, and [todo.md](todo.md) for the live implementation checklist.

---

## Quick Start

### Windows

```bat
install.bat   # one-time setup
start.bat     # launch hub
stop.bat      # clean shutdown
```

### Linux / macOS

```sh
chmod +x install.sh start.sh
./install.sh  # one-time setup
./start.sh    # launch hub
./stop.sh     # clean shutdown
```

Then open **http://127.0.0.1:3099/dashboard**

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
| **Fireworks** | free | API key | llama, mistral, qwen |
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
  "forbid_paid": true,
  "prefer_local": false,
  "max_provider_hops": 3,
  "cache_policy": "default",
  "allow_downgrade_with_approval": false
}
```

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

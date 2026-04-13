# Setup Guide

Step-by-step instructions for each provider and the complete `.env` reference.

Use `COMMANDS.md` for the canonical start, stop, doctor, and verification commands. Use `FOR-DUMMIES.md` if you want the plain-language hookup guide and the best full-stack Windows/Linux orchestration recommendations.

---

## 1. Install

```sh
# Linux/macOS
chmod +x install.sh && ./install.sh

# Windows
install.bat
```

This runs `npm install` and `npm run build`. Output goes to `dist/`.

---

## 2. Configure `.env`

Minimum required on first run:

```env
# ── Security (required) ──────────────────────────────────────────────────────
# Set these to strong random values before first launch.
HUB_SECRET_KEY=replace-with-32-plus-random-chars-here--ok
HUB_ADMIN_TOKEN=replace-with-strong-admin-password
HUB_AUTO_OPEN_DASHBOARD=true
```

Generate strong values on any system:

```sh
# Linux/macOS
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# PowerShell
[System.Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

For normal production use on one machine, leave `HUB_HOST=127.0.0.1` so the hub stays loopback-only by default. Only change the bind host intentionally when you are deploying behind a trusted LAN or a reverse proxy you control.

---

## 3. Provider Setup

### Local (LM Studio / Ollama / llama.cpp)

No key needed. Set the base URL if it differs from default:

```env
LOCAL_ENABLED=true
LOCAL_BASE_URL=http://127.0.0.1:1234/v1   # LM Studio default
# LOCAL_BASE_URL=http://127.0.0.1:11434/v1 # Ollama
```

The hub auto-discovers available models via `/v1/models`.

---

### Google Gemini (free)

1. Go to **https://aistudio.google.com/app/apikey**
2. Click **Create API key**
3. Add to `.env`:
   ```env
   GEMINI_ENABLED=true
   GEMINI_API_KEY=AIza...
   ```

Free tier: 1,500 RPD for Flash, 50 RPD for Pro, 1M token context.

---

### Groq (free)

1. Sign up at **https://console.groq.com**
2. Go to **API Keys → Create API Key**
3. Add to `.env`:
   ```env
   GROQ_ENABLED=true
   GROQ_API_KEY=gsk_...
   ```

Models: llama-3.3-70b-versatile, llama-3.1-8b-instant, gemma2-9b-it, mixtral-8x7b.

---

### OpenRouter (free models)

1. Sign up at **https://openrouter.ai**
2. Go to **Keys → Create Key**
3. Add to `.env`:
   ```env
   OPENROUTER_ENABLED=true
   OPENROUTER_API_KEY=sk-or-...
   ```

The hub only routes to models tagged `:free` on OpenRouter. No credits required.

---

### Mistral (free tier / La Plateforme)

1. Sign up at **https://console.mistral.ai**
2. Go to **API keys → Create new key**
3. Add to `.env`:
   ```env
   MISTRAL_ENABLED=true
   MISTRAL_API_KEY=...
   ```

Includes `codestral-latest` for coding tasks (separate model endpoint).

---

### Cerebras (free)

1. Sign up at **https://cloud.cerebras.ai**
2. Navigate to **API Keys → Generate**
3. Add to `.env`:
   ```env
   CEREBRAS_ENABLED=true
   CEREBRAS_API_KEY=csk-...
   ```

Ultra-fast llama inference. Good for high-RPM burst.

---

### Cloudflare Workers AI (free)

1. Sign in to **https://dash.cloudflare.com**
2. Note your **Account ID** (top-right of overview page)
3. Go to **My Profile → API Tokens → Create Token → Workers AI template**
4. Add to `.env`:
   ```env
   CLOUDFLARE_ENABLED=true
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   ```

Optional AI Gateway (adds observability):
```env
CLOUDFLARE_GATEWAY_NAME=your-gateway-name
```

---

### GitHub Models (free)

1. Go to **https://github.com/settings/personal-access-tokens/new**
2. Create a **Fine-grained personal access token**
3. Under account permissions, grant **Models: Read**
4. Add to `.env`:
   ```env
   GITHUB_MODELS_ENABLED=true
   GITHUB_MODELS_TOKEN=ghp_...
   ```

Models: gpt-4o, gpt-4o-mini, Meta-Llama-3.1-405B, Phi-3.5-mini.  
Free tier: 150 requests per 15 min.

---

### SambaNova (free)

1. Sign up at **https://cloud.sambanova.ai**
2. Go to **API → API Keys**
3. Add to `.env`:
   ```env
   SAMBANOVA_ENABLED=true
   SAMBANOVA_API_KEY=...
   ```

Strong llama-405b available for free.

---

### Cohere (free)

1. Sign up at **https://dashboard.cohere.com**
2. Go to **API Keys → Create trial key**
3. Add to `.env`:
   ```env
   COHERE_ENABLED=true
   COHERE_API_KEY=...
   ```

Best for: embeddings (`embed-v3`), reranking (`rerank-v3`), and chat (Command R+).

---

### Fireworks (free credits)

1. Sign up at **https://fireworks.ai**
2. Go to **Account → API Keys**
3. Add to `.env`:
   ```env
   FIREWORKS_ENABLED=true
   FIREWORKS_API_KEY=fw_...
   ```

If Fireworks returns `HTTP 412`, the key is usually fine but the **account is suspended** because billing or spending-limit status needs attention.

---

### Troubleshooting The Current Problem Providers

#### Cloudflare Workers AI: `HTTP 403`

Short version: see [CLOUDFLARE-FIX.md](c:\ai-access-hub-pack\ai-access-hub\CLOUDFLARE-FIX.md).

Most likely cause: the token or account ID does not match the Cloudflare account that owns Workers AI access. In the current repo, Cloudflare is configured in direct account mode, not AI Gateway mode, so this is most likely a Cloudflare account/token setting issue rather than hub code.

For dummies fix:
1. Open **https://dash.cloudflare.com** and switch to the exact account you want to use.
2. Copy that account's **Account ID** and replace `CLOUDFLARE_ACCOUNT_ID`.
3. Create a fresh API token using the **Workers AI** template, or create a custom token with the account-level Workers AI permissions for that same account.
4. Replace `CLOUDFLARE_API_TOKEN` with the new token.
5. Restart the hub and test Cloudflare again.

Do you need to regenerate the token?
- Probably yes if you are not sure what permissions the current token has.

Is this caused by our code?
- Not likely for the current setup. The hub is using the direct Cloudflare account API because `CLOUDFLARE_GATEWAY_NAME` is not set.

Can you fix it by changing a token setting instead of rewriting code?
- Yes. The first fix to try is the token permissions and account ID.

#### GitHub Models: `HTTP 401` with `models permission is required`

Most likely cause: the GitHub token is valid, but it does not have the **Models** permission enabled.

For dummies fix:
1. Go to **https://github.com/settings/personal-access-tokens/new**.
2. Create a **Fine-grained PAT**.
3. Under account permissions, turn on **Models: Read**.
4. Copy the token into `GITHUB_MODELS_TOKEN`.
5. Restart the hub and test GitHub Models again.

Do you need to regenerate the token?
- Usually yes, unless GitHub lets you edit the existing fine-grained token and add **Models: Read**.

Is this caused by our code?
- No. The response from GitHub is explicit: the token is missing the required permission.

Can you fix it by changing a token setting?
- Yes. This is a token-permission issue, not an application bug.

#### Fireworks: `HTTP 412` account suspended / billing

Most likely cause: the Fireworks account is suspended because of billing status, unpaid invoices, or a spending-limit block.

For dummies fix:
1. Open **https://fireworks.ai/account/billing**.
2. Resolve any unpaid invoice, suspended billing state, or spending-limit issue.
3. Once the account is active again, keep the same `FIREWORKS_API_KEY` unless Fireworks explicitly revoked it.
4. Restart the hub and test Fireworks again.

Do you need to regenerate the token?
- Usually no. The error points at the account status, not the key itself.

Is this caused by our code?
- No. Fireworks is rejecting requests because the account is suspended.

Can you fix it by changing a token setting?
- Not usually. This is almost always a billing/account-status fix.

#### OpenRouter latency

The dashboard latency value is the hub health probe latency, not a full user request benchmark. Roughly `500ms` to `900ms` is normal for a remote OpenRouter probe from this machine. The hub now uses the lighter `/models` health check for OpenRouter so the dashboard latency should be lower and it avoids unnecessary completion traffic.

#### Local dashboard admin access and auto-open behavior

- When you open `/dashboard` locally on the same machine, the hub now auto-authorizes the dashboard from `HUB_ADMIN_TOKEN` using a local HttpOnly session cookie.
- You only need the old `localStorage.setItem('hub_admin_token', 'YOUR_TOKEN')` fallback if you are testing from a non-local session that does not get the local cookie.
- `start.bat` and `scripts/start.ps1` now open the dashboard automatically after the hub is ready.
- If you want to disable the browser auto-open, set `HUB_AUTO_OPEN_DASHBOARD=false` in `.env`.

---

### GitHub Copilot (membership — requires Copilot Pro+)

Uses GitHub OAuth device flow. Auth is done through the hub dashboard, not `.env`.

1. Set in `.env`:
   ```env
   COPILOT_ENABLED=true
   PREMIUM_ENABLED=true
   ```
2. Start the hub: `./start.sh` or `start.bat`
3. Open **http://127.0.0.1:3099/dashboard → Copilot Auth**
4. Click **Start Device Auth Flow**
5. Visit the URL shown and enter the code
6. Click **I've authorized – Complete** in the dashboard

The hub stores the OAuth token encrypted in SQLite. The Copilot session token
(valid ~30 min) is auto-refreshed as needed.

---

### Codex / OpenAI (premium — optional)

Two supported modes:

API-key mode:

```env
CODEX_ENABLED=true
PREMIUM_ENABLED=true
OPENAI_API_KEY=sk-...
```

Local Codex CLI mode using the ChatGPT login already present on this PC:

1. Verify the CLI is installed: `codex --version`
2. Verify the CLI is logged in: `codex login status`
3. Leave `OPENAI_API_KEY` blank and set:

```env
CODEX_ENABLED=true
PREMIUM_ENABLED=true
OPENAI_API_KEY=
CODEX_CLI_ENABLED=true
CODEX_CLI_PATH=codex
CODEX_CLI_TIMEOUT_MS=120000
```

In CLI mode the hub runs Codex in an isolated temporary working directory and
routes the premium aliases to the local Codex CLI default model.

On Windows, set `CODEX_CLI_PATH=codex.cmd` if plain `codex` does not resolve for subprocesses.

---

## 4. Start the Hub

```sh
./start.sh    # Linux/macOS
start.bat     # Windows
```

Current repo default: `http://127.0.0.1:3099`

---

## 5. Create a Client Token

From the dashboard (**Controls → Client Tokens**) or via API:

```sh
curl -X POST http://127.0.0.1:3099/v1/admin/tokens \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-app","project_id":"proj-001"}'
```

Use the returned `token` value as the API key for local clients.

---

## 6. Connect Your Project To The Hub (For Dummies)

Normal apps should use a client token, not the admin token.

If your app is running on the same machine as the hub, use:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
```

Choose a model alias instead of hardcoding one provider whenever possible:

- `fast-free` for cheap, quick chat.
- `strong-free` for the strongest free general model.
- `strong-code` for coding-oriented routing.
- `strong-long-context` for long context jobs.

If your app is not on the same machine:

- Use the hub machine's IP or DNS name instead of `127.0.0.1`.
- Keep `HUB_HOST=127.0.0.1` for same-machine use.
- Only change `HUB_HOST` to a reachable address when you intentionally want another machine, WSL instance, or container to connect.
- On your Windows 11 GMKtec box, `127.0.0.1` is correct when both the hub and the app are running on Windows itself.
- If the app is inside WSL, Docker, or another Linux box, use the Windows or Linux host IP that can actually reach the hub.

Yes, the Linux setup is compatible. This project already ships with `install.sh`, `start.sh`, and `stop.sh`, and the same OpenAI-compatible `/v1` endpoint works on both Windows and Linux.

### Python example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3099/v1",
    api_key="YOUR_HUB_CLIENT_TOKEN",
)

response = client.chat.completions.create(
    model="strong-free",
    messages=[
      {"role": "user", "content": "Reply with one short sentence."}
    ],
)

print(response.choices[0].message.content)
```

### Node.js example

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3099/v1',
  apiKey: process.env.HUB_CLIENT_TOKEN,
});

const response = await client.chat.completions.create({
  model: 'fast-free',
  messages: [
    { role: 'user', content: 'Reply with one short sentence.' },
  ],
});

console.log(response.choices[0].message.content);
```

### Raw HTTP example

```sh
curl -X POST http://127.0.0.1:3099/v1/chat/completions \
   -H "Authorization: Bearer YOUR_HUB_CLIENT_TOKEN" \
   -H "Content-Type: application/json" \
   -d '{"model":"fast-free","messages":[{"role":"user","content":"Reply with one short sentence."}]}'
```

---

## 7. Top 3 Free Orchestration Setups

These are the best low-friction free setups for this hub because they can already talk to OpenAI-style endpoints or can be pointed at them with minimal configuration.

### 1. n8n

Best if you want workflow automation, agents, tools, scheduled jobs, webhooks, and app-to-app glue.

- Windows 11 Pro GMKtec rig: good fit.
- Linux: good fit.
- How to connect it: use either an OpenAI-compatible node that lets you override the base URL, or a plain HTTP Request node.
- Hub settings to use:
   - Base URL: `http://127.0.0.1:3099/v1`
   - API key: your hub client token
   - Model: `fast-free`, `strong-free`, or another alias

### 2. Flowise

Best if you want visual LLM chains, agents, retrieval flows, and quick local experimentation without writing much code.

- Windows 11 Pro GMKtec rig: good fit.
- Linux: good fit.
- How to connect it: use its OpenAI-style chat/model components and point the API base to this hub.
- Hub settings to use:
   - API/Base URL: `http://127.0.0.1:3099/v1`
   - API key: your hub client token
   - Model: `strong-free` or `strong-code`

### 3. Langflow

Best if you want visual orchestration but prefer the Python ecosystem, LangChain-style components, or RAG-oriented flows.

- Windows 11 Pro GMKtec rig: good fit.
- Linux: good fit.
- How to connect it: use its OpenAI-compatible model component and override the API base.
- Hub settings to use:
   - API/Base URL: `http://127.0.0.1:3099/v1`
   - API key: your hub client token
   - Model: `strong-free`, `fast-free`, or `embeddings-strong` for embeddings flows

If you want the simplest recommendation order for this project:

1. Use `n8n` for automation-heavy orchestration.
2. Use `Flowise` for visual agent building.
3. Use `Langflow` if you want a Python-first flow builder.

---

## 8. Verify

```sh
curl http://127.0.0.1:3099/health
# {"status":"ok","timestamp":...}

curl http://127.0.0.1:3099/v1/providers \
  -H "Authorization: Bearer YOUR_TOKEN"
# Lists all providers with auth + health status
```

---

## 9. Final Verification Before Production Use

Run the full release gate before publishing, handing this off, or treating the current build as production-ready:

```sh
npm run verify
```

Then start the hub with `start.bat` or `./start.sh`. Those launchers now wait for `/health` to return `status: ok` before they report success.

---

## Full `.env` Reference

```env
# ── Server ───────────────────────────────────────────────────────────────────
HUB_HOST=127.0.0.1          # Bind address; keep 127.0.0.1 unless behind a proxy
HUB_PORT=3099
HUB_LOG_LEVEL=info          # trace | debug | info | warn | error
HUB_DATA_DIR=./data         # SQLite and state files
HUB_LOG_DIR=./logs          # startup logs, pid file, and stderr/stdout captures

# ── Security (required) ──────────────────────────────────────────────────────
HUB_SECRET_KEY=              # 32+ chars: encrypts stored API keys
HUB_ADMIN_TOKEN=             # 16+ chars: dashboard / admin API access

# ── Mode flags ───────────────────────────────────────────────────────────────
FREE_ONLY_MODE=false         # Block any paid / membership provider
LOCAL_ONLY_MODE=false        # Only route to local endpoint
PREMIUM_ENABLED=false        # Unlock Copilot / Codex lanes

# ── Local provider ───────────────────────────────────────────────────────────
LOCAL_ENABLED=true
LOCAL_BASE_URL=http://127.0.0.1:1234/v1

# ── Gemini ───────────────────────────────────────────────────────────────────
GEMINI_ENABLED=false
GEMINI_API_KEY=

# ── Groq ─────────────────────────────────────────────────────────────────────
GROQ_ENABLED=false
GROQ_API_KEY=

# ── OpenRouter ───────────────────────────────────────────────────────────────
OPENROUTER_ENABLED=false
OPENROUTER_API_KEY=
OPENROUTER_SITE_URL=http://localhost:3099
OPENROUTER_SITE_NAME=ai-access-hub

# ── Mistral ──────────────────────────────────────────────────────────────────
MISTRAL_ENABLED=false
MISTRAL_API_KEY=

# ── Cerebras ─────────────────────────────────────────────────────────────────
CEREBRAS_ENABLED=false
CEREBRAS_API_KEY=

# ── Cloudflare Workers AI ────────────────────────────────────────────────────
CLOUDFLARE_ENABLED=false
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_GATEWAY_NAME=    # optional AI Gateway slug

# ── GitHub Models ────────────────────────────────────────────────────────────
GITHUB_MODELS_ENABLED=false
GITHUB_MODELS_TOKEN=

# ── SambaNova ────────────────────────────────────────────────────────────────
SAMBANOVA_ENABLED=false
SAMBANOVA_API_KEY=

# ── Cohere ───────────────────────────────────────────────────────────────────
COHERE_ENABLED=false
COHERE_API_KEY=

# ── Fireworks ────────────────────────────────────────────────────────────────
FIREWORKS_ENABLED=false
FIREWORKS_API_KEY=

# ── GitHub Copilot (membership) ──────────────────────────────────────────────
COPILOT_ENABLED=false
# Auth is done via the dashboard; no key in .env

# ── OpenAI / Codex (premium) ─────────────────────────────────────────────────
CODEX_ENABLED=false
OPENAI_API_KEY=
CODEX_CLI_ENABLED=false
CODEX_CLI_PATH=codex
CODEX_CLI_TIMEOUT_MS=120000
```

# For Dummies Guide

This is the plain-language guide for actually using AI Access Hub as the brain behind a real app, agent runner, workflow tool, or orchestration stack.

If you only want the short version:

- Run the hub.
- Create a client token.
- Point your app at `http://127.0.0.1:3099/v1`.
- Use the client token as the API key.
- Use model aliases like `fast-free`, `strong-free`, or `strong-code`.

---

## The Connection You Actually Use

For any normal app or agent framework, the hub acts like an OpenAI-compatible API.

Use these settings:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
```

Do not use the admin token for normal app traffic.

Use a client token instead.

Good default aliases:

- `fast-free` for cheap fast chat.
- `strong-free` for the strongest free general lane.
- `strong-code` for coding-heavy tasks.
- `strong-long-context` for large-context work.
- `embeddings-strong` for embeddings.

---

## What The Dashboard Numbers Mean

When you open the hub dashboard, read the quota badge before trusting the number:

- `provider synced` means the provider reported real remaining quota.
- `hub only` means the hub is showing its own tracked headroom against the configured limit.
- `ceiling only` means the hub can show the published cap, but not true live remaining yet.

Plain English version:

- some rows are real remaining quota
- some rows are safe local headroom estimates
- some rows are just the published ceiling because the provider does not give the hub enough live usage detail

That is intentional. It is better for the dashboard to say "ceiling only" than to pretend it knows exact remaining when it does not.

---

## Same Machine Vs Another Machine

### Same machine

If the app and AI Access Hub are both running on the same Windows or Linux machine, use:

```text
http://127.0.0.1:3099/v1
```

That is the normal setup for your Windows 11 Pro GMKtec box.

### Different machine, Docker, or another Linux host

If the app is somewhere else, `127.0.0.1` points to the app machine, not the hub machine.

In that case:

- use the real IP or DNS name of the hub host
- keep the same `/v1` path
- keep using a hub client token
- only change `HUB_HOST` from `127.0.0.1` when you intentionally want remote access
- only think about WSL here if you intentionally chose to run the client there

Example:

```text
http://192.168.1.50:3099/v1
```

---

## Linux Compatibility

Yes. The hub is compatible with Linux.

The project already includes:

- `install.sh`
- `start.sh`
- `stop.sh`

The same OpenAI-compatible `/v1` endpoint works on both Windows and Linux.

---

## Top 3 Windows 11 Pro GMKtec Setups

These are the three best free setups for your Windows 11 Pro GMKtec 128 GB / 2 TB / Ryzen AI Max+ 395 box if you want real orchestration, tools, and vector-db-backed workflows.

### 1. OpenClaw + AI Access Hub + Qdrant + SearXNG

Best if you want a personal agent stack with strong orchestration, web/search augmentation, tool use, and room for RAG.

Why this is a top fit on your Windows rig:

- OpenClaw is already aligned with the kind of agent workflow you keep using
- AI Access Hub gives it one clean OpenAI-style endpoint instead of hardcoding providers
- Qdrant gives you a strong free vector store
- SearXNG gives you search without paying for a search API

Use this when you want:

- a serious daily-driver agent
- search + memory + multi-provider routing
- a setup that can grow into Telegram, browser, and tool-heavy work

Recommended stack:

- AI Access Hub on Windows host
- OpenClaw on Windows host
- Qdrant on Docker Desktop or another local machine
- SearXNG on Docker Desktop or another Linux box
- optional local runtime like LM Studio or Ollama behind the hub

Setup package status:

- first implementation is now `setup-openclaw.bat`
- it reuses an existing OpenClaw install instead of reinstalling it
- it now generates `%USERPROFILE%\.openclaw-aihub\start.bat` and `stop.bat` for the OpenClaw profile
- it prefers Docker Qdrant on Windows
- it can also adopt an existing Qdrant instance with `-QdrantMode adopt`
- SearXNG is optional and detection-only in this first pass

Telegram quick setup:

1. Create a bot with `@BotFather` and copy the token.
2. Get your Telegram numeric user ID from `@userinfobot` or `@RawDataBot`.
3. Run `openclaw.cmd --profile aihub channels add --channel telegram --token "YOUR_BOT_TOKEN"`.
4. In `C:\Users\Ian\.openclaw-aihub\openclaw.json`, set `channels.telegram.allowFrom` to your Telegram user ID.
5. Restart with `%USERPROFILE%\.openclaw-aihub\stop.bat` then `%USERPROFILE%\.openclaw-aihub\start.bat`.

Example:

```bat
setup-openclaw.bat -OpenClawBaseUrl http://127.0.0.1:3001 -StartQdrant -StartHub
```

Hook it to the hub with:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
Model:    strong-free or strong-code
```

### 2. Agent Zero + AI Access Hub + Qdrant

Best if you want aggressive autonomous orchestration and tool-driven agent work rather than just chat.

Why this is a top fit on your Windows rig:

- Agent Zero is closer to a real autonomous operator than a simple chatbot
- AI Access Hub lets you swap or combine free providers without rewriting the setup
- Qdrant gives you a free memory/retrieval backend when you want retrieval-backed flows

Use this when you want:

- deeper tool use
- autonomous step-by-step execution
- a stack that really benefits from the hub's free-provider routing and fallback

Recommended stack:

- AI Access Hub on Windows host
- Agent Zero on Windows host
- Qdrant locally
- optional browser/search tooling alongside it

If a specific Agent Zero dependency later proves to require something heavier, treat that as an exception rather than the default Windows path.

Hook it to the hub with:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
Model:    strong-free, strong-code, or fast-free
```

### 3. Flowise + AI Access Hub + Qdrant

Best if you want visual orchestration, visual chains, and RAG pipelines without writing everything by hand.

Why this is a top fit on your Windows rig:

- Flowise is easy to wire into OpenAI-style endpoints
- it is strong for visual orchestration and retrieval flows
- Qdrant integration is a natural fit
- AI Access Hub lets Flowise use free provider routing through one endpoint

Use this when you want:

- visual orchestration
- visual RAG flows
- a lower-friction builder than a fully custom agent stack

Recommended stack:

- AI Access Hub on Windows host
- Flowise on Windows host or Docker
- Qdrant locally
- optional SearXNG for search-based flows

Hook it to the hub with:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
Model:    fast-free, strong-free, or embeddings-strong
```

### Windows pick order

If you want the short recommendation order for your Windows GMKtec machine:

1. OpenClaw stack
2. Agent Zero stack
3. Flowise stack

---

## Top 3 Linux Setups

These are the three best free setups when you want the Linux side to be the more serious always-on orchestration environment.

### 1. Dify + AI Access Hub + Qdrant or pgvector + Redis

Best if you want the most complete Linux-native platform feel: workflows, agent apps, knowledge bases, and cleaner multi-user deployment.

Why this is a top fit on Linux:

- Dify is better suited to a long-running Docker-style Linux deployment than a casual Windows-only setup
- it gives you app orchestration and knowledge-base patterns out of the box
- AI Access Hub makes Dify consume your free-provider pool through one OpenAI-style endpoint

Use this when you want:

- a more platform-like deployment
- workflows + knowledge bases + agent apps
- a cleaner Linux server setup than ad hoc tool chaining

Recommended stack:

- AI Access Hub on Linux host
- Dify on Linux host
- Qdrant or pgvector for vector retrieval
- Redis for its normal supporting role in the Dify stack

Hook it to the hub with:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
Model:    strong-free or fast-free
```

### 2. Open WebUI + Pipelines + AI Access Hub + Qdrant + SearXNG

Best if you want a polished self-hosted AI workspace with UI, tools, search, retrieval, and room for local-model plus free-provider hybrid use.

Why this is a top fit on Linux:

- Linux is the cleaner place to run the Docker-heavy parts
- Open WebUI is a strong daily-driver front end
- Pipelines, Qdrant, and SearXNG let it become much more than a plain chat UI
- AI Access Hub gives it a single endpoint for routed provider access

Use this when you want:

- a polished self-hosted AI front end
- RAG plus search plus tool workflows
- one place to mix local models and routed cloud-free models

Recommended stack:

- AI Access Hub on Linux host
- Open WebUI + Pipelines
- Qdrant
- SearXNG
- optional local runtime behind the hub

Hook it to the hub with:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
Model:    strong-free, fast-free, or strong-long-context
```

### 3. n8n + AI Access Hub + Qdrant + SearXNG

Best if you want automation-first orchestration: jobs, triggers, API glue, scheduled tasks, and tool workflows.

Why this is a top fit on Linux:

- n8n is excellent for automation orchestration
- Linux is the easier long-running host for n8n plus supporting services
- AI Access Hub turns all AI calls into one OpenAI-style integration point
- Qdrant and SearXNG cover retrieval and search well without paid lock-in

Use this when you want:

- scheduled AI jobs
- webhook-driven orchestration
- app-to-app automation around AI tasks

Recommended stack:

- AI Access Hub on Linux host
- n8n on Linux host
- Qdrant
- SearXNG
- optional Postgres if you want a more serious n8n backend later

Hook it to the hub with:

```text
Base URL: http://127.0.0.1:3099/v1
API key:  YOUR_HUB_CLIENT_TOKEN
Model:    fast-free or strong-free
```

### Linux pick order

If you want the short recommendation order for Linux:

1. Dify stack
2. Open WebUI + Pipelines stack
3. n8n stack

---

## Which One Should You Actually Pick?

If you want the most direct answer:

- On your Windows GMKtec box: pick OpenClaw first.
- If you want more aggressive autonomous operator behavior on Windows: pick Agent Zero.
- If you want visual orchestration on Windows: pick Flowise.
- On Linux: pick Dify first for the strongest full-stack platform.
- If you want a polished Linux daily-driver UI: pick Open WebUI + Pipelines.
- If you want automation-first orchestration on Linux: pick n8n.

---

## Quick App Examples

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3099/v1",
    api_key="YOUR_HUB_CLIENT_TOKEN",
)

response = client.chat.completions.create(
    model="strong-free",
    messages=[
        {"role": "user", "content": "Say hello in one sentence."}
    ],
)

print(response.choices[0].message.content)
```

### Node.js

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3099/v1',
  apiKey: process.env.HUB_CLIENT_TOKEN,
});

const response = await client.chat.completions.create({
  model: 'fast-free',
  messages: [
    { role: 'user', content: 'Say hello in one sentence.' },
  ],
});

console.log(response.choices[0].message.content);
```
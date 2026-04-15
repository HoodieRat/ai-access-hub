# OpenClaw Windows Setup Package

This package is the first Windows stack implementation for the reuse-first setup flow.

What it does:

- reuses the existing AI Access Hub install when possible
- creates or merges `.env` safely from `.env.example`
- installs missing hub dependencies only when needed
- builds the hub only when `dist/index.js` is missing
- adopts an existing OpenClaw install by URL, path, or process match
- generates clean `start.bat` and `stop.bat` files for the dedicated OpenClaw profile
- generates a profile helper script that disables mDNS for the loopback-only profile, patches the service wrapper with a unique fallback hostname, and cleans up stale local gateway processes on the profile port
- supports Docker-managed Qdrant as the preferred helper-service path on Windows
- reports what it detected, what it reused, and what still needs manual wiring

What it does not do yet:

- it does not reinstall OpenClaw
- it does not rewrite arbitrary external OpenClaw config files automatically beyond the dedicated profile helper settings
- it does not manage SearXNG automatically yet

## Repair OpenClaw patches after an update

OpenClaw updates can overwrite the installed `dist` patch that improves hub backpressure handling and lane-exhaustion messages.

Reapply it with either:

```bat
npm run repair:openclaw
```

or:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup\windows\openclaw\repair-openclaw-patches.ps1
```

## Quick start

```bat
setup-openclaw.bat -StartQdrant
```

If OpenClaw is already running on a known URL:

```bat
setup-openclaw.bat -OpenClawBaseUrl http://127.0.0.1:3001 -StartQdrant -StartHub
```

If OpenClaw is installed but not listening on HTTP yet:

```bat
setup-openclaw.bat -OpenClawPath "C:\Tools\OpenClaw"
```

If you already have a Qdrant instance and want to adopt it instead of using Docker:

```bat
setup-openclaw.bat -QdrantMode adopt -QdrantBaseUrl http://127.0.0.1:6333
```

## Parameters

- `-OpenClawBaseUrl`: preferred when OpenClaw already exposes a reachable local HTTP endpoint
- `-OpenClawPath`: lets the setup report that an existing install path was adopted
- `-OpenClawProcessPattern`: wildcard process match used when OpenClaw is already running
- `-OpenClawProfileName`: profile name for the generated OpenClaw convenience files. Default: `aihub`
- `-QdrantMode docker|adopt`: Docker is the default for Windows helper services
- `-QdrantBaseUrl`: base URL for Qdrant detection and reporting
- `-SearXngBaseUrl`: optional existing SearXNG endpoint to adopt later
- `-StartHub`: starts AI Access Hub if it is not already healthy
- `-StartQdrant`: starts the bundled Docker Qdrant service when Docker mode is active

## Generated convenience files

By default, the setup package now creates:

- `%USERPROFILE%\.openclaw-aihub\profile-tools.ps1`
- `%USERPROFILE%\.openclaw-aihub\start.bat`
- `%USERPROFILE%\.openclaw-aihub\stop.bat`

Those files are meant to be the easy Windows entry points for the dedicated OpenClaw profile.

For the dedicated loopback-only `aihub` profile, setup also forces:

- `discovery.mdns.mode: "off"` in `%USERPROFILE%\.openclaw-aihub\openclaw.json`
- `OPENCLAW_MDNS_HOSTNAME=openclaw-aihub` in `%USERPROFILE%\.openclaw-aihub\gateway.cmd`

That combination prevents recurring Bonjour naming conflicts while still leaving a unique fallback hostname in place if you re-enable mDNS later.

## Workspace write policy

The recommended default profile keeps OpenClaw sandboxed to its workspace.

- generated files should land under `%USERPROFILE%\.openclaw-aihub\workspace`
- a shell command like `mkdir C:\target` can succeed while a `write` tool call to `C:\target\file.txt` still fails
- that is expected when `tools.fs.workspaceOnly=true`
- if you need artifacts somewhere else, generate them in the workspace first and then copy or move them deliberately

This keeps the profile safer and makes file-write behavior predictable.

## Stability defaults

For tool-heavy local use, prefer these OpenClaw defaults in `C:\Users\Ian\.openclaw-aihub\openclaw.json`:

- `agents.defaults.contextTokens: 40000`
- `agents.defaults.compaction.reserveTokensFloor: 20000`
- `agents.defaults.llm.idleTimeoutSeconds: 300`

Those settings reduce mid-task context resets on long generations or multi-step coding runs.

## Telegram quick setup

If you want to talk to OpenClaw from Telegram, use this order:

1. Create a Telegram bot with `@BotFather`.
	 Send `/newbot`, pick a bot name, pick a bot username, and copy the bot token.
2. Get your own Telegram numeric user ID.
	 The easy path is to message `@userinfobot` or `@RawDataBot` and copy your numeric ID.
3. Add the bot to the dedicated OpenClaw profile:

```powershell
openclaw.cmd --profile aihub channels add --channel telegram --token "YOUR_BOT_TOKEN"
```

4. Open `C:\Users\Ian\.openclaw-aihub\openclaw.json` and make sure the Telegram block contains your user ID:

```json
"channels": {
	"telegram": {
		"enabled": true,
		"dmPolicy": "pairing",
		"allowFrom": [
			"YOUR_TELEGRAM_USER_ID"
		]
	}
}
```

5. Restart OpenClaw with the generated convenience files:

```bat
C:\Users\Ian\.openclaw-aihub\stop.bat
C:\Users\Ian\.openclaw-aihub\start.bat
```

6. Verify Telegram is connected:

```powershell
openclaw.cmd --profile aihub channels status --probe
```

7. In Telegram, open your bot chat, press **Start**, and send a short test message like `hi`.

## Result

After a successful run, wire OpenClaw to:

- Base URL: `http://127.0.0.1:<HUB_PORT>/v1`
- API key: a hub client token
- Model aliases: `strong-code`, `strong-free`, `fast-free`

# Commands

Canonical command reference for this repo. The checked-in `.env` currently binds the hub to `http://127.0.0.1:3099`.

---

## Windows

### Install, start, stop

```bat
install.bat
start.bat
stop.bat
```

### Windows stack packages

```bat
setup-openclaw.bat
npm.cmd run setup:openclaw
```

Use `setup-openclaw.bat` as the default Windows entry point. In a PowerShell session, prefer `npm.cmd` over `npm` if you want the npm script path.

OpenClaw package examples:

```bat
setup-openclaw.bat -StartQdrant
setup-openclaw.bat -OpenClawBaseUrl http://127.0.0.1:3001 -StartQdrant -StartHub
setup-openclaw.bat -QdrantMode adopt -QdrantBaseUrl http://127.0.0.1:6333
```

### Tail logs

```powershell
Get-Content .\logs\hub.out.log -Tail 100
Get-Content .\logs\hub.err.log -Tail 100
Get-Content .\logs\hub.out.log -Wait
```

### Quick API checks

```powershell
Invoke-RestMethod http://127.0.0.1:3099/health

$headers = @{ Authorization = 'Bearer YOUR_ADMIN_TOKEN' }
Invoke-RestMethod http://127.0.0.1:3099/v1/providers -Headers $headers
Invoke-RestMethod http://127.0.0.1:3099/v1/admin/doctor -Headers $headers
Invoke-RestMethod http://127.0.0.1:3099/v1/admin/cache -Headers $headers
```

### Admin actions

```powershell
$headers = @{ Authorization = 'Bearer YOUR_ADMIN_TOKEN'; 'Content-Type' = 'application/json' }

Invoke-RestMethod http://127.0.0.1:3099/v1/admin/test-provider -Method Post -Headers $headers -Body '{"provider_id":"groq"}'
Invoke-RestMethod http://127.0.0.1:3099/v1/admin/reset-provider -Method Post -Headers $headers -Body '{"provider_id":"groq"}'
Invoke-RestMethod http://127.0.0.1:3099/v1/admin/shutdown -Method Post -Headers $headers -Body '{}'
```

### Hermes AFK runner (opt-in)

```powershell
.\run-hermes-rpg-afk.ps1
.\run-hermes-rpg-afk.ps1 -Preset caveman
npm run hermes:afk:rpg
npm run hermes:afk:caveman
npm run hermes:afk:recover
npm run hermes:afk -- --prompt-file .\your-prompt.txt --auto-continue --max-continues 12 --done-marker YOUR_DONE_MARKER
```

---

## Linux / macOS

### Install, start, stop

```sh
chmod +x install.sh start.sh stop.sh
./install.sh
./start.sh
./stop.sh
```

### Tail logs

```sh
tail -n 100 logs/hub.out.log
tail -n 100 logs/hub.err.log
tail -f logs/hub.out.log
```

### Quick API checks

```sh
curl http://127.0.0.1:3099/health

curl http://127.0.0.1:3099/v1/providers \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

curl http://127.0.0.1:3099/v1/admin/doctor \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Admin actions

```sh
curl -X POST http://127.0.0.1:3099/v1/admin/test-provider \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider_id":"groq"}'

curl -X POST http://127.0.0.1:3099/v1/admin/reset-provider \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider_id":"groq"}'

curl -X POST http://127.0.0.1:3099/v1/admin/shutdown \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Hermes AFK runner (opt-in)

```sh
bash ./run-hermes-rpg-afk.sh
bash ./run-hermes-rpg-afk.sh rpg-master-prompt.txt 12 hermes-caveman-afk.log caveman
npm run hermes:afk:rpg
npm run hermes:afk:caveman
npm run hermes:afk:recover
npm run hermes:afk -- --prompt-file ./your-prompt.txt --auto-continue --max-continues 12 --done-marker YOUR_DONE_MARKER
```

---

## npm Scripts

```sh
npm run build
npm run dev
npm test
npm run verify
npm run typecheck
npm run doctor
npm run doctor -- --json
npm run hermes:afk
npm run hermes:afk:rpg
npm run hermes:afk:caveman
npm run hermes:afk:recover
npm run clean
npm run setup:openclaw
```

`npm run hermes:afk:caveman` enables conservative failure detection and one-shot recovery prompting for brittle game-generation runs.

`npm run doctor` prints a human-readable diagnostics report. Add `-- --json` to emit machine-readable JSON.
`npm test` runs the automated regression suites. `npm run verify` is the full release gate: typecheck, build, then tests.

---

## Release Gate

Before publishing or handing this off for production use:

```sh
npm run verify
```

Then start the hub with `start.bat` or `./start.sh`. Those launchers now report success only after `/health` returns `status: ok`.

---

## Useful URLs

```text
Dashboard: http://127.0.0.1:3099/dashboard
Health:    http://127.0.0.1:3099/health
API Base:  http://127.0.0.1:3099/v1
```
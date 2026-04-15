# Release Scope Separation

This note keeps the current working tree split into two release scopes so the routing and dashboard hardening work does not get mixed with the unrelated Windows OpenClaw setup flow.

## Scope A: Routing, Failover, And Dashboard

Use this scope for the resilient routing pass, quota visibility updates, route preview, and dashboard template cleanup.

Files in this scope now:

- `src/adapters/base.ts`
- `src/adapters/cerebras.ts`
- `src/adapters/cloudflare.ts`
- `src/adapters/cohere.ts`
- `src/adapters/copilot.ts`
- `src/adapters/fireworks.ts`
- `src/adapters/github-models.ts`
- `src/adapters/local.ts`
- `src/adapters/mistral.ts`
- `src/adapters/openrouter.ts`
- `src/adapters/sambanova.ts`
- `src/db.ts`
- `src/doctor.ts`
- `src/health.ts`
- `src/limits.ts`
- `src/modes.ts`
- `src/router.ts`
- `src/routes/admin.ts`
- `src/routes/chat.ts`
- `src/routes/dashboard.ts`
- `src/routes/rerank.ts`
- `src/types.ts`
- `tests/dashboard.spec.ts`
- `tests/quota.spec.ts`

Verification expected for this scope:

1. `npm run build`
2. `npx playwright test tests/quota.spec.ts`
3. `npx playwright test tests/dashboard.spec.ts`

Release intent for this scope:

- model-scoped versus provider-scoped health and cooldown behavior
- normal versus strict route broadening
- stronger execution preflight
- richer route-preview diagnostics
- quota wording cleanup and dashboard placeholder normalization
- dashboard template deduplication and shell cleanup

## Scope B: Windows OpenClaw Setup, Launcher, And Docs

Keep this scope separate from the routing/dashboard release. These edits are about Windows stack packaging, launcher supervision, and setup documentation rather than failover behavior.

Files in this scope now:

- `.gitignore`
- `COMMANDS.md`
- `FOR-DUMMIES.md`
- `README.md`
- `SETUP.md`
- `package.json`
- `scripts/start.ps1`
- `scripts/stop.ps1`
- `scripts/hub-supervisor.ps1`
- `setup-openclaw.bat`
- `setup/windows/openclaw/README.md`
- `setup/windows/openclaw/docker-compose.yml`
- `setup/windows/openclaw/setup-openclaw.ps1`
- `setup/windows/openclaw/stack.json`
- `setup/windows/shared/Setup.Common.psm1`
- `setup/windows/shared/detect.ps1`
- `setup/windows/shared/env-merge.ps1`
- `setup/windows/shared/health.ps1`
- `setup/windows/shared/preflight.ps1`
- `setup/windows/shared/report.ps1`
- `setup/windows/shared/stack-schema.json`

Verification expected for this scope:

1. `powershell -NoProfile -ExecutionPolicy Bypass -File .\setup\windows\shared\preflight.ps1`
2. `npm run build`
3. `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1`
4. `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1`
5. `npm run setup:openclaw -- -AsJson`

Release intent for this scope:

- reuse-first OpenClaw setup on Windows
- helper-service detection and Docker Qdrant support
- launcher supervision and stop-file behavior
- setup documentation and operator guidance

## Coordination Files

These files are coordination artifacts rather than product scope by themselves:

- `todo.md`
- `16-release-scope-separation.md`

Treat them as release-prep notes. Keep them with the matching scope if you want the audit trail in git, or leave them out of the user-facing release commit if you want the shipped diff to stay narrower.

# TODO

Live checklist for the current stability and usability pass.

- [x] Add a canonical `COMMANDS.md` and keep the main docs pointed at it.
- [x] Centralize provider status derivation in the registry.
- [x] Persist failure types and recovery timing in provider health state.
- [x] Add shared doctor diagnostics for both CLI and HTTP endpoints.
- [x] Update the dashboard and provider API views to use the richer status data.
- [x] Run a full build and fix any regressions.

## Codex CLI Integration

- [x] Add a dual-mode Codex adapter that prefers the local logged-in Codex CLI when no OpenAI API key is configured.
- [x] Expose Codex CLI env/config knobs and keep the existing API-key path intact.
- [x] Document the ChatGPT-login Codex setup path and example env settings.
- [x] Validate build, provider status, and a real Codex CLI-backed completion.

## Dashboard Stabilization

- [x] Phase 0: Add and maintain explicit stabilization checklist items in this file during implementation.
- [x] Phase 1: Fix dashboard page loading so every page either renders data or a clear locked/error state.
- [x] Phase 1: Move read-only dashboard data to public `/dashboard/api/*` endpoints and keep write/admin operations protected.
- [x] Phase 2: Reduce repeated dashboard/server work with bounded registry caches for model and provider status reads.
- [x] Phase 3: Parallelize startup initialization and bound slow-provider impact.
- [x] Phase 4: Keep a visible Windows terminal open with live logs while the server runs.
- [x] Phase 5: Add automated dashboard page-load regression coverage.
- [x] Phase 6: Verify build, startup, page navigation, and provider-traffic behavior end to end.

## Provider Repair And Dashboard Convenience

- [x] Diagnose the live provider failures for Cloudflare, GitHub Models, and Fireworks from the running hub instance.
- [x] Auto-authorize the local dashboard from the `.env` admin token so localStorage setup is no longer required for normal localhost use.
- [x] Open the dashboard automatically when `start.bat` launches the hub.
- [x] Improve provider diagnostics or messages where the current errors are too vague to fix quickly.
- [x] Add a simple troubleshooting guide for Cloudflare, GitHub Models, Fireworks, and OpenRouter latency expectations.
- [x] Update dashboard regression coverage for the new automatic admin flow.
- [x] Verify build, dashboard behavior, startup flow, and live provider health after the changes.

## Quota Accuracy And Free Usage Visibility Redesign

- [x] Audit the current quota tracking model, provider confidence levels, and dashboard free-usage presentation.
- [x] Determine the accuracy policy for quota display: exact remaining, hub-only headroom, estimated remaining, and unknown.
- [x] Determine the target dashboard setup for Overview, Usage, and Warnings so all services stay visible.
- [x] Write the implementation plan for the quota-accuracy redesign.
- [x] Phase 0: Replace any copy that implies a bottleneck window is the total available free budget.
- [x] Phase 0: Make every displayed quota explicitly name its unit and window, such as requests/day, requests/minute, tokens/day, month, or provider-native units.
- [x] Phase 1: Refactor quota state into a normalized model that supports metric kind, window kind, evidence confidence, usage coverage, reset policy, and freshness.
- [x] Phase 1: Extend quota tracking to support monthly windows and provider-specific units where the provider exposes them.
- [x] Phase 1: Expose richer quota APIs for dashboard use without hiding observed, inferred, or unknown services.
- [x] Phase 2: Add provider-specific quota enrichment, including rate-limit headers and any provider usage or quota endpoints that can improve true remaining accuracy.
- [x] Phase 2: Distinguish per-provider lanes and shared pools correctly, including cases like free, premium, membership, and provider-native usage pools.
- [x] Phase 3: Redesign the Overview free-usage area into an all-services board instead of a lane spotlight.
- [x] Phase 3: Redesign the Usage page into a per-service, per-window matrix with filters for requests, tokens, monthly windows, provider-native units, and confidence.
- [x] Phase 3: Keep official, observed, inferred, and unknown services visible with explicit evidence and usage-scope badges instead of hiding them.
- [x] Phase 4: Update warnings and downgrade approval flows to show remaining same-tier services, lower-tier services, and unknown or estimated services clearly.
- [x] Phase 4: Update route scoring and fallback logic to use quota confidence and coverage without presenting that score as if it were quota.
- [x] Phase 5: Add tests for quota-state APIs, display wording, provider visibility, warning behavior, and no-silent-downgrade flows.
- [x] Phase 5: Verify displayed headroom against provider consoles or provider-reported quota headers wherever true remaining can be checked.

## Project Finish And Production Release

- [x] Add the final finish-the-project checklist items in this file and keep the scope limited to dashboard polish, release stability, and production publication.
- [x] Remove hardcoded hub version strings so the dashboard, health endpoint, and startup logs all report the package version from one place.
- [x] Make launch readiness wait for `GET /health` returning `status: ok` instead of treating an open port as fully ready.
- [x] Make server startup await `listen` cleanly so bind failures surface as real startup errors instead of callback-only exits.
- [x] Add one canonical release verification command and document the production launch and verification path without expanding the product scope.
- [x] Verify typecheck, build, automated tests, and launcher-based health readiness end to end.

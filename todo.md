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

## Resilient Failover And Dashboard Cleanup

Implementation plan for the current routing-hardening pass:

- Keep strict routing available when explicitly requested, but make the default `stability_level=normal` path broaden safely before it hard-fails.
- Split health and cooldown decisions between provider-wide failures and model-specific failures so one bad model or 429 does not poison the entire provider.
- Prefer execution-aware health for routes that matter in practice, starting with Cohere chat compatibility instead of a loosely related status endpoint.
- Reject impossible candidates earlier with stronger preflight checks so the router spends hops on viable fallbacks instead of predictable failures.
- Clean up dashboard mojibake and stale placeholder rendering so the operator can trust what the UI is showing during failures.
- Add regression coverage for fallback broadening, per-model health isolation, provider-aware preflight, and dashboard output.

- [x] Phase 0: Keep this section updated while the resilient failover pass is being implemented.
- [x] Phase 1: Fix dashboard character encoding and placeholder rendering so the live UI stops showing garbled text.
- [x] Phase 1: Extend persisted health state to support provider-wide and model-specific cooldown, circuit, quarantine, and last-failure data.
- [x] Phase 1: Update routing availability checks and failure recording so model-local failures stop short of disabling unrelated models on the same provider.
- [x] Phase 2: Add lane-aware health checks, starting with Cohere chat compatibility, so "healthy" means the real route is usable.
- [x] Phase 2: Strengthen preflight for request size, output size, tool support, and provider/model quota ceilings before execution attempts.
- [x] Phase 3: Use `stability_level=normal` to broaden from exact alias pools into compatible same-class fallbacks before returning no-candidate or exhausted errors.
- [x] Phase 3: Preserve `stability_level=strict` as the exact-alias behavior for callers that want no broadening.
- [x] Phase 3: Broaden `strong-code` failover toward tool-capable strong chat models and local strong routes when exact code aliases are unavailable.
- [x] Phase 4: Expose richer route-failure and fallback diagnostics in logs and admin/dashboard surfaces where the data is missing or unclear.
- [x] Phase 4: Add or update tests for model-level failover isolation, normal-versus-strict routing, preflight rejection, Cohere health behavior, and dashboard text cleanup.
- [x] Phase 5: Rebuild and run targeted verification for quota logic, dashboard behavior, and resilient fallback behavior end to end.

## Dashboard Template Refactor And Release Scope Separation

Implementation plan for the cleanup and release-prep follow-up:

- Remove duplicated dashboard source fragments from the generated HTML and keep one canonical dashboard shell plus one runtime client-script copy.
- Preserve the current route-preview, quota, doctor, and token surfaces while making dashboard.ts safer to edit and less likely to drift between runtime and non-runtime copies.
- Review the unrelated OpenClaw/setup/launcher/doc changes as a separate release scope so routing/dashboard hardening does not get mixed into the same commit or release by accident.

- [x] Phase 0: Add and maintain this cleanup and release-separation checklist before implementation changes.
- [x] Phase 1: Restore one canonical dashboard HTML shell so the served page no longer leaks duplicate nav, controls cards, or source text.
- [x] Phase 1: Keep only one runtime copy of the route-preview and dashboard client helpers inside dashboard.ts.
- [x] Phase 1: Normalize placeholder strings and dashboard text to plain ASCII while preserving current behavior.
- [x] Phase 2: Add a release-scope note that separates failover/dashboard files from unrelated OpenClaw/setup/launcher/doc changes.
- [x] Phase 2: Record the current changed-file groupings and verification expectations for each scope so commit and release prep can split them cleanly.
- [x] Phase 3: Verify the served dashboard structure, build, and targeted dashboard and failover tests after the refactor.

## External Provider Routing Optimization

Implementation plan for enabling external AI provider routing through the hub (GitHub Models, Codex, Mistral, Groq, Gemini, Cerebras, CloudFlare, OpenRouter, SambaNova, Cohere).

### Phase 0: Adapter Health Check Audit

- [ ] Review all adapter implementations in `src/adapters/` to audit existing `healthCheck()` and `isAuthenticated()` methods
- [ ] Document which providers have built-in availability checks vs. reactive-only failure detection
- [ ] Identify adapters missing health-check implementations
- [ ] Check if Codex adapter is discovering CLI models via `codex.cmd --list-models`
- [ ] Verify blank OPENAI_API_KEY handling in OpenAI adapter initialization
- [ ] Document current preflight validation capabilities for each adapter
- [ ] Update adapter registry to properly initialize and report adapter readiness status

### Phase 1: Explicit Model Availability Pre-Check (Preflight)

- [ ] Create new `getProviderModelAvailability()` method in `src/router.ts`
- [ ] Implement micro health checks for Codex CLI: probe CLI responsiveness with timeout
- [ ] Implement GitHub Models token verification: check token validity and quota
- [ ] Implement endpoint reachability checks: verify external API endpoints are responsive
- [ ] Update `buildCandidates()` to call preflight checks before adding models to candidate pool
- [ ] Skip unavailable models from scoring rather than discovering failures reactively
- [ ] Add preflight timeout configuration (default 2000ms) to `.env`
- [ ] Test preflight logic with each external provider disabled to verify graceful skip
- [ ] Verify that preflight skipping does not break fallback chain logic

### Phase 2: External Provider Preference/Bias Flag

- [ ] Extend `RouteRequest` type in `src/types.ts` to include `prefer_external?: boolean` and `exclude_local_on_alias?: string[]`
- [ ] Update REST API documentation for new request fields
- [ ] Implement scoring boost logic in `scoreCandidate()`: +0.2 for external providers when `prefer_external=true`
- [ ] Implement scoring penalty logic in `scoreCandidate()`: -0.15 for local provider when `prefer_external=true`
- [ ] Add `exclude_local_on_alias` filtering logic to prevent local selection for specified aliases
- [ ] Update dashboard route preview (`/v1/admin/force-route`) to accept and display bias flags
- [ ] Test with multiple external providers to verify boost is effective
- [ ] Test with local fallback to verify system still falls back when external unavailable

### Phase 3: Codex CLI Model Registry Integration

- [ ] Update Codex adapter initialization to probe `codex.cmd --list-models` on startup
- [ ] Parse Codex CLI output and register discovered models with proper alias tags
- [ ] Map Codex models to `strong-code` and `strong-free` aliases based on capability
- [ ] Add error handling for CLI probe failures (CLI not installed, permission issues, timeout)
- [ ] Store model discovery results in adapter registry for use in `buildCandidates()`
- [ ] Verify model registration persists across router requests
- [ ] Test Codex model discovery with `codex-free`, `codex-pro`, and similar model names
- [ ] Ensure blank OPENAI_API_KEY does not prevent CLI discovery from working

### Phase 4: Handle Blank OpenAI API Key

- [ ] Review OpenAI adapter initialization in `src/adapters/openai.ts` (or equivalent)
- [ ] Add early check: if OPENAI_API_KEY is blank, call `isAuthenticated()` returning false
- [ ] Update adapter registry to filter out unauthenticated OpenAI adapter from candidates
- [ ] Verify that blank OpenAI key does not cause hub crashes or silent routing failures
- [ ] Test route scoring with OPENAI_API_KEY blank to verify it is skipped entirely
- [ ] Document in `.env` that blank OPENAI_API_KEY disables OpenAI-based routing

### Phase 5: Make Fallback Chain Explicit

- [ ] Define `PROVIDER_FALLBACK_ORDER` in `.env` configuration (e.g., `github-models,codex,mistral,groq,gemini,local`)
- [ ] Extend `RouteRequest` type to include `explicit_provider_order?: string[]` for per-request override
- [ ] Implement cascade logic in `buildCandidates()`: sort candidates by fallback priority before scoring
- [ ] Update retry logic in `src/routes/chat.ts`: when provider returns 429, automatically try next provider in order
- [ ] Add request-level override so callers can specify custom `explicit_provider_order`
- [ ] Implement per-request fallback tracking to log which providers were tried and why each was skipped
- [ ] Test 429 recovery: make request to exhausted provider, verify automatic fallback to next provider
- [ ] Test explicit provider order override: request with custom order should satisfy override
- [ ] Verify fallback chain respects availability pre-checks (skip unavailable providers even in fallback)

### Phase 6: Integration and Build Validation

- [ ] Run `npm run build` to verify no TypeScript errors
- [ ] Run `npm run typecheck` to validate all new types and interfaces
- [ ] Create integration tests for each fix:
  - [ ] Preflight availability check with one provider unavailable
  - [ ] External preference boost with multiple external providers
  - [ ] Codex CLI model discovery and selection
  - [ ] Blank OpenAI key handling
  - [ ] Fallback chain 429 recovery
- [ ] Test smoke game generation 10 times with `prefer_external=true`
- [ ] Verify external provider distribution in request logs
- [ ] Verify fallback to local provider works when external unavailable
- [ ] Run full test suite to ensure no regressions

### Phase 7: Documentation and Dashboard Updates

- [ ] Update API documentation for new `prefer_external` and `exclude_local_on_alias` fields
- [ ] Update dashboard route preview help text to explain bias and fallback behavior
- [ ] Document new `PROVIDER_FALLBACK_ORDER` config option with examples
- [ ] Add troubleshooting guide for external provider routing failures
- [ ] Document preflight timeout configuration and when to adjust it
- [ ] Update examples showing how to prefer external providers programmatically
- [ ] Add section to README about external provider setup and configuration

### Phase 8: Verification and Production Release

- [ ] Run 20 game generation requests with varying flags and external provider preferences
- [ ] Verify external provider usage percentage in request logs
- [ ] Confirm no silent failures or degradation when external provider is exhausted
- [ ] Verify all fallback paths work correctly (429s, 401s, timeouts, unavailable)
- [ ] Test with one external provider disabled to verify graceful degradation
- [ ] Confirm dashboard shows proper provider distribution in live requests
- [ ] Verify request logs capture provider selection, fallback attempts, and reasons
- [ ] Final build and deployment verification

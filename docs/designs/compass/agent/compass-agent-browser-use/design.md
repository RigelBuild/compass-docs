# Compass agent browser use

Use OMP browser automation when no suitable vendor API exists. This design adds restricted browser tools, brokered secret input and capture, and explicit controls for browser state and egress.

**Grounding.** OMP `browserSchema` (`packages/coding-agent/src/tools/browser.ts`) exposes browser through Eval, not a model tool. `BrowserTabHelpers` (`packages/coding-agent/src/tools/browser/declarations.d.ts`) accepts literal `fill(selector, value)`, `value(selector)`, and `evaluate(...)`; `tab.run` has “full Bun/Node + tool-bridge access. It is not sandboxed.” (`packages/coding-agent/src/prompts/tools/browser.md`). `cfgBrowserEnabled` (`packages/coding-agent/src/tools/browser/settings.ts`) defaults true; `sharedBrowserProfileDir` (`packages/coding-agent/src/tools/browser/shared-daemon.ts`) reuses a stable profile. `obfuscateTextBlocks` (`packages/coding-agent/src/secrets/message-transform.ts`) passes image blocks through.

Compass `WorkloadTier` (`go/internal/runtime/tier.go`) names `podman`, `microvm`, `apple-container`, and `host`. `EgressPolicy.NftScript` (`go/internal/runtime/egress.go`) allows hosts without port limits; `UnenforceableEgressPolicyError` (`go/internal/runtime/agent.go`) says host-tier egress is unenforced. `main` (`packages/compass-agent/src/cli.ts`) passes `customTools` and an optional `settingsManager` to `createAgentSession`; `agent-image/toolchain.nix` does not list Chromium. Build on DL-358 (Runner boundary), DL-545 (Runner egress), DL-311 (tenant RLS), DL-360/DL-361/DL-370 (secret scopes), DL-326 (checkout volume), and DL-089/DL-093 (transcripts), not browser profile persistence.

GitHub's *Registering a GitHub App from a manifest* documents callback and conversion credentials. Linear's *OAuth application manifests* documents a prefilled app form; *Webhooks* documents `webhookCreate`. Linear registration API, generated-secret fields, and stable selectors remain [UNVERIFIED]. B6 in `docs/designs/compass/infra/ci/compass-pr-validation/design.md` recommends image-baked Chromium for visual capture, not interactive profiles or secret handling.

Tracker: RIG-6007.

## Open Questions

This design uses the recommendations below. Matt's ruling is required on each load-bearing question before the record freezes.

1. **Read-back lifetime** (load-bearing). (a) Taint the browser session until teardown: blocks secret readback and post-login inspection. (b) Restore readback after a verified top-level document change while blocking cookies, storage, `run`, and `evaluate`: permits navigation but requires denying SPA/history/BFCache and old-document access. **Recommendation:** (a); reviewed workflows handle post-login actions.

2. **Profile ownership and lifetime** (load-bearing). (a) Share one tenant profile: persistent login, cross-agent cookie exposure. (b) Per-agent account profile: avoids sharing and repeated login, but retains cookies and needs durable storage, expiry, and revocation. (c) One profile per Compass agent session: isolates cookies but requires login and perhaps human 2FA each session. **Recommendation:** (c), private `$HOME/.compass/browser-profile`, deleted at session teardown. Assume one session spans the workflow; no cross-session persistence. Claim encryption only with encrypted ephemeral backing.

3. **2FA and human handoff** (load-bearing). (a) Brokered TOTP and push yes/no approval; reject SMS codes, passkeys, and hardware keys. (b) Add trusted same-context input for SMS/passkey/hardware keys; supports more providers but needs secure input and display. (c) Let the model see codes or a headed browser; exposes credentials. **Recommendation:** (a). Compass ask is not a secret-entry channel. Keep the browser headless to the model.

4. **Browser driver ownership** (load-bearing). (a) Restricted OMP fork API: reuses lifecycle but adds fork maintenance; current OMP export is a full Eval prelude, not a restricted driver. (b) Compass-owned Puppeteer: avoids the fork but duplicates lifecycle and compatibility; Compass already accepts custom tools/settings. Both must disable `browser.enabled` and isolate CDP objects from model code. **Recommendation:** (a).

5. **Audit sink and retention** (load-bearing). (a) Tenant-RLS append-only `browser_audit_events`, pruned after 90 days: clear events and bounded retention, but needs migration/pruner. (b) `agent_activity`: no new table, but mutable status, not an event log. (c) General logs or indefinite retention: more history, broader exposure. **Recommendation:** (a), redacted metadata only. `UsageEventRetention` is 90 days for usage events, not browser policy; choose 90 days explicitly.

## Problem / Intent

Agents need a browser when no suitable vendor API exists. Current operator work includes the GitHub App manifest flow and Linear OAuth app setup. Prefer documented APIs where they cover the operation: GitHub's manifest conversion endpoint captures generated credentials, and Linear's `webhookCreate` mutation creates a webhook. Use browser automation for vendor login, confirmation, OAuth-app registration where no API exists, and other UI-only steps.

OMP has no browser-specific secret hook: `fill` takes a literal value, while `run`/`evaluate` and `value` can read it back. Its project-shared profile persists across launches. Generic text redaction does not cover screenshots because image blocks pass through. Compass must replace that path for brokered use, not rely on redaction.

## Approach

This proposal designs against the Open Questions recommendations. The load-bearing recommendations need Matt's ruling before the record freezes.

### Restricted browser surface and secret flow

Add a restricted browser API through an OMP fork. Allow bounded navigation, clicks, and observations before secret use. Inject `browser.enabled: false` so the OMP Eval prelude is absent. After taint, expose no `run`, `evaluate`, page values, cookies, storage, HAR, requests, console, downloads, clipboard, or screenshots. Keep CDP/browser objects private from model-executable JavaScript.

`browser_fill_secret(context_id, document_id, grant_id, selector)` reads the main-frame origin from CDP and redeems through the broker. Recheck target, frame, document, and origin before CDP input; discard the value if any changed. IDs bind to runtime-owned CDP target, frame, and loader generation.

Taint before secret input or generated-credential workflow through agent-session teardown, including navigation and context replacement. Return generic status only. Use reviewed runtime workflows for post-login actions.

### Generated credentials and motivating workflows

Treat generated credentials as secrets. A runtime-only capture path accepts a grant, ref, workflow, and approved origin; it stores directly through the broker and returns status only. The model cannot request arbitrary capture or choose credential selectors. A reviewed trusted adapter owns secret-bearing page actions so the model needs no post-taint readback.

For GitHub App registration, use the documented manifest flow. The trusted runtime owns a one-time `state`, validates the callback origin and state, and sends the temporary conversion code to `POST /app-manifests/{code}/conversions` within GitHub's one-hour window. Store returned `pem`, `client_secret`, and `webhook_secret` in their granted secret refs through the broker capture path. The browser workflow's trusted adapter submits the preconfigured manifest and handles confirmation without model-visible results. Do not return the temporary code or credentials to the model.

For Linear, use the documented OAuth-app manifest to prefill the creation form. A trusted runtime workflow handles the secret-bearing steps and captures any generated credential through fixed, reviewed selectors on an approved Linear origin. Store values through the broker and fail closed if the expected document or field changes. The UI selectors and availability of generated secrets remain [UNVERIFIED]. Use the documented `webhookCreate` mutation when an authorized Linear API grant is available; browser use covers login and UI-only confirmation, not a substitute API call.

### Security boundary and guarantees

The agreed forthcoming RIG-6006 broker contract uses `SecretRef(scope, name)` and grants containing `grant_id`, ref, agent principal, purpose, mode, expiry, and uses. A `browser_fill` use carries a user-approved origin allowlist. The broker validates origin; it never trusts an agent-supplied origin alone. The runtime redeems over the agent-token channel and receives the value once with an audit row. Add a generated-secret capture use bound to a granted ref and workflow. RIG-6006 is not merged yet; its record path is forthcoming and remains plain text: docs/designs/compass/server/compass-secret-broker/design.md.

Compass guarantees that brokered and generated values do not enter model input, model-visible tool output, transcripts, screenshots, or Compass/OMP logs. Tainted browser APIs cannot read page data back. This does not hide values from the destination site, page scripts, browser process, compromised runtime, or trusted capture adapter. A malicious approved site can use or exfiltrate a value; the firewall cannot restrict paths or application behavior on an allowed host.

Before secret use, untainted observations may enter model context. After taint, disable all page-data APIs and image output until close; use a separate context for non-secret work. OMP text redaction is not a boundary: its transform passes image blocks through.

### Profile, runtime, and egress

Use one Chromium process and profile per browser session in the agent's private `$HOME/.compass/browser-profile`. Delete it at agent-session teardown, including abnormal exit; never reuse cookies across sessions or mount the profile on the checkout volume. This assumes each browser-enabled agent session spans its workflow. Use encrypted ephemeral backing where supported; otherwise make no at-rest encryption claim. DL-326's checkout volume and DL-089/DL-093 transcript persistence do not define browser-cookie persistence. A persistent per-agent profile would need durable encrypted storage, revocation, and expiry.

Run Chromium inside the workload and bake a pinned binary into the agent image; do not download it at first use. Pass a fixed executable path and test binary/driver compatibility. Enable `podman` and `microvm`; enable `apple-container` only after verifying isolation and firewall support. Reject brokered fill on `host` because its egress is unenforced. Avoid remote per-tenant CDP for brokered fill because it moves the browser-control boundary.

The Runner tier firewall is the egress boundary for every workload process. Operators approve login origins and required redirects and add their hosts to Runner policy; a grant origin list does not create network access. OMP `allowed_domains` is advisory because `tab.run` has host runtime and tool-bridge access. Current `AllowEgress`/`NftScript` allow an approved destination on any port. Before enabling browser use, permit approved browser hosts only on TCP 443 and keep DNS limited to the configured resolver on port 53. Require an armed firewall and fail closed on unverified tiers. Apple-container firewall support is [UNVERIFIED].

### 2FA and headed interaction

Add TOTP as a broker secret kind. The trusted runtime generates the time-based code and types it through the bound fill path; the model never receives the secret or code. A push challenge may pause for a human yes/no response through Compass ask. Ask must deliver only that approval to the trusted runtime; it must not send challenge data or codes through ordinary model-visible chat. SMS code entry, passkeys, and hardware keys are unsupported until a trusted same-context handoff exists. Do not open a headed browser for the model. Any future human-only headed view needs separate authorization in the same context and must not expose screenshots or controls to the model.

### Audit

Record each broker redemption and generated-secret capture with tenant, agent, session, grant, operation, approved origin host, timestamp, and outcome; never values. Append `browser_audit_events` for open, navigation, fill, capture, submit, denial, and close under DL-311 tenant RLS. Exclude selectors, URL paths/queries, page text, form values, cookies, headers/bodies, HAR, and screenshots.

Choose an append-only table with 90-day pruning. `agent_activity` in `go/internal/store/migrations/0001_init.sql` is one mutable status row per agent, not an event log. `StoreResolver.ResolveFor` in `go/internal/secrets/store_resolver.go` says DB resolution has “no provider audit log to record it in.” `UsageEventRetention` in `go/server/serve.go` is 90 days for raw usage events; browser retention is a new policy.

## Alternatives considered

### Browser driver, redaction, and profiles

Reject OMP's full Eval prelude: `run` and `value` permit readback, and redaction misses page-derived data and image blocks. A Compass-owned Puppeteer driver avoids a fork but duplicates lifecycle and compatibility; the restricted OMP fork surface is preferred. Shared tenant profiles cross agent boundaries; persistent per-agent profiles need durable encryption, expiry, and revocation. Remote CDP moves browser control outside workload egress.

## Global Constraints

- Use documented APIs first; browser automation is fallback-only.
- Bind fills to runtime context/document. Read origin from CDP, redeem the grant, then recheck origin and frame before CDP input.
- Enforce egress at the tier firewall. Browser hosts use TCP 443 only; DNS is resolver-only. OMP `allowed_domains` is advisory; require an armed firewall.
- Profiles are private per-session, outside checkout, deleted at teardown. Claim encryption only where provided. Bake pinned Chromium into the image; disable runtime downloads and do not bake credentials.
- Keep brokered/generated values out of model input/results, transcripts, screenshots, logs, and diagnostics. Taint the browser session through teardown and disable all readback.

## Plan

Sequence: T1 broker contract, with T3 image/profile work in parallel; T2 depends on both. T4 gates tier enablement. T5 and T6 follow broker/runtime support. T7 tests the integrated system.

### T1 — Brokered browser fill and generated-secret capture

**Lane:** compass Go server/runner.

**Interfaces:** `SecretRef(scope, name)`; grant `{grant_id, ref, agent_principal, purpose, mode: once|session|standing, expires_at, uses[]}`; use `{consumer_kind, binding}`; browser-fill use also has `{origin_allowlist}`. `Redeem(grant_id, use, origin) -> value_once`; `CaptureGenerated(grant_id, use, origin, value) -> audit_row`. Broker checks CDP-read origin. Coordinate with forthcoming docs/designs/compass/server/compass-secret-broker/design.md.

**Test cycle:** Enforce principal, use, origin, expiry, one-use grants, value-free audit, and grant-bound capture.

### T2 — Restricted browser runtime and vendor workflows

**Lane:** compass-agent TS and OMP fork change; depends on T1 and T3.

**Interfaces:** `browser_open(url) -> {context_id, document_id}`; `browser_goto(context_id, url) -> document_id`; `browser_click(context_id, document_id, selector) -> status`; `browser_observe(context_id, document_id) -> summary` only before taint; `browser_fill_secret(context_id, document_id, grant_id, selector) -> status`. Runtime-only `Redeem(grant_id, use, origin) -> value_once`. `browser_capture_vendor_credentials(context_id, document_id, grant_id, workflow: "github_app" | "linear_oauth_app") -> status`; runtime-only `CaptureGenerated(grant_id, use, origin, value)`. No model-supplied capture selector/value. Inject `browser.enabled: false`; bind ids to CDP state. All tools return status only after taint, which lasts to agent-session teardown.

**Test cycle:** No model tool exposes `run`, `evaluate`, `value`, screenshot, HAR, or generated response. Race document/origin change against redemption; verify no input, GitHub capture, and fail-closed Linear capture on selector change.

### T3 — Per-session profile and pinned browser binary

**Lane:** agent-image nix and compass Go runner; independent of T1.

**Interfaces:** Put private profile at `$HOME/.compass/browser-profile`, remove on agent-session teardown. Bake pinned Chromium in `agent-image/toolchain.nix`; pass fixed executable path. Never mount profile on checkout.

**Test cycle:** Verify session isolation, teardown deletion, browser/driver compatibility, and no runtime download.

### T4 — Workload-wide HTTPS egress for browser hosts

**Lane:** compass Go server/runner; depends on approved-origin handling in T1.

**Interfaces:** `AllowBrowserHTTPS(hosts ...string) (EgressPolicy, error)` adds approved hosts on TCP 443 only. Runner consumes validated hostnames; DNS remains resolver-only on 53. Mirror hosts to advisory `allowed_domains`; require armed firewall and reject `host`/unverified tiers.

**Test cycle:** Verify HTTPS on TCP 443 to an approved host succeeds; another port and an unapproved host fail. Verify resolver DNS works, the firewall applies to the workload, and `host` or an unarmed tier cannot redeem a browser-fill grant.

### T5 — Tenant-scoped browser audit events

**Lane:** compass Go server/runner; depends on T1.

**Interfaces:** Append `BrowserAuditEvent{tenant_id, agent_id, session_id, grant_id, origin_host, action, outcome, occurred_at}` to tenant-RLS table `browser_audit_events`; prune daily after 90 days.

**Test cycle:** Verify tenant isolation, redacted fields, append-only writes, and expiry: old rows are removed while recent rows remain.

### T6 — TOTP and supported human handoff

**Lane:** compass Go server/runner and compass-agent TS; depends on T1 and T2.

**Interfaces:** `TotpSecretKind`; runtime-only `generateAndFillTotp(context_id, document_id, grant_id, selector) -> status`; Compass ask returns push yes/no only to trusted runtime. Reject SMS, passkeys, and hardware keys without exposing challenge data.

**Test cycle:** Verify code generation and input stay out of model results and logs, push approval returns only yes/no to the trusted runtime, and unsupported challenges fail closed without chat leakage.

### T7 — Cross-tier browser security and workflow tests

**Lane:** compass-agent TS and compass Go server/runner; depends on T2–T6.

**Interfaces:** Exercise browser, broker, Runner, and fake vendor endpoints end to end. Check secret values and post-taint page data are absent from model results, transcripts, screenshots, logs, and audit. Test origin races, session-wide taint, unsupported tiers, broker-only capture, and profile cleanup. Test GitHub and Linear workflows separately.

**Test cycle:** Run the security matrix on each enabled tier; verify host/unarmed tiers reject fill and taint/readback assertions hold through navigation and agent-session teardown.

## Tasks

- [ ] T1 — Add origin-bound browser fill and workflow-bound generated-secret capture to the RIG-6006 broker contract; test principal, origin, use, expiry, and value-free audit.
- [ ] T2 — Add the restricted OMP driver and Compass tools; disable `browser.enabled` and implement GitHub/Linear workflows; test taint, race rejection, and capture.
- [ ] T3 — Bake pinned Chromium into the agent image and create isolated per-session profiles with teardown cleanup; test binary match, isolation, and deletion.
- [ ] T4 — Add TCP 443-only Runner egress for approved browser hosts and resolver-only DNS; test allowed HTTPS and denied hosts/ports.
- [ ] T5 — Add tenant-RLS append-only audit events with 90-day pruning; test redaction, isolation, append-only behavior, and expiry.
- [ ] T6 — Add brokered TOTP and push-only yes/no handoff; test protected code flow and fail-closed unsupported challenges.
- [ ] T7 — Test GitHub and Linear workflows across enabled tiers, including readback, audit, and profile teardown.

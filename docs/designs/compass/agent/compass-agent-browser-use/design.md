# Compass agent browser use

Use the browser only when no suitable vendor API exists. Broker secret fill and capture behind a restricted, isolated browser runtime.

**Grounding.** OMP `browserSchema` (`packages/coding-agent/src/tools/browser.ts`) exposes browser through Eval, not a model tool. `BrowserTabHelpers` (`packages/coding-agent/src/tools/browser/declarations.d.ts`) takes literal `fill` values and exposes `value`/`evaluate`. `tab.run` has “full Bun/Node + tool-bridge access. It is not sandboxed” (`packages/coding-agent/src/prompts/tools/browser.md`). `cfgBrowserEnabled` defaults true (`packages/coding-agent/src/tools/browser/settings.ts`); `sharedBrowserProfileDir` reuses a stable profile (`packages/coding-agent/src/tools/browser/shared-daemon.ts`); `obfuscateTextBlocks` passes image blocks through (`packages/coding-agent/src/secrets/message-transform.ts`).

Compass tiers are `podman`, `microvm`, `apple-container`, `host` (`WorkloadTier`, `go/internal/runtime/tier.go`). `EgressPolicy.NftScript` lacks port limits (`go/internal/runtime/egress.go`); host-tier egress is unenforced (`UnenforceableEgressPolicyError`, `go/internal/runtime/agent.go`). Compass `main` passes optional `settingsManager` and `customTools` without overriding OMP defaults (`packages/compass-agent/src/cli.ts`). Chromium is not listed in `agent-image/toolchain.nix`.

Build on DL-358, DL-545, DL-311, DL-360/DL-361/DL-370, DL-326, DL-089/DL-093, and B6 in `docs/designs/compass/infra/ci/compass-pr-validation/design.md`. B6 covers visual capture, not interactive browser security. GitHub documents App manifest conversion. Linear documents OAuth manifests and `webhookCreate`; registration API, generated-secret fields, and selectors remain [UNVERIFIED].

Tracker: RIG-6007.

## Open Questions

This design uses the recommendations below. All questions are load-bearing; Matt's ruling is required before the record freezes. Rewrite DL-640 to match Matt's rulings before merge; its current line is not a ruling on these recommendations.

1. **Read-back lifetime** (load-bearing). (a) Taint the whole agent session until teardown; no post-login inspection. (b) Restore readback after top-level navigation; must also block SPA/history/BFCache and old documents. **Recommendation:** (a); reviewed workflows handle post-login actions.

2. **Profile ownership and lifetime** (load-bearing). (a) Shared tenant profile: persistent login, cross-agent cookie exposure. (b) Persistent per-agent account: fewer logins, but needs encrypted storage, expiry, revocation. (c) Profile per agent session: isolates cookies, but may need login and 2FA each session. **Recommendation:** (c), `/run/compass/browser/<agent-session>/profile`, mode 0700, owned by browser UID, deleted at teardown.

3. **2FA and human handoff** (load-bearing). (a) Brokered TOTP and trusted push approval; reject SMS, passkeys, and hardware keys. (b) Add trusted same-context input for these factors. (c) Show codes or headed browser to model. **Recommendation:** (a), including GitHub's two-digit match number to a trusted human prompt; model sees neither challenge nor answer.

4. **Browser driver ownership** (load-bearing). (a) Restricted OMP fork API reuses lifecycle but adds maintenance. (b) Compass-owned Puppeteer avoids the fork but duplicates lifecycle and compatibility. **Recommendation:** (a); either option disables OMP's full Eval prelude.

5. **Audit sink and retention** (load-bearing). (a) Tenant-RLS append-only `browser_audit_events`, prune at 90 days. (b) `agent_activity` is mutable, not an event log. (c) General logs or indefinite retention expose more data. **Recommendation:** (a), redacted metadata. `UsageEventRetention` is not browser policy.

6. **Boundary from model process tools** (load-bearing). (a) Separate UID/sandbox for Chromium, CDP, broker client; pipe CDP and authenticate the broker socket. (b) Disable bash, Eval, Python, and process tools in browser sessions; limits code work. (c) Dedicated browser workload per login; strongest isolation but splits workflows. **Recommendation:** (a), because fallback must coexist with code work.

## Problem / Intent

Agents need browser access when no suitable vendor API exists. Current manual work includes GitHub App manifest registration and Linear OAuth setup. Prefer GitHub manifest conversion and Linear `webhookCreate` when they fit; use browser login, confirmation, registration, and UI-only steps as fallback.

OMP has no secret hook: `fill` takes a literal value; `run`, `evaluate`, and `value` can read it back. Its shared profile persists across launches, and text redaction misses images. Compass needs a restricted browser path.

## Approach

This proposal uses the Open Questions recommendations. Matt must rule on them before the record freezes.

### Restricted browser surface and secret flow

Use a restricted OMP fork. Disable the full Eval browser prelude. Set `browser.enabled: false` in code after fleet settings. This unconditional override must survive missing or malformed settings.

Run Chromium, CDP driver, and broker client under a dedicated browser UID/sandbox. Model tools cannot read its files or broker socket. Do not expose TCP CDP. Keep CDP on a private pipe, never inherited by shell, Eval, or Python. Expose bounded browser actions only.

`browser_fill_secret(context_id, document_id, grant_id, selector)` reads main-frame origin from CDP. Runtime reports it to broker; broker checks the grant allowlist. Origin integrity depends on the isolated runtime. Recheck target, frame, document, and origin before typing. Discard value if any changed. IDs identify runtime-owned target, frame, and loader generation.

Taint the whole agent session before first secret fill or capture. Keep taint through teardown; navigation and new contexts do not clear it. Return generic status only. Trusted workflows handle post-login steps.

### Generated credentials and motivating workflows

Trusted runtime adapters own secret-bearing actions and capture. They store generated credentials through the broker and return status only. Model cannot choose capture selectors or values.

For GitHub App registration, use manifest flow. Runtime owns one-time `state`, validates callback origin/state, then sends conversion code to `POST /app-manifests/{code}/conversions` within one hour. Store returned `pem`, `client_secret`, and `webhook_secret` in granted refs. Trusted adapter submits manifest and confirms; model sees no code or credentials.

For Linear, use OAuth manifest to prefill form. Adapter captures credentials through fixed selectors on approved origin; fail closed if document/field changes. Selectors and generated-secret fields are [UNVERIFIED]. Use `webhookCreate` when an authorized API grant exists; browser handles login and UI-only confirmation.

### Security boundary and guarantees

RIG-6006 defines `SecretRef(scope, name)` and grants with agent principal, purpose, mode, expiry, and uses. Browser-fill use includes an approved origin allowlist. The runtime reports CDP origin; broker checks it against that allowlist. The broker has no independent page view. Origin integrity depends on browser UID/sandbox. Runtime redeems over the agent-token channel and gets the value once with an audit row. Generated capture binds to a granted ref and workflow. RIG-6006 is not merged; record path: docs/designs/compass/server/compass-secret-broker/design.md.

Brokered values stay out of model input/results, transcripts, screenshots, logs, and diagnostics. The separate browser UID protects the profile and broker client from model process tools. Tainted APIs return no page data after fill. These guarantees depend on UID/sandbox and authenticated broker socket.

Values remain visible to the destination site, page scripts, browser process, trusted adapter, and compromised runtime. An approved malicious site can use or exfiltrate them. Firewall cannot limit paths or application behavior on allowed hosts.

Before taint, observations may enter model context. Taint blocks page data and images until agent-session teardown. Text redaction is not a boundary; OMP passes image blocks through.

Use one Chromium process and profile per agent session at `/run/compass/browser/<agent-session>/profile`. The browser UID owns mode 0700 files. Delete the profile at teardown, including abnormal exit. Do not reuse cookies or mount the profile on checkout. Use encrypted backing only when provided. DL-326, DL-089, and DL-093 do not define browser persistence.

The Runner tier firewall is the egress boundary. Operators approve login origins and redirects and add their hosts to Runner policy. Grants do not create network access. OMP `allowed_domains` is advisory because `tab.run` has host access. Permit approved browser hosts on TCP 443 only and resolver DNS on port 53. Fail closed on unarmed, unverified, or host tiers. Apple-container firewall support is [UNVERIFIED].

### 2FA and headed interaction

Add TOTP as a broker secret kind. Trusted runtime generates and types codes; model sees neither. For GitHub Mobile, send the non-credential two-digit match number to the human through trusted Compass ask. Return only yes/no and number selection to runtime. Do not send them through model chat. SMS, passkeys, and hardware keys remain unsupported until trusted input exists. Do not show headed browser to model; any human view needs separate authorization and no model-visible screenshots or controls.

### Audit

Record broker redemptions and generated-secret captures with tenant, agent, session, grant, operation, approved origin host, timestamp, and outcome. Never log values. Store append-only `browser_audit_events` under DL-311 tenant RLS. Log browser actions and denials. Exclude selectors, URL paths/queries, page text, form values, cookies, headers/bodies, HAR, and screenshots.

Prune daily after 90 days. `agent_activity` (`go/internal/store/migrations/0001_init.sql`) is mutable, not an event log. `StoreResolver.ResolveFor` (`go/internal/secrets/store_resolver.go`) says DB resolution has “no provider audit log.” `UsageEventRetention` (`go/server/serve.go`) is not browser policy.

## Alternatives considered

### Browser driver and profiles

OMP's full Eval allows readback, and text redaction misses page data and images. A Compass-owned Puppeteer driver avoids a fork but duplicates lifecycle and compatibility. Shared tenant profiles expose cookies across agents; per-agent profiles require durable encryption, expiry, and revocation. Remote CDP moves control outside workload egress.

## Global Constraints

- Use documented APIs first; browser automation is fallback-only.
- Run Chromium, CDP, and broker client under a separate browser UID/sandbox. Model tools cannot read its profile or broker socket.
- Disable OMP's browser Eval prelude unconditionally in code after fleet settings. Do not depend on the optional fleet overlay.
- Taint the whole agent session before first secret fill or credential capture; keep it tainted through teardown and context changes.
- Broker checks the runtime-reported CDP origin against the grant allowlist. Origin integrity depends on the separate runtime boundary.
- Enforce egress at the tier firewall. Allow browser hosts on TCP 443 only and resolver DNS on port 53. OMP `allowed_domains` is advisory. Require an armed firewall.
- Store private per-session profiles at `/run/compass/browser/<agent-session>/profile`, mode 0700, owned by the browser UID, outside checkout and model-readable paths. Delete at teardown. Bake pinned Chromium into the image; disable runtime downloads.
- Keep secret values out of model input/results, transcripts, screenshots, logs, and diagnostics. Do not claim protection against destination sites, browser/runtime compromise, or unsafe allowed-host behavior.

## Plan

Sequence: T1 and T3 can start in parallel. T8 uses T3's browser UID and profile path. T2 depends on T1, T3, and T8. T4 gates tier enablement. T5 and T6 follow broker/runtime support. T7 tests the integrated system.

### T1 — Brokered browser fill and generated-secret capture

**Lane:** compass Go server/runner.

**Interfaces:** `SecretRef(scope, name)`; grant `{grant_id, ref, agent_principal, purpose, mode: once|session|standing, expires_at, uses[]}`; use `{consumer_kind, binding}`; browser-fill use adds `{origin_allowlist}`. `Redeem(grant_id, use, runtime_reported_origin) -> value_once`; `CaptureGenerated(grant_id, use, runtime_reported_origin, value) -> audit_row`. Broker checks the reported origin against the grant allowlist. Its integrity depends on the isolated runtime boundary. Coordinate with forthcoming docs/designs/compass/server/compass-secret-broker/design.md.

**Test cycle:** Enforce principal, use, origin allowlist, expiry, once grants, value-free audit, and grant-bound capture.

### T3 — Per-session profile and pinned browser binary

**Lane:** agent-image nix and compass Go runner; independent of T1.

**Interfaces:** Create a dedicated browser UID. Create `/run/compass/browser/<agent-session>/profile`, owned by that UID with mode 0700; delete at session teardown. Bake pinned Chromium into `agent-image/toolchain.nix`; pass its fixed path to the isolated driver.

**Test cycle:** Verify model UID cannot read profile. Verify sessions do not share state, teardown removes profile, browser matches driver, and no runtime download occurs.

### T8 — Isolated browser runtime boundary

**Lane:** compass Go server/runner; depends on T3.

**Interfaces:** Run the browser controller and broker client as the dedicated UID created by T3. Keep CDP on a private pipe. Expose an authenticated broker socket only to that UID.

**Test cycle:** Run bash, Eval, Python, and process-spawning tools as the model UID. Verify none can open the broker socket or CDP pipe.

### T2 — Restricted browser runtime and vendor workflows

**Lane:** compass-agent TS and OMP fork; depends on T1, T3, and T8.

**Interfaces:** Model tools: `browser_open(url) -> context_id`; `browser_goto(context_id, url) -> document_id`; `browser_click(context_id, document_id, selector) -> status`; `browser_observe(context_id, document_id) -> summary` only before taint; `browser_fill_secret(context_id, document_id, grant_id, selector) -> status`; `browser_capture_vendor_credentials(context_id, document_id, grant_id, workflow) -> status`. Runtime-only: `Redeem(grant_id, use, reported_origin)` and `CaptureGenerated(grant_id, use, reported_origin, value)`. No model-supplied capture selector or value. Enforce `browser.enabled: false` after fleet settings in code, not `buildFleetSettings`.

**Test cycle:** With fleet settings absent, confirm the Eval browser prelude is disabled. Repeat with malformed settings.

Verify model tools cannot read profile files or connect to the broker socket. Confirm no `run`, `evaluate`, `value`, screenshot, HAR, or page-data output is exposed.

Race navigation against redemption; confirm fill is rejected. Confirm GitHub manifest conversion succeeds and credentials reach only broker capture. Change the Linear selector; confirm capture fails closed. Confirm taint persists through new tabs and contexts until session teardown.

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

**Interfaces:** `TotpSecretKind`; runtime-only `generateAndFillTotp(context_id, document_id, grant_id, selector) -> status`. Trusted prompt: `RequestPushApproval(agent_session_id, vendor, displayed_match_number?) -> {approved, selected_match_number?}`. Deliver the non-credential GitHub two-digit number to the human only. Send the answer directly to trusted runtime, not model chat. Reject SMS, passkeys, and hardware keys without trusted input.

**Test cycle:** Verify TOTP stays out of model results/logs. Verify human sees the GitHub number and only the selected yes/no result reaches trusted runtime. Reject unsupported challenges without chat leakage.

### T7 — Cross-tier browser security and workflow tests

**Lane:** compass-agent TS and compass Go server/runner; depends on T2–T6.

**Interfaces:** `FakeGitHubManifestServer` exposes manifest submission and conversion endpoints. `FakeLinearAppForm` serves registration and generated-secret fields. `RunBrowserSecurityMatrix(tier WorkloadTier, h Harness) error` runs each enabled tier with these fakes, broker, and Runner firewall.

**Test cycle:** Assert secrets and tainted page data are absent from model results, transcripts, screenshots, logs, and audit. Test origin races, process/profile/socket isolation, session taint, unsupported tiers, capture, and cleanup. Run GitHub and Linear separately on each enabled tier.

## Tasks

- [ ] T1 — Add origin-bound browser fill and workflow-bound generated-secret capture to the RIG-6006 broker contract; test principal, origin, use, expiry, and value-free audit.
- [ ] T3 — Bake pinned Chromium into the agent image and create isolated per-agent-session profiles with teardown cleanup; test binary match, isolation, and deletion.
- [ ] T8 — Isolate browser UID/sandbox, private CDP pipe, and authenticated broker socket; test profile and socket denial from model-process tools.
- [ ] T2 — Add the restricted OMP driver and Compass tools; disable `browser.enabled` and implement GitHub/Linear workflows; test taint, race rejection, and capture.
- [ ] T4 — Add TCP 443-only Runner egress for approved browser hosts and resolver-only DNS; test allowed HTTPS and denied hosts/ports.
- [ ] T5 — Add tenant-RLS append-only audit events with 90-day pruning; test redaction, isolation, append-only behavior, and expiry.
- [ ] T6 — Add brokered TOTP and trusted push approval including GitHub number matching; test protected code flow and unsupported factors.
- [ ] T7 — Test browser security and vendor workflows across enabled tiers; verify isolation, readback, audit, and teardown.

# Compass agent browser use

Use the browser only when no suitable vendor API exists. Keep secret fill and capture inside a restricted browser runtime.

**Grounding.** OMP `browserSchema` (`packages/coding-agent/src/tools/browser.ts`) exposes browser through Eval, not a model tool. `BrowserTabHelpers` (`packages/coding-agent/src/tools/browser/declarations.d.ts`) takes literal `fill` values and exposes `value`/`evaluate`. `tab.run` has “full Bun/Node + tool-bridge access. It is not sandboxed” (`packages/coding-agent/src/prompts/tools/browser.md`). `cfgBrowserEnabled` defaults true (`packages/coding-agent/src/tools/browser/settings.ts`); `sharedBrowserProfileDir` reuses a stable profile (`packages/coding-agent/src/tools/browser/shared-daemon.ts`); `obfuscateTextBlocks` passes image blocks through (`packages/coding-agent/src/secrets/message-transform.ts`).

Compass tiers are `podman`, `microvm`, `apple-container`, `host` (`WorkloadTier`, `go/internal/runtime/tier.go`). `EgressPolicy.NftScript` lacks port limits (`go/internal/runtime/egress.go`); host-tier egress is unenforced (`UnenforceableEgressPolicyError`, `go/internal/runtime/agent.go`). Compass `main` passes optional `settingsManager` and `customTools` without overriding OMP defaults (`packages/compass-agent/src/cli.ts`). Chromium is not listed in `agent-image/toolchain.nix`.

Build on DL-358, DL-545, DL-311, DL-360/DL-361/DL-370, DL-326, DL-089/DL-093, and B6 in `docs/designs/compass/infra/ci/compass-pr-validation/design.md`. B6 covers visual capture, not interactive browser security. GitHub documents App manifest conversion. Linear documents OAuth manifests and `webhookCreate`; registration API, generated-secret fields, and selectors remain [UNVERIFIED].

Tracker: RIG-6007.

## Open Questions

This design uses the recommendations below. All six questions are load-bearing; Matt's ruling is required before the record freezes. Rewrite DL-640 to match Matt's rulings before merge. The Runner launches the controller as the browser UID; the controller enforces agent-session taint and document bindings.

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

The Runner launches the controller per agent session as the browser UID on every enabled tier. The controller is the restricted OMP-fork TypeScript runtime. Runner/Go owns its launch and the browser-UID-only broker socket. The controller owns Chromium, the private CDP pipe, profile, broker credential, context/document bindings, and taint state. Model tools call it over a session-scoped Unix RPC socket. The controller enforces bounded actions and never exposes its broker credential or CDP pipe to the model UID.

`browser_login(context_id, document_id, {username_grant, password_grant, totp_grant?}) -> status` invokes the controller's trusted `RunLogin` workflow. The controller verifies the grant origin and credential fields, fills username/password, submits the login form, handles TOTP if requested, then taints the whole agent session. The controller returns status only. It does not expose secret values to model tools.

The controller taints the whole agent session after login or generated-credential capture. Taint lasts until teardown; navigation and new contexts do not clear it. After taint, the controller refuses model-initiated navigation, clicks, and fills. Only reviewed trusted workflows may act.

The controller fills only credential fields on a document whose origin matches the grant. By default, the target must be `input[type=password]` or have an allowed credential `autocomplete` value: `current-password`, `one-time-code`, or `username` for the username slot. Vendor workflows may instead use a selector fixed by the grant. The model cannot choose arbitrary non-credential targets.

### Generated credentials and motivating workflows

The controller owns secret-bearing actions and generated-credential capture. It stores captured credentials through the broker and returns status only. The model cannot choose capture selectors or values.

For GitHub App registration, use the manifest flow. The controller owns one-time `state` and validates the callback origin and state. It sends the conversion code to `POST /app-manifests/{code}/conversions` within one hour, then stores the returned `pem`, `client_secret`, and `webhook_secret` in granted refs. The controller submits the manifest and confirms. The model sees no code or credentials.

For Linear, use the OAuth manifest to prefill the form. The controller captures credentials through fixed selectors on the approved origin and fails closed if the document or field changes. The selectors and generated-secret fields are [UNVERIFIED]. Use `webhookCreate` when an authorized API grant exists. The browser handles login and UI-only confirmation.

### Security boundary and guarantees

RIG-6006 defines `SecretRef(scope, name)` and grants with an agent principal, purpose, mode, expiry, and uses. The browser-fill use includes an approved origin allowlist. The controller reads the origin from CDP and reports it to the broker. The broker checks it against the allowlist but has no independent view of the page. Origin integrity depends on the isolated controller. The controller calls `Redeem` and `CaptureGenerated` only through a browser-UID-only broker socket. Its credential is never written to a model-readable path. No Redeem API is available on `/run/compass/agent.sock` or another model-UID path. RIG-6006 is not merged; its design path is forthcoming: docs/designs/compass/server/compass-secret-broker/design.md.

The model does not receive brokered values in tool results, transcripts, screenshots, logs, or diagnostics. The controller fills only credential fields or grant-fixed workflow selectors. After taint, it refuses model-initiated navigation, clicks, and fills, so the model cannot publish a filled value through a page action. The separate browser UID protects the profile, controller, and broker credential from model process tools. These guarantees depend on UID/sandbox isolation and the browser-UID-only broker socket.

The destination site, its page scripts, the browser process, the trusted controller, and a compromised runtime can still see values. An approved malicious site can use or exfiltrate them. The firewall cannot limit paths or application behavior on an allowed host.

Before taint, observations may enter model context. After taint, the controller blocks page data and images until agent-session teardown. Text redaction is not a security boundary; OMP passes image blocks through.

Use one Chromium process and profile per agent session at `/run/compass/browser/<agent-session>/profile`. The browser UID owns the mode 0700 files. Delete the profile at teardown, including after an abnormal exit. Do not reuse cookies or mount the profile on the checkout. Use encrypted backing only when it is provided. DL-326, DL-089, and DL-093 do not define browser persistence.

The Runner tier firewall is the egress boundary. Operators approve login origins and redirects, then add their hosts to Runner policy. Grants do not create network access. OMP `allowed_domains` is advisory because `tab.run` has host access. Permit approved browser hosts on TCP 443 only, and permit DNS only to the resolver on port 53. Fail closed on unarmed, unverified, or host tiers. Apple-container firewall support is [UNVERIFIED].

### 2FA and headed interaction

Add TOTP as a broker secret kind. The controller redeems the TOTP seed, generates the code, and types it. The model sees neither the seed nor code. For GitHub Mobile, send the non-credential two-digit match number to the human through the trusted Compass ask flow. The Server sends the human's yes/no answer and number selection to the controller over the browser-UID-only channel, never through model chat. SMS, passkeys, and hardware keys remain unsupported until trusted input exists. Do not show the headed browser to the model. Any human view needs separate authorization and must expose no screenshots or controls to the model.

### Audit

Record broker redemptions and generated-secret captures with tenant, agent, session, grant, operation, approved origin host, timestamp, and outcome. Never log values. Store events in append-only `browser_audit_events` under DL-311 tenant RLS. Log browser actions and denials. Exclude selectors, URL paths and queries, page text, form values, cookies, headers and bodies, HAR, and screenshots.

Prune rows daily after 90 days. `agent_activity` (`go/internal/store/migrations/0001_init.sql`) is mutable, not an event log. `StoreResolver.ResolveFor` (`go/internal/secrets/store_resolver.go`) says DB resolution has “no provider audit log.” `UsageEventRetention` (`go/server/serve.go`) is not browser policy.

## Alternatives considered

### Browser driver and profiles

OMP's full Eval allows readback, and text redaction misses page data and images. A Compass-owned Puppeteer driver avoids a fork but duplicates lifecycle and compatibility. Shared tenant profiles expose cookies across agents; per-agent profiles require durable encryption, expiry, and revocation. Remote CDP moves control outside workload egress.

## Global Constraints

- Use documented APIs first. Treat browser automation as fallback-only.
- Run Chromium, CDP, and the broker client under a separate browser UID and sandbox. Do not let model tools read the profile or broker socket.
- Disable OMP's browser Eval prelude unconditionally in code after fleet settings. Do not depend on the optional fleet overlay.
- Require the controller to fill only password inputs or approved credential `autocomplete` fields. Allow a grant-fixed selector only for a vendor workflow.
- After taint, refuse model-initiated navigation, clicks, and fills; only reviewed trusted workflows may act until teardown.
- Require the Runner to launch the controller as the browser UID on every enabled tier. Keep the model-tool RPC on a session-scoped socket and the broker RPC on a separate browser-UID-only socket. Enforce taint and document bindings in the controller.
- Require the controller to redeem TOTP seeds and generate and type codes. Send push-approval answers from the Server to the controller over the browser-UID-only channel.
- Require the broker to check the origin reported by CDP against the grant allowlist. Origin integrity depends on the separate runtime boundary.
- Enforce egress at the tier firewall. Allow browser hosts on TCP 443 only and DNS only to the resolver on port 53. Treat OMP `allowed_domains` as advisory. Require an armed firewall.
- Store private per-session profiles at `/run/compass/browser/<agent-session>/profile`, mode 0700, owned by the browser UID, outside checkout and model-readable paths. Delete them at teardown. Bake pinned Chromium into the image and disable runtime downloads.
- Keep secret values out of model input and results, transcripts, screenshots, logs, and diagnostics. Do not claim protection against destination sites, browser/runtime compromise, or unsafe allowed-host behavior.

## Plan

Sequence: T1 and T3 can start in parallel. T8 depends on T1 and T3 and owns login and vendor workflows. T2 depends on T8. T4 gates tier enablement. T5 and T6 follow broker/runtime support. T7 tests the integrated system.

### T1 — Brokered browser fill and generated-secret capture

**Lane:** compass Go server/runner.

**Interfaces:** `SecretRef(scope, name)`; grant `{grant_id, ref, agent_principal, purpose, mode: once|session|standing, expires_at, uses[]}`; use `{consumer_kind, binding}`; browser-fill use adds `{origin_allowlist}`. `Redeem(grant_id, use, runtime_reported_origin) -> value_once`; `CaptureGenerated(grant_id, use, runtime_reported_origin, value) -> audit_row`. Expose both only through a browser-UID-only broker socket. Never write its credential to a model-readable path. Do not expose a Redeem endpoint through `/run/compass/agent.sock` or another model-UID channel. The broker checks reported origin against the grant allowlist; origin integrity depends on the isolated controller. Coordinate with forthcoming docs/designs/compass/server/compass-secret-broker/design.md.

**Test cycle:** Enforce principal, use, origin allowlist, expiry, once grants, value-free audit, and grant-bound capture. Verify model-UID processes cannot redeem through the agent socket.

### T3 — Per-session profile and pinned browser binary

**Lane:** agent-image nix and compass Go runner; independent of T1.

**Interfaces:** The Runner creates a dedicated browser UID and the directory `/run/compass/browser/<agent-session>/profile`. It sets the directory owner to that UID and permissions to 0700. It deletes the directory at session teardown. Bake pinned Chromium into `agent-image/toolchain.nix` and pass its fixed path to the isolated controller.

**Test cycle:** Verify the model UID cannot read the profile. Verify that sessions do not share state and that teardown removes the profile. Verify that the browser binary matches the driver and that no runtime download occurs.

### T8 — OMP-fork controller and trusted workflows

**Lane:** OMP-fork TypeScript controller. The Runner/Go layer owns launch and the broker socket. This task depends on T1 and T3.

**Interfaces:** The Runner launches the controller per agent session as the browser UID on every enabled tier. The controller RPC is `BrowserOpen(url) -> {context_id, document_id}`, `BrowserGoto(context_id, url) -> document_id`, `BrowserClick(context_id, document_id, selector) -> status`, `BrowserObserve(context_id, document_id) -> summary|status`, `RunLogin(context_id, document_id, {username_grant, password_grant, totp_grant?}) -> status`, and `BrowserCaptureVendorCredentials(context_id, document_id, grant_id, workflow) -> status`. The controller owns Chromium, CDP, the profile, broker credential, context/document binding, and taint. Model tools call it over a session-scoped Unix socket. The broker socket is browser-UID-only. Taint follows successful login or credential capture. Only reviewed trusted workflows may act after taint. The controller implements GitHub App manifest conversion and Linear OAuth app capture.

**Test cycle:** Verify the model UID cannot access the broker socket, credential, profile, or CDP pipe, or redeem through `/run/compass/agent.sock` or another path. Test multi-field username/password login, submit, optional TOTP, then session taint. Reject non-credential fill targets. After taint, refuse model-initiated clicks and navigation; confirm trusted workflows return status only.

### T2 — Compass browser tool proxy

**Lane:** compass-agent TS; depends on T8.

**Interfaces:** Model tools proxy controller RPC: `browser_open(url) -> {context_id, document_id}`; `browser_goto(context_id, url) -> document_id`; `browser_click(context_id, document_id, selector) -> status`; `browser_observe(context_id, document_id) -> summary|status`; `browser_login(context_id, document_id, {username_grant, password_grant, totp_grant?}) -> status`; `browser_capture_vendor_credentials(context_id, document_id, grant_id, workflow: "github_app" | "linear_oauth_app") -> status`. Do not expose model-selected secret selectors or literal values. Disable `browser.enabled` after fleet settings in code, not in `buildFleetSettings`.

**Test cycle:** With fleet settings absent and malformed, confirm the Eval browser prelude is disabled. Confirm model tools cannot read profile files, connect to the broker socket, or expose `run`, `evaluate`, `value`, screenshot, HAR, or page-data output. Verify proxy calls carry context/document IDs and controller status only.

### T4 — Workload-wide HTTPS egress for browser hosts

**Lane:** compass Go server/runner; depends on approved-origin handling in T1.

**Interfaces:** `AllowBrowserHTTPS(hosts ...string) (EgressPolicy, error)` adds approved hosts on TCP 443 only. Runner consumes validated hostnames; DNS remains resolver-only on 53. Mirror hosts to advisory `allowed_domains`; require armed firewall and reject `host`/unverified tiers.

**Test cycle:** Verify HTTPS on TCP 443 to an approved host succeeds; another port and an unapproved host fail. Verify resolver DNS works, the firewall applies to the workload, and `host` or an unarmed tier cannot redeem a browser-fill grant.

### T5 — Tenant-scoped browser audit events

**Lane:** compass Go server/runner; depends on T1.

**Interfaces:** Append `BrowserAuditEvent{tenant_id, agent_id, session_id, grant_id, origin_host, action, outcome, occurred_at}` to tenant-RLS table `browser_audit_events`; prune daily after 90 days.

**Test cycle:** Verify tenant isolation, redacted fields, append-only writes, and expiry: old rows are removed while recent rows remain.

### T6 — TOTP and supported human handoff

**Lane:** compass Go runner (controller) and compass server; depends on T1 and T2.

**Interfaces:** `TotpSecretKind`; the controller-only method `GenerateAndFillTotp(context_id, document_id, grant_id, selector) -> status` redeems the seed, generates the code, and types it. The trusted prompt is `RequestPushApproval(agent_session_id, vendor, displayed_match_number?) -> {approved, selected_match_number?}`. The Server sends the human's answer to the controller over the browser-UID-only channel. Reject SMS, passkeys, and hardware keys without trusted input.

**Test cycle:** Verify the TOTP seed and generated code stay out of model results and logs. Verify the human sees the GitHub number and the Server sends the yes/no answer only to the controller. Reject unsupported challenges without chat leakage.

### T7 — Cross-tier browser security and workflow tests

**Lane:** compass-agent TS and compass Go server/runner; depends on T2–T6.

**Interfaces:** `FakeGitHubManifestServer` exposes manifest submission and conversion endpoints. `FakeLinearAppForm` serves registration and generated-secret fields. `RunBrowserSecurityMatrix(tier WorkloadTier, h Harness) error` runs each enabled tier with these fakes, broker, and Runner firewall.

**Test cycle:** Assert that secrets and tainted page data are absent from model results, transcripts, screenshots, logs, and audit. Test origin races, process/profile/socket isolation, session taint, unsupported tiers, capture, and cleanup. Run GitHub and Linear tests separately on each enabled tier.

## Tasks

- [ ] T1 — Add origin-bound browser fill and workflow-bound generated-secret capture to the RIG-6006 broker contract. Test principal, origin, use, expiry, and value-free audit.
- [ ] T3 — Bake pinned Chromium into the agent image and create isolated per-agent-session profiles with teardown cleanup. Test binary match, isolation, and deletion.
- [ ] T8 — Implement the OMP-fork TypeScript controller and trusted GitHub/Linear workflows. The Runner launches it as browser UID. Test multi-field login, optional TOTP, credential capture, isolation, and teardown.
- [ ] T2 — Add the Compass model-tool proxy to the controller. Disable `browser.enabled`. Test context/document forwarding, taint enforcement, and status-only responses.
- [ ] T4 — Add TCP 443-only Runner egress for approved browser hosts and resolver-only DNS. Test allowed HTTPS and denied hosts and ports.
- [ ] T5 — Add tenant-RLS append-only audit events with 90-day pruning. Test redaction, isolation, append-only behavior, and expiry.
- [ ] T6 — Add brokered TOTP and trusted push approval, including GitHub number matching. Test protected code flow and unsupported factors.
- [ ] T7 — Test browser security and vendor workflows across enabled tiers. Verify isolation, readback, audit, and teardown.

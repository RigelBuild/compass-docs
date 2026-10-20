# Compass Secret Broker

## Open Questions

These questions are resolved for this design. Each recommendation is the assumption used below.

1. **Which value backend and tenant placement should v1 use?** Option A adds OpenBao now, with a central policy boundary but extra deployment and credential-policy work before a dynamic-secret consumer exists. Option B uses shared tenant-isolated Postgres and Compass encryption. Option C uses a separate Postgres database per tenant and multiplies operations. **Recommendation: use shared encrypted Postgres in v1 behind `SecretBackend`; reject per-tenant databases. Keep OpenBao as the preferred future backend when a real dynamic-secret consumer needs it.**
2. **Which grant modes and limits should v1 support?** Option A supports once and session grants. Option B also supports standing grants, reducing repeat prompts but retaining authority longer. **Recommendation: support once, session, and standing; default mode to once and expiry to the lesser of requested TTL and its mode cap. If requested TTL is omitted, use 15 minutes.** Once expires at most 15 minutes after approval; session grants bind to one live binding version and expire at most 8 hours after approval; standing grants expire at most 7 days after approval and require origin-bound uses. A failed backend read is audited and does not consume a once grant.
3. **Where should users approve requests?** Option A reuses asks, which are not permission prompts. Option B adds a separate event stream with separate replay state. Option C uses Settings and the existing event stream. **Recommendation: add a private Settings approval panel, send a payload-free cue on `SubscribeEvents`, and use `ListSecretRequests` as the recovery snapshot.**
4. **How should broker values be stored and delivered?** Option A puts them in A9 and filters them from container materialization. Option B gives them a separate table and tool-only delivery path. **Recommendation: store broker values in `broker_secrets`; forbid FILE/ENV materialization and redeem only through trusted tools. Keep existing A9 FILE/ENV behavior unchanged.**
5. **Who receives redeemed bytes?** Option A exposes bytes to agent-readable code. Option B returns them only to trusted tool code. **Recommendation: only trusted Runner host code receives bytes; the model and agent container receive the fill result, not the value.**
6. **Should v1 issue dynamic credentials?** Option A adds credential issuers and revocation behavior now. Option B starts with human-provided static values. **Recommendation: defer dynamic issuance, including GitHub App installation tokens. Add no dynamic-backend interface in v1; prefer OpenBao for a future design with a concrete dynamic-secret consumer.**
7. **Which secret scopes should v1 support?** Option A includes TENANT, USER, and AGENT. Option B includes TENANT and USER. **Recommendation: support TENANT and USER only; reject AGENT refs at request and value-write boundaries. Unspecified scope maps to USER.**
8. **Where should browser isolation be enforced?** Option A makes the broker responsible for browser capabilities it cannot control. Option B makes isolation a consumer precondition. **Recommendation: RIG-6007 owns and proves that the filled browser is outside agent code-execution reach and exposes no agent-facing eval or filled-field DOM/value reads. The broker requires this before enabling browser fill.**
9. **Should v1 add an ACL before user approval?** Option A adds ACL policy management and another authorization system. Option B requires approval by the designated owner or tenant admin for every request. **Recommendation: defer ACLs. Approval is the sole v1 authority gate; add no ACL tables or APIs.**

## Problem / Intent

Compass stores user values encrypted in Postgres and materializes A9 values into agent containers. Agents need selected browser and vendor credentials without exposing reusable values to model context or general agent code. Add requests, user approval, scoped grants, and trusted tool redemption. The existing `secrets` tenant-key issue is out of scope and tracked separately as RIG-6070.

## Approach

### Existing contract and code

The frozen A9 record defines identity and precedence: `SecretRecordsForAgent` returns one value per name, with `agent > user > tenant` (`docs/designs/compass/server/compass-user-secret-store.md`, A9: “The injected environment holds ONE value per name”). It fixes AES-256-GCM and `value_ciphertext`, `value_nonce`, and `key_version`. DL-350 remains Active for user-managed values; DL-351, DL-355, and DL-362 govern encryption and key custody. DL-356 keeps boot/server secrets read-only. DL-639 adds a separate broker-value class and changes none of those contracts.

The code stores encrypted values in `secrets` (`go/internal/store/migrations/0001_init.sql`, `CREATE TABLE secrets`: “PRIMARY KEY (name, scope_kind, scope_id)”). `StoreResolver.ResolveFor` selects A9 values using “agent > user > tenant” (`go/internal/secrets/store_resolver.go`, `ResolveFor`). `Handler.FetchSecrets` returns live values to the Runner (“response carries live secret values”; `go/internal/runnerhub/handler.go`), and `agentHost.Start` installs them before execution (“Materialize the agent's secrets BEFORE exec'ing”; `go/internal/runner/host.go`). `SecretDelivery` supports FILE and ENV (`proto/compass/v1/compass.proto`, `SecretDelivery`: “0600 file” and “aggregate 0600 env file”). Broker values remain outside this path and cannot enter container materialization.

`BearerInterceptor` resolves the bearer token and attaches the account to request context (`go/internal/auth/doc.go`, `BearerInterceptor`: “attaches the caller's account to the request context”). Runner relays resolve the account from the Server session binding (`proto/compass/v1/runner.proto`, `RelayCommsCall`). Agent identity, owner, and tenant come from that trusted context, not request fields. An agent request is made for a durable agent account, not a temporary subagent: “A subagent has no Compass handle or account” (`docs/concepts/agent-roles.md`). The existing secret contract says “A human provides the VALUE for that named slot” (`docs/concepts/no-human-clicks.md`).

Compass asks are not permission prompts (`proto/compass/v1/comms.proto`, `Ask`: “This is not a permission prompt”). DL-054 limits notifications v1 to chat pings and asks. Use a dedicated Settings panel and a payload-free cue on `CompassService.SubscribeEvents`; the request list is the recovery snapshot. This extends the event mechanism described in `docs/designs/compass/server/compass-notification-delivery/design.md` without making asks an authorization mechanism.

### Ref, request, grant, and approval

`SecretRef` is `{scope, name}` using the existing `SecretScope` USER/TENANT enum. Unspecified scope maps to USER. The Server derives USER `scope_id` from the requesting agent's stored owner; TENANT uses an empty id. Map wire scopes explicitly to store values (`TENANT=0`, `USER=1`); never cast. Reject AGENT and unknown scopes. The broker namespace never reads, shadows, or falls back to an A9 row.

For broker-value writes, the owning user may set or delete USER refs. Only a tenant admin may set or delete TENANT refs. The Server derives the coordinate; clients cannot provide an owner id or tenant id.

A request has an exact ref, purpose, requested TTL, and typed uses. V1 supports only `browser_fill`; its binding contains proposed exact origins. Each origin is a normalized scheme/host/port tuple with no path or wildcard. An approver may narrow, but not expand, the requested use or origin set. The approver chooses mode and expiry. Mode defaults to once. Grant expiry cannot exceed the lesser of requested TTL and the mode cap: 15 minutes for once, 8 hours for session, and 7 days for standing. If requested TTL is omitted, use 15 minutes. Validate expiry against server time. USER requests go to the owning user. TENANT requests go to a tenant admin, even when the agent has an owner. Persist before publishing the generic changed cue. `ListSecretRequests` returns only requests the caller may approve.

A grant is `Grant{grant_id, ref, agent_account_id, purpose, mode, expires_at, uses[]}`. The grant id identifies a grant but does not authorize by possession alone; each use is checked against the authenticated identity and live binding. Once allows one successful redemption. Session and standing allow redemption until expiry or revocation. Failed backend reads are audited and leave once grants available. Session grants bind to `(session_id, binding_version)` and are revoked when `Hub.releaseSession` releases that binding. A logical session id can persist across authorized resume (`docs/designs/compass/agent/runner-session-id-allocation/design.md`: “A resume reuses the already-authorized logical `resume_session_id`”), so it is not sufficient by itself. Standing grants are agent-bound and require origin-bound uses.

An agent calls `GetSecretRequest(request_id)` to poll its own request until it is approved, denied, or cancelled. The Server resolves the agent from the active binding and returns state, grant id, and expiry only; it never returns a value. Use bounded backoff. The agent may cancel its own pending request; an approver may deny it. A conditional state transition allows only one decision. Approval returns a grant id that identifies, but does not authorize by possession alone; every use checks the authenticated identity and live binding.

### Trusted Runner tool path

A new tool runtime runs in the Runner host process, outside the agent container; this runtime does not exist today. The in-container browser tool calls `AgentGateway.FillSecret` with `call_id`, `grant_id`, `use_id`, and a field locator. The trusted host runtime gets the current origin from its CDP target, redeems the grant over an authenticated Runner-to-Server RPC, fills through CDP, and returns only success or failure. It never accepts an origin from the agent request. The value does not travel over an agent-token channel: only trusted Runner host code receives bytes, never the agent socket, model arguments, prompts, tool output, or transcript. RIG-6007 must keep the filled browser outside agent code-execution reach and prevent agent-facing eval or filled-field DOM/value reads before this tool is enabled.

### Value backend

Store requests, grants, audit rows, and broker values in shared tenant-isolated Compass Postgres. V1 implements `SecretBackend` over Postgres encrypted by existing `envelope.Key`, the operator-seeded `COMPASS_MASTER_KEY`, and row-bound AAD derived from tenant, scope, name, and key version. Values live only in `broker_secrets`; ciphertext and nonce are non-null. The interface permits a future backend without shipping an OpenBao adapter in v1.

OpenBao's public documentation says “Policies are deny by default” (`https://openbao.org/docs/concepts/policies/`). Its lease documentation says “All dynamic secrets in OpenBao are required to have a lease” and “The Key/Value Backend ... does not issue leases” (`https://openbao.org/docs/concepts/lease/`). OpenBao is therefore a candidate for a future dynamic-credential backend, not the v1 store. The core supports both self-hosted and managed deployments (`docs/concepts/self-host-and-managed.md`); this design chooses no deployment-specific topology.

## Alternatives considered

- **OpenBao in v1:** deferred until a real consumer needs dynamic credentials. V1 has static user-provided values and can use Compass encryption.
- **Per-tenant Postgres:** rejected because separate databases multiply operations without changing the v1 authorization model.
- **A9 storage:** rejected. A separate table follows the `server_secrets` precedent in `go/internal/store/migrations/0001_init.sql`, where separation is enforced “by construction rather than by a filter someone can forget.” Broker values cannot shadow or materialize with A9 values.
- **ACL before approval:** deferred. Per-request approval gives one clear authority decision; ACL adds policy administration without removing that gate.
- **Ask or separate event stream:** rejected. Asks are not permission prompts; a separate stream adds replay state. A generic cue plus persisted-list refetch is sufficient.
- **Model-readable redemption or shared browser:** rejected because model-written code could read the credential or the filled field.
- **Agent-scoped requests:** rejected because v1 has no agent-scope value-entry contract or consumer.

## Threat model

Treat model-written code and each agent as potentially compromised, matching `docs/concepts/isolation-and-egress.md`: “treat every agent as potentially compromised and contain it.” The broker denies by default. It resolves identity from verified Runner authentication and active binding, checks tenant and approver authority, validates the ref and approved use on each redemption, and audits attempts without values. Forced tenant RLS applies to every broker table. A request or grant in one tenant cannot authorize another tenant.

Only trusted Runner host code receives bytes. It obtains origin from trusted CDP state, normalizes it, and matches it exactly against the approved use. A compromised Server or Runner host can observe values. A compromised agent must not reach the filled browser or read filled DOM/value state; that is a RIG-6007 precondition. Revocation blocks future reads but cannot recall a static value already read. Users must rotate exposed downstream credentials.

Values MUST NOT appear in logs, audit, events, UI, errors, model-visible output, or persisted grants. Secret-bearing Go values implement redacted `String() string`, `GoString() string`, and `LogValue() slog.Value`, following `go/internal/envelope/envelope.go`, `Key`: “String/GoString/LogValue close the fmt and slog reflection vectors.” Protobuf `debug_redact` is metadata, not runtime protection; handlers MUST NOT log request messages. Audit records ids, use kind, canonical binding, outcome, and time, never values.

## Plan

### Global Constraints

- Keep DL-350 Active. Preserve the A9 table, key, AAD, precedence, FILE/ENV delivery, and boot/server-secret separation (DL-350, DL-351, DL-355, DL-356, DL-362).
- Broker values live only in `broker_secrets`; they never shadow A9, enter `FetchSecrets`, or materialize into containers.
- Use forced tenant RLS on every new table. Account/agent-account FK hardening is out of scope; the separate `secrets` tenant-key fix is tracked as RIG-6070.
- V1 has no ACL, OpenBao adapter, dynamic-secret interface, tombstone, backend job, or external-backend retry protocol.
- Once grants default to 15 minutes and cannot exceed 15 minutes. Session grants bind to one `(session_id, binding_version)`, are revoked by `Hub.releaseSession`, and cannot exceed 8 hours. Standing grants cannot exceed 7 days and require origin-bound uses. All expiries also respect requested TTL.
- Only trusted Runner host tool code outside the agent container may read values. Do not enable browser fill until the RIG-6007 isolation precondition holds.

### T1 — Broker store and migration

Add `go/internal/store/migrations/0005_secret_broker.sql` after `0004_forge_write_intents.sql`. Follow its per-table pattern: grant `SELECT, INSERT, UPDATE, DELETE` to `compass_app` and `compass_system`, enable and force RLS, and create a `tenant_isolation` policy using the tenant GUC. Apply that grant and policy to every new table. Do not alter `secrets`, `server_secrets`, or their migrations. Map broker scope values as `TENANT=0`, `USER=1`.

`Interfaces:` `SecretCoordinate` is derived by the Server from the public ref and authenticated owner's account id. The store uses its declared `store.TenantID` (`go/internal/store/types.go`, `TenantID`). Broker AAD is domain-separated from A9: `"compass/broker-secret/v1\x00"` followed by tenant, scope kind, scope id, name, and key version, NUL-separated. Reject NUL in every field.

```go
type SecretCoordinate struct {
    ScopeKind int16
    ScopeID string
    Name string
}

func BrokerSecretAAD(tenantID string, coord SecretCoordinate, keyVersion int16) ([]byte, error)

type SecretBackend interface {
    Put(context.Context, store.TenantID, SecretCoordinate, []byte) error
    Get(context.Context, store.TenantID, SecretCoordinate) (SecretValue, error)
    Delete(context.Context, store.TenantID, SecretCoordinate) error
}

type SecretValue struct { value []byte }
func (SecretValue) String() string
func (SecretValue) GoString() string
func (SecretValue) LogValue() slog.Value
func (SecretValue) Bytes() []byte
```

Minimum SQL contracts (all tables include `tenant_id`, use forced tenant RLS, and have the privileges and policy above):

```sql
CREATE TABLE broker_secrets (
  tenant_id TEXT NOT NULL, scope_kind SMALLINT NOT NULL CHECK (scope_kind IN (0,1)),
  scope_id TEXT NOT NULL, name TEXT NOT NULL,
  value_ciphertext BYTEA NOT NULL, value_nonce BYTEA NOT NULL,
  key_version SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_kind, scope_id, name),
  CHECK ((scope_kind = 0 AND scope_id = '') OR (scope_kind = 1 AND scope_id <> ''))
);
CREATE TABLE secret_requests (
  tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, agent_account_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL, session_id TEXT NOT NULL, binding_version TEXT NOT NULL,
  scope_kind SMALLINT NOT NULL CHECK (scope_kind IN (0,1)), scope_id TEXT NOT NULL,
  name TEXT NOT NULL, purpose TEXT NOT NULL,
  requested_ttl_seconds BIGINT NOT NULL CHECK (requested_ttl_seconds > 0),
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, request_id),
  UNIQUE (tenant_id, request_id, agent_account_id, scope_kind, scope_id, name),
  CHECK ((scope_kind = 0 AND scope_id = '') OR (scope_kind = 1 AND scope_id <> ''))
);
CREATE TABLE secret_request_uses (
  tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, use_id TEXT NOT NULL,
  use_kind TEXT NOT NULL, binding JSONB NOT NULL,
  PRIMARY KEY (tenant_id, request_id, use_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES secret_requests(tenant_id, request_id) ON DELETE CASCADE
);
CREATE TABLE secret_grants (
  tenant_id TEXT NOT NULL, grant_id TEXT NOT NULL, request_id TEXT NOT NULL,
  agent_account_id TEXT NOT NULL, scope_kind SMALLINT NOT NULL CHECK (scope_kind IN (0,1)),
  scope_id TEXT NOT NULL, name TEXT NOT NULL, purpose TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('once','session','standing')),
  session_id TEXT, binding_version TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, grant_id), UNIQUE (tenant_id, request_id),
  UNIQUE (tenant_id, grant_id, agent_account_id, scope_kind, scope_id, name),
  FOREIGN KEY (tenant_id, request_id, agent_account_id, scope_kind, scope_id, name)
    REFERENCES secret_requests(tenant_id, request_id, agent_account_id, scope_kind, scope_id, name),
  CHECK ((mode = 'session' AND session_id IS NOT NULL AND binding_version IS NOT NULL)
      OR (mode <> 'session' AND session_id IS NULL AND binding_version IS NULL)),
  CHECK ((scope_kind = 0 AND scope_id = '') OR (scope_kind = 1 AND scope_id <> ''))
);
CREATE TABLE secret_grant_uses (
  tenant_id TEXT NOT NULL, grant_id TEXT NOT NULL, use_id TEXT NOT NULL,
  use_kind TEXT NOT NULL, binding JSONB NOT NULL,
  PRIMARY KEY (tenant_id, grant_id, use_id),
  FOREIGN KEY (tenant_id, grant_id) REFERENCES secret_grants(tenant_id, grant_id) ON DELETE CASCADE
);
CREATE TABLE secret_audit (
  tenant_id TEXT NOT NULL, audit_id BIGINT GENERATED ALWAYS AS IDENTITY,
  request_id TEXT, grant_id TEXT, agent_account_id TEXT, session_id TEXT,
  use_kind TEXT NOT NULL, binding JSONB NOT NULL, outcome TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, audit_id)
);
```

Requests may exist before values. Deleting a broker value revokes matching grants but retains request and audit history. The backend derives AAD from tenant, scope, name, and key version.

The migration uses this exact grant and RLS pattern for each new table, as in `0004_forge_write_intents.sql`:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON broker_secrets TO compass_app, compass_system;
ALTER TABLE broker_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broker_secrets
  USING ((SELECT current_setting('compass.tenant_id', TRUE)) <> ''
         AND tenant_id = (SELECT current_setting('compass.tenant_id', TRUE)))
  WITH CHECK ((SELECT current_setting('compass.tenant_id', TRUE)) <> ''
         AND tenant_id = (SELECT current_setting('compass.tenant_id', TRUE)));
```

Repeat those statements for `secret_requests`, `secret_request_uses`, `secret_grants`, `secret_grant_uses`, and `secret_audit`.

### T2 — Request, approval, and grant API

Add user-authenticated set/delete, list, review, and cancellation APIs to `SecretsService`. Add request, status, and cancellation relays through AgentGateway and RunnerService. Resolve agent, owner, tenant, session, and binding version from the active RunnerHub binding. USER requests can be approved by the owner; TENANT requests require a tenant admin. Approval and grant creation are one transaction. User-facing request APIs carry no caller-supplied actor or tenant. Use the existing `SecretScope` enum and append new RPCs and messages; do not change A9 messages.

`Interfaces:`

```proto
// SecretsService additions.
rpc SetBrokerSecret(SetBrokerSecretRequest) returns (SetBrokerSecretResponse);
rpc DeleteBrokerSecret(DeleteBrokerSecretRequest) returns (DeleteBrokerSecretResponse);
rpc ListSecretRequests(ListSecretRequestsRequest) returns (ListSecretRequestsResponse);
rpc ReviewSecretRequest(ReviewSecretRequestRequest) returns (ReviewSecretRequestResponse);
rpc CancelSecretRequest(CancelSecretRequestRequest) returns (CancelSecretRequestResponse);

message SecretRef { SecretScope scope = 1; string name = 2; }
message SecretUse { string use_id = 1; SecretUseKind kind = 2; SecretUseBinding binding = 3; }
message SecretUseBinding { repeated string allowed_origins = 1; }
enum SecretUseKind { SECRET_USE_KIND_UNSPECIFIED = 0; SECRET_USE_KIND_BROWSER_FILL = 1; }
enum GrantMode { GRANT_MODE_UNSPECIFIED = 0; GRANT_MODE_ONCE = 1; GRANT_MODE_SESSION = 2; GRANT_MODE_STANDING = 3; }
message SetBrokerSecretRequest { SecretRef ref = 1; string value = 2 [debug_redact = true]; }
message SetBrokerSecretResponse {}
message DeleteBrokerSecretRequest { SecretRef ref = 1; }
message DeleteBrokerSecretResponse {}
message RequestSecretRequest { SecretRef ref = 1; string purpose = 2; int64 requested_ttl_seconds = 3; repeated SecretUse uses = 4; }
message ReviewSecretRequestRequest { string request_id = 1; bool approved = 2; GrantMode mode = 3; int64 expires_at_unix_ms = 4; repeated SecretUse uses = 5; }
message ReviewSecretRequestResponse { string grant_id = 1; int64 expires_at_unix_ms = 2; }
message CancelSecretRequestRequest { string request_id = 1; }
message CancelSecretRequestResponse {}
message ListSecretRequestsRequest {}
message ListSecretRequestsResponse { repeated SecretRequest requests = 1; }
message SecretRequest { string request_id = 1; SecretRef ref = 2; string purpose = 3; int64 requested_ttl_seconds = 4; repeated SecretUse uses = 5; string state = 6; string grant_id = 7; int64 expires_at_unix_ms = 8; }
```

Add request, status, and cancellation relays to AgentGateway and RunnerService:

```proto
rpc RequestSecret(SecretRequestCallRequest) returns (SecretRequestCallResponse); // AgentGateway
rpc RelaySecretRequest(RelaySecretRequestRequest) returns (RelaySecretRequestResponse); // RunnerService
rpc GetSecretRequest(GetSecretRequestCallRequest) returns (GetSecretRequestCallResponse); // AgentGateway
rpc RelayGetSecretRequest(RelayGetSecretRequestRequest) returns (RelayGetSecretRequestResponse); // RunnerService
rpc CancelSecretRequestCall(CancelSecretRequestCallRequest) returns (CancelSecretRequestCallResponse); // AgentGateway
rpc RelayCancelSecretRequest(RelayCancelSecretRequestRequest) returns (RelayCancelSecretRequestResponse); // RunnerService
```

```proto
message SecretRequestCallRequest { string call_id = 1; RequestSecretRequest request = 2; }
message SecretRequestCallResponse { string call_id = 1; string request_id = 2; }
message RelaySecretRequestRequest { string session_id = 1; SecretRequestCallRequest call = 2; }
message RelaySecretRequestResponse { SecretRequestCallResponse result = 1; }
message GetSecretRequestCallRequest { string call_id = 1; string request_id = 2; }
message GetSecretRequestCallResponse { string call_id = 1; string state = 2; string grant_id = 3; int64 expires_at_unix_ms = 4; }
message RelayGetSecretRequestRequest { string session_id = 1; GetSecretRequestCallRequest call = 2; }
message RelayGetSecretRequestResponse { GetSecretRequestCallResponse result = 1; }
message CancelSecretRequestCallRequest { string call_id = 1; string request_id = 2; }
message CancelSecretRequestCallResponse { string call_id = 1; bool cancelled = 2; }
message RelayCancelSecretRequestRequest { string session_id = 1; CancelSecretRequestCallRequest call = 2; }
message RelayCancelSecretRequestResponse { CancelSecretRequestCallResponse result = 1; }
```

`GetSecretRequest` and cancellation are restricted to the request's own resolved agent. RunnerHub relay signatures:

```go
func (h *Hub) RelaySecretRequest(ctx context.Context, runnerID string, req *compassv1internal.RelaySecretRequestRequest) (*compassv1internal.RelaySecretRequestResponse, error)
func (h *Hub) RelayGetSecretRequest(ctx context.Context, runnerID string, req *compassv1internal.RelayGetSecretRequestRequest) (*compassv1internal.RelayGetSecretRequestResponse, error)
func (h *Hub) RelayCancelSecretRequest(ctx context.Context, runnerID string, req *compassv1internal.RelayCancelSecretRequestRequest) (*compassv1internal.RelayCancelSecretRequestResponse, error)
```

### T3 — Trusted Runner redemption

Implement `FillSecret` in the new trusted Runner host tool runtime. The RunnerService relay authenticates the Runner subject; it derives agent, tenant, and active binding from the session. The relay accepts no agent id, token, or agent-supplied origin.

`Interfaces:`

```proto
rpc FillSecret(FillSecretCallRequest) returns (FillSecretCallResponse); // AgentGateway
rpc RelayRedeemSecret(RelayRedeemSecretRequest) returns (RelayRedeemSecretResponse); // RunnerService
message FillSecretCallRequest { string call_id = 1; string grant_id = 2; string use_id = 3; string field_locator = 4; }
message FillSecretCallResponse { string call_id = 1; bool filled = 2; }
message SecretRedemptionBinding { string session_id = 1; }
message RelayRedeemSecretRequest { string grant_id = 1; string use_id = 2; SecretRedemptionBinding binding = 3; }
message RelayRedeemSecretResponse { bytes value = 1 [debug_redact = true]; int64 expires_at_unix_ms = 2; }
```

The host derives origin from its authenticated CDP target. It does not send origin in the wire request; the authenticated Runner host passes it to the Server handler in process-local context. The Server normalizes the origin and checks exact equality against the approved use. `Redeemer` takes no agent-supplied identity or origin:

```go
type SecretRedemptionBinding struct {
    SessionID string
    Origin string
}

type Redeemer interface {
    Redeem(context.Context, string, string, SecretRedemptionBinding) (SecretValue, time.Time, error)
}

func (h *Hub) RelayRedeemSecret(ctx context.Context, runnerID string, req *compassv1internal.RelayRedeemSecretRequest, binding SecretRedemptionBinding) (*compassv1internal.RelayRedeemSecretResponse, error)
```

For once grants, hold the grant row lock through the backend read. On success, mark consumed and write the audit row in one transaction before returning bytes; if commit fails, return no bytes. On backend read failure, audit and commit without consuming. Session grants bind to `(session_id, binding_version)` and are revoked when `Hub.releaseSession` releases that binding. Audit every redemption with ids, use kind, canonical binding, outcome, and time; never record the value.

### T4 — Approval panel and event cue

Add a private Settings panel. Show requester, purpose, exact ref, proposed uses/origins, TTL, and grant mode; never show values. Append a payload-free event to `SubscribeEventsResponse.payload` at field 17:

```proto
message SecretRequestsChanged {}
// In SubscribeEventsResponse.payload:
SecretRequestsChanged secret_requests_changed = 17;
```

After the cue, clients refetch `ListSecretRequests`; do not add `SubscribeSecretEvents`. The list returns the complete caller-authorized request snapshot, including each request's state, grant id, and expiry. Enforce owner-only USER visibility and tenant-admin-only TENANT visibility on list and review. The cue contains no request, owner, tenant, or value.

### T5 — RIG-6007 browser consumer

RIG-6007 must keep the filled browser outside agent code-execution reach and ensure agent-facing tools expose no eval or filled-field DOM/value reads before browser fill is enabled. The trusted Runner host obtains active origin from CDP and fills only an approved origin. The broker cannot enforce browser isolation by itself.

## Tasks

- [ ] T1 — Add `0005_secret_broker.sql`, tenant-RLS broker tables, encrypted Postgres `SecretBackend`, and broker value set/delete. Test tenant isolation, AAD binding, encrypted storage, and independence from A9 resolution and materialization.
- [ ] T2 — Add owner/admin request, list, review, and own-request status APIs, plus Runner relays. Test auth-derived identity, AGENT-ref rejection, ownership, decision races, use-subset validation, and expiry caps.
- [ ] T3 — Build the trusted Runner host tool path, fill relay, redemption, once-read locking, audit, and binding-version revocation. Test foreign Runner, stale binding, wrong grant, origin mismatch, read-failure retry, redaction, and absence of model-visible values.
- [ ] T4 — Add the private Settings approval panel and payload-free `SubscribeEvents` cue. Test owner/admin list isolation and reconnect refetch.
- [ ] T5 — Implement and test the RIG-6007 browser-isolation precondition before enabling fill.

## Ledger delta

Add `docs/designs/compass/decisions/server/DL-639.md` for the core ruling: a Postgres control plane stores broker requests, grants, and audit; broker values use a separate encrypted Postgres table; and approved grants are redeemed only by trusted Runner tools. DL-350 stays Active and unchanged. DL-639 adds a separate broker-value class and does not change A9, the existing secret table, or boot/server-secret storage.

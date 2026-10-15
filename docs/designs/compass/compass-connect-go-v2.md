# Compass connect-go v2 migration

## Open Questions

The questions are independent.

**Q1. Stack shape.** Compass generates two stub lanes: public and internal.
Two facts break a stack that flips one lane at a time:

- **The tool's readiness check is per file.** `connect-go-v2-migrate` treats a
  file as ready when the file itself imports no v1 stub package
  (`discover.go`: `ready := !importsV1Stub(file, v1StubPkgs)`). Some files
  call stub types without importing a stub package, so the tool rewrites them
  early and the build breaks against the other lane's v1 stubs. Example:
  [`internal/comms/agent_caller.go`](https://github.com/RigelBuild/compass/blob/main/go/internal/comms/agent_caller.go)
  imports `connectrpc.com/connect` and no stub package, and calls the v1
  public handler with `connect.NewRequest(req)`.
- **v1 and v2 `*connect.Error` cannot see each other.** v1's `asError` finds
  only a v1 `*Error`; v2's `CodeOf` uses `errors.AsType[*Error]` and finds
  only a v2 one. Mid-stack, errors that cross from one major to the other
  arrive as `Unknown`. This happens at hub → server (`s.hub.Start` returned
  by v1 `CompassService` handlers) and at comms → runnerhub (`commsCallError`
  and the board, forge and lifecycle relay envelopes). It also breaks
  `classifyEnrollProbe` in `e2e/agent_ops.go`.

Options:

- (a) One code PR flips both lanes, keeping the three-commit split.
- (b) Two lane PRs. Each runs the tool on explicit package roots, and a
  temporary bridge between the two error types covers the hub → server and
  comms → runnerhub boundaries until the second lane lands.

**Recommendation:** (a); see Alternatives considered.

**Q2. Relayed errors.** Six runner-gateway handlers return the Server's error
to the agent unchanged: `Board`, `Forge`, `Comms`, `Lifecycle`,
`PostConversationFrame` and `PutSessionBlob` (`go/internal/runner/gateway/`).
The publisher's upstream `Send` is a seventh path. Their doc comments promise
"every status unchanged".

In v2 every error a client decodes is marked remote, and connecthttp's
`scrubHandlerError` turns a returned remote error into `CodeInternal` with no
message. The agent branches on codes that would collapse to `Internal`:

- `relayCall` in
  [`relay-error.ts`](https://github.com/RigelBuild/compass/blob/main/packages/compass-agent/src/relay-error.ts)
  branches on `FailedPrecondition` and `Unavailable`.
- `session-blobs.ts` branches on `Unimplemented`.

Options:

- (a) A gateway helper, `relayedError`, re-authors a remote error as a local
  one with the same code, message and details. The Server's error messages
  then become an explicit contract with the agent.
- (b) Accept the scrub. The agent loses its unbound-session, retry and
  blob-fallback handling.
- (c) Report relay failures inside the response body. This changes the proto
  of both lanes.

**Recommendation:** (a). Decision needed: may the gateway keep passing
Server-authored error text to the agent?

**Q3. Client read limits.** v1 has no per-message read limit; v2 defaults to
4 MiB on clients and handlers. The server side is settled under Read limits.
On the client side, one read is really unbounded today: the Runner's
`Sessions` stream, which carries `ResumeBody.session_body`.
`ReconstructSessionBody` puts no bound on that body. Session-blob frames are
not affected, because the hub sends them in `configChunkBytes` (512 KiB)
chunks.

Options:

- (a) Every client pins `WithReadMaxBytes(0)`. This is what the migrate tool
  emits, and it keeps v1 behaviour.
- (b') Like (a), but the Runner's `Sessions` client gets a named resume limit
  through `connecthttp.WithConditionalOptions`. A Server that misbehaves can
  then not exhaust a Runner's memory. The cost: a legitimately long resume
  above the limit fails, because nothing bounds the body on the Server side.
- (b) A named limit on every client.
- (c) Take the 4 MiB default. This breaks resumes above 4 MiB.

**Recommendation:** (a). The port should not add a new failure mode, and the
Runner already authenticates its Server. Decision needed: is an unlimited
`Sessions` read acceptable, or should it get the (b') limit?

## Problem / Intent

Tracking: RIG-5471

Ledger-impact: none until the rulings.

Paths below are in RigelBuild/compass unless they name another repo. Counts
were taken at compass `main` `12489a0c`.

Compass's Go backend uses connect-go v1: `connectrpc.com/connect` v1.20.0 in
[`go/go.mod`](https://github.com/RigelBuild/compass/blob/main/go/go.mod). At
`12489a0c`, 266 Go files import it:

- 9 generated files
- 257 hand-written files: 85 production, 172 test

The service owner counts 268 at `22d9fc0a`.

Matt ruled to move to `connectrpc.com/connect/v2` v2.0.1. Renovate cannot do
it: [compass#2310](https://github.com/RigelBuild/compass/pull/2310) bumped only
the `require` line, and `compass-go:tidy` (`go mod tidy -diff`) failed because
no file imports v2.

## Approach

**Shape.** Preparatory PRs stay on v1. Then one code PR moves both stub lanes
together (Q1):

- **public:** `buf.gen.yaml` writes `go/gen/.../compassv1connect`, 5 services:
  Compass, Secrets, AgentRepository, Comms and Usage.
- **internal:** `buf.gen.internal-go.yaml` writes `compassv1internalconnect`,
  6 services: AgentGateway, GatewayAuth, GatewayCredentials, GatewayRegistry,
  GuestControl and RunnerService.

Package `server` imports both stub packages. Some files there, such as
`network_door.go`, import both.

The preparatory PRs move the changes the tool handles badly onto v1 first, so
the flip PR's hand-edit commit stays small:

- cause-dropping `%w` sites
- door read limits
- the removed otelconnect option

**Flip mechanics.** The flip PR has three commits:

1. Regenerate both lanes.
2. Run `connect-go-v2-migrate -w` (v1.0.0) once from `go/`, with
   `GOFLAGS=-tags=pgtest,podman,microvm`. The tool loads packages through
   `go/packages`, so without the tags it skips the 89 tagged files that import
   connect. This commit is the tool's output, unedited.
3. Hand edits for everything the tool flags.

A scratch trial made 167 rewrites, flagged 59 files, and then failed to build
only in planned hand work: typed streams in `guestd`, `microvm` and
`comms/subscribe.go`.

**Ecosystem modules.**

- `otelconnect` v0.12.0 is the only release that supports both v1 and v2. It
  keeps v1's `NewInterceptor` and adds `NewServerInterceptor` and
  `NewClientInterceptor`. After the flip, v1 stays in `go.mod` only as
  `// indirect`, through otelconnect.
- `grpchealth` moves to `connectrpc.com/grpchealth/v2` v2.0.0
  (`Register(*connect.Server, Checker)`).
- `connectrpc.com/cors` v0.1.0 does not depend on connect and stays as it is.

### API mapping

Counts are production / test uses in hand-written files. "Tool" means the
migrate tool rewrites the use. "Hand" means the tool flags it and a person
ports it.

| v1 symbol | Uses | v2 | How |
|---|---|---|---|
| `NewError(code, err)` | 383 / 73 | `NewError(code, msg string)`. The tool emits `NewError(code, err.Error()).WithCause(err)` for an identifier, `NewError(code, "s")`, or `Errorf`. For `fmt.Errorf("…%w")` it emits `NewError(code, fmt.Errorf(…).Error())`, which drops the cause, so PR 2 reshapes those sites first. | tool |
| `Code*`, `Code`, `CodeOf` | 498+ / 889+ | unchanged | — |
| `Request[T]`, `NewRequest` | 164 / 757 | plain `*T`; headers through `NewClientContext` / `CallInfoForServerContext` | tool (35 metadata warnings) |
| `Response[T]`, `NewResponse` | 198 / 180 | plain `*T` | tool |
| `UnaryFunc`, `UnaryInterceptorFunc`, `AnyRequest`, `AnyResponse` | 57 / 55 | `ServerInterceptor` / `ClientInterceptor` | hand |
| `Interceptor`, `StreamingHandlerFunc`/`Conn`, `StreamingClientFunc`/`Conn` | 38 / 22 | `ServerInterceptor` / `ClientInterceptor` | hand |
| `WithInterceptors` | 18 / 14 | arguments to `NewServer` / `NewClient` | hand |
| `WithReadMaxBytes`, `HandlerOption` | 14 / 1 | `connecthttp.WithReadMaxBytes`, `connecthttp.Option` | tool |
| `WithCodec`, `Codec` | 4 / 0 | `connecthttp.WithCodecs`; `Codec` gets `MarshalWrite` / `UnmarshalRead(ctx, io…)` | hand |
| `HTTPClient` | 5 / 0 | `connecthttp.HTTPClient` | hand |
| `ServerStream`, `BidiStream`, `ClientStream` | 14 / 32 | generated `<Svc><Rpc>ServerStream` structs | partial (14 warnings) |
| `ServerStreamForClient`, `BidiStreamForClient`, `ClientStreamForClient` | 12 / 23 | generated `<Svc><Rpc>ClientStream` structs | tool |
| `Spec` (`req.Spec()`, `conn.Spec()`) | 3 / 5 | the `spec` argument of `ServerFunc` | hand |
| `Error` | 3 / 32 | `*Error`, plus `IsRemote` and `WithCause` | — |
| test only: `WithGRPC`, `WithProtoJSON`, `Peer`, `NewServerStreamHandler`, `NewClient`, `StreamTypeServer` | 0 / 9 | `connecthttp.WithGRPC` / `WithProtoJSON`, `CallInfo.PeerAddr`, `Server.Register`, `connect.NewClient(transport)` | hand |

The generated API covers 11 handler interfaces with 96 procedures: 86 unary,
6 server-stream, 2 client-stream and 2 bidi.

- `New<Svc>Handler` (61 uses) becomes `Register<Svc>Handler(srv, impl)` plus
  `connecthttp.Mount(mux, srv, opts...)`.
- `New<Svc>Client(httpClient, url, opts...)` becomes
  `New<Svc>Client(connect.NewClient(connecthttp.NewTransport(httpClient, url, opts...), interceptors...))`.
- The `*Procedure` constants (150 uses) keep their names.

### Construction sites

| Kind | Sites |
|---|---|
| Server mounts | `buildNetworkServer` and `mountGatewayServices` (`server/network_door.go`); `buildDoors` (`server/serve.go`); `newServerHealth` (`server/health.go`); `NewMountedHandler` (`internal/runnerhub/handler.go`); `gateway.Serve` (`internal/runner/gateway/gateway.go`); the vsock mount (`internal/guestd/vsock.go`) |
| Clients | `cmd/compass/client.go` (4), `cmd/compass-app/bridge_service.go`, `e2e/clients.go` (3), `internal/embedded/embedded.go`, `internal/runner/runner.go`, `internal/runnertest/socket.go`, `internal/runtime/microvm/dial.go`, `internal/stack/adapters/health.go` |
| Direct handler calls | `internal/comms/agent_caller.go`, `server/spawn.go` (tool strips `NewRequest`) |

Each v1 `New<Svc>Handler` mount becomes one `*connect.Server` with the door's
interceptor chain, mounted with that service's read limit. That keeps v1's
one-mount-per-service shape and its per-service limits.

v2 runs interceptors in argument order, first one outermost, the same as v1.
So the security-critical orders carry over unchanged: AdminGate before the
ambient pair on the dev door, and otelconnect first everywhere.

When a method is not registered, `Server.Call` returns
`CodeUnimplemented` without running the interceptor chain. So AdminGate's
fail-closed default never sees unknown methods. v1 answered them with HTTP
404, which Connect clients read as `Unimplemented`.

### Interceptor ports

| Interceptor | v2 port |
|---|---|
| `auth.BearerInterceptor` + `BearerStreamInterceptor` (`internal/auth/interceptor.go`, `stream.go`) | one `BearerInterceptor(st) connect.ServerInterceptor`. It reads `CallInfoForServerContext(ctx).RequestHeader()` and covers every stream type. The stream twin is deleted. |
| `auth.AmbientIdentity` + `AmbientStreamInterceptor` | one `AmbientIdentity(account) connect.ServerInterceptor`. The stream twin is deleted. |
| `auth.AdminGate` (3 methods) | `NewAdminGate(admin) connect.ServerInterceptor`, which checks `spec.Procedure` |
| `auth.ServiceBearerInterceptor` (`service_door.go`) | same parameters, returns `connect.ServerInterceptor` |
| runnerhub `bearerAuth` unary + stream (`internal/runnerhub/auth.go`) | one `interceptor() connect.ServerInterceptor` |
| `otel.NewTraceResponseInterceptor` (`internal/otel/interceptor.go`) | `ServerInterceptor`. For unary RPCs it wraps the stream and sets `traceresponse` before the first `Send`. In v2 the generated unary adapter sends inside `next`, so a header set after `next` returns is never sent. Error responses still carry no header, as in v1. |
| `otel.NewSessionIDInterceptor` | `ServerInterceptor` that reads the request header from `CallInfo` |
| `otelconnect.NewInterceptor` | `NewServerInterceptor` in `serve.go` and `gateway.Serve`; `NewClientInterceptor` in `runner.go` |
| client `bearerToken` (`cmd/compass/client.go`, `e2e/clients.go`, `internal/runner/runner.go`) | `bearerToken(...) connect.ClientInterceptor`. It sets the header on `CallInfoForClientContext(ctx)`. In the Runner, a token-source error now fails the call instead of sending an unauthenticated stream. |

### Error behaviour audit

In v2, only a `*connect.Error` created locally reaches the client with its code
and message. Everything else is rewritten:

- a plain error goes out as `CodeUnknown` with no message;
- context errors keep their codes;
- a remote error goes out as `CodeInternal` with no message.

A type-resolved trace followed each handler's returned errors back to where
they were created. These sites change:

| Origin | v1 today | v2 unfixed | Plan |
|---|---|---|---|
| 6 relay forwards + publisher upstream `Send` (gateway) | upstream code and message | `Internal`, no message | Q2 (a) `relayedError` |
| `fmt.Errorf("minting fresh session id: %w")` in `(*Hub).Start` (`internal/runnerhub/commands.go`), reached from `StartAgentSession` and `SpawnAgent` | `Unknown` with text | `Unknown`, no message | `CodeInternal`, created locally in PR 1. This is the one deliberate code change. |
| `stream.Send` / `Receive` / `Err` returned by 9 streaming handlers | connect transport error | [INFERENCE] unchanged: v2 creates these errors locally, and the peer is usually already gone | PR 1 pins the over-limit case |

Every other origin is already a `*connect.Error`, and the tool keeps its text.
These message contracts survive:

- `invalid agent token` (`errGatewayTokenInvalid`, `server/gateway_auth.go`).
  The gateway agent verifier maps it to 401. It stays pinned by
  `TestVerifyAgentTokenInvalidIsUnauthenticated` and the string check in
  `gateway_credentials_service_test.go`. v2's `Error()` keeps the
  `code: message` format.
- `runnerhub.ErrMsgNoRunnerEnrolled` and `ErrMsgNoSessionsStream`, which
  `classifyEnrollProbe` matches.
- The `CodeOf(err).String()` code tokens that the relay envelopes carry.

`classifyConnectErr` (`cmd/compass-app/bridge_service.go`) still reaches the
TLS error, because v2 transport failures attach it through `WithCause`. The TS
clients branch only on codes and display `message`, and the wire format does
not change.

### Read limits

| Mount | v1 | Plan |
|---|---|---|
| Network door CompassService / sibling services / GatewayAuth | 128 MiB / 16 MiB / 4 KiB | same constants on `Mount` |
| RunnerService, AgentGateway, GuestControl, health | `runnerMaxReadBytes`, `maxAgentMessageBytes`, 16 MiB, 1 KiB | same values on `Mount` |
| `buildDoors` socket and dev doors | unlimited | PR 1 sets `compassServiceMaxReadBytes` / `siblingServiceMaxReadBytes`, as on the network door. This covers the 64 MiB `PutAgentConfig` bundle. |
| 11 clients | unlimited | per Q3 |

### Codegen plugin

Decision: one plugin swap in the flip PR, built from compass's own module
graph.

1. `go/go.mod` gains `tool connectrpc.com/connect/v2/cmd/protoc-gen-connect-go`.
   The plugin lives in the root v2 module, so the plugin version is the library
   version by construction.
2. `tools/toolchain/protoc-gen-connect-go.nix` builds it with `buildGoModule`
   over `go/`, using `proxyVendor` and the shared `vendorHash`. Because
   `subPackages` resolve relative to `src`, `buildPhase` runs
   `go build -o $out/bin/protoc-gen-connect-go connectrpc.com/connect/v2/cmd/protoc-gen-connect-go`.
3. The binary keeps its name, so generated headers stay byte-identical.
4. `refresh-fod-hashes.ts` lists the file in `mirrorFiles`, so the hash cannot
   drift.
5. `devenv.nix` drops the nixpkgs attribute and appends the derivation
   outside the parsed `with pkgs` list, as it does for `goAnalysis`.

Cost: the dev shell refetches compass's modules after each `go.sum` change.

### Test strategy

The `httptest` and h2c harnesses (75 test files) stay. They assert limits,
codecs, CORS, headers, interceptor order and error shape, which
`connectinprocess` bypasses.

PR 1's contract tests go through the real boundaries on v1, and the flip PR
must leave them unchanged.

## Alternatives considered

- **Two lane PRs (Q1 b).**
  - Pro: the internal lane is reviewed alone.
  - Con: each tool run needs explicit package roots. Those roots must be
    re-derived at every rebase, because the readiness check is per file.
  - Con: a temporary bridge between the two error types is needed at the
    hub → server and comms → runnerhub boundaries, written, tested and then
    deleted.
  - Con: one more plugin binary has to exist mid-stack.
- **One code PR (Q1 a, recommended).**
  - Pro: no mixed types, no bridge and one plugin swap.
  - Pro: reviewers reproduce commits 1–2 and read only commit 3.
  - Con: the PR touches most of the 257 hand-written importers, so every rebase
    re-runs regen and the tool, and replays commit 3.
- otelconnect v0.11.0. Rejected because it is v2-only.
- Waiting for the nixpkgs plugin. Rejected: plugin and library would drift.

## Global Constraints

- **Collision gate (ruled).**
  - The code stack starts only after both in-flight lines merge:
    - board: #2290 → #2292 → #2300
    - RIG-5186: #2255 → #2259 → #2262 → #2265 → #2267 → #2268 → #2269 → #2270
  - Until then, do not rebase or regenerate against them.
  - These PRs do not overlap the port: forge #2313–#2316, #2243, #2233 and
    #2312.
  - At port start:
    - re-count the importers (`rg -l '"connectrpc.com/connect"' go`);
    - re-run the scratch migration;
    - update the counts in this record.
- **No repo-wide freeze, and its costs.** Other go/ PRs keep landing. The flip
  PR absorbs them at each rebase:
  1. Regenerate.
  2. Re-run the tool.
  3. Replay commit 3.

  Expected costs:
  - Any `go.sum` move on `main`, including Renovate gomod bumps, conflicts on
    the shared `vendorHash` line in PRs 3–4. Re-run the refresh script.
  - Every push resets Matt's approval, and `reviewDecision: APPROVED` can
    survive a push. Re-request review on each new head.
  - Open the flip PR for review only after PRs 1–3 merge, so this window stays
    short.
- **Per-PR gate.** Every PR passes
  `moon run compass-go:tidy compass-go:vet compass-go:test compass-go:lint compass-proto:drift compass-proto:gen-fence`,
  plus the pgtest CI job.
- **Pins.**
  - `connectrpc.com/connect/v2` v2.0.1
  - `grpchealth/v2` v2.0.0
  - `otelconnect` v0.12.0
  - migrate tool v1.0.0
  - Go floor: go 1.26.0
- **Contracts.** These stay byte-identical: the wire protocol, procedure
  names, and every code and message in the audit table. Exception: the mint
  error moves from `Unknown` to `Internal`. No proto edits.
- **Errors.** Never pass a `fmt.Errorf("…%w")` call straight to `NewError`.
  Bind the wrapped error to a local first, so the tool's output carries
  `WithCause`.
- **Public repo boundary.** PR text cites compass paths only.

## Plan

### PR 1: `fix(compass-go): pin RPC contracts and cap socket-door reads`

Stays on v1. The tests go through real boundaries; fakes alone are not
enough.

- **hub → server.** A real `CompassService` handler with
  `runnerhub.NewHub` and no runner enrolled. `StartAgentSession` returns
  `Unavailable` carrying `ErrMsgNoRunnerEnrolled` over HTTP.
- **gateway relay.** Uses `newE2EWire`: a real AgentGateway socket, gateway,
  `RunnerService` and hub. The agent client sees upstream `FailedPrecondition`
  (unbound session), `Unavailable` and `Unimplemented` with the same message.
- **comms → runnerhub.** Uses the real comms. The relay envelope carries
  `not_found` for an unknown handle.
- **Read limits.**
  - A socket-door `PutAgentConfig` above 4 MiB succeeds.
  - The Runner receives a `Sessions` resume body above 4 MiB.
  - An over-limit AgentGateway `Publish` frame returns `ResourceExhausted`.
- **Code changes.** Fix the mint error. Set the door limits in `buildDoors`.

Interfaces:

- `(*Hub).Start` keeps its signature. The mint failure binds
  `wrapped := fmt.Errorf("minting fresh session id: %w", err)` and returns
  `connect.NewError(connect.CodeInternal, wrapped)`.
- `buildDoors` keeps its signature.

Files:

- `go/server/rpc_contract_test.go`
- `go/server/relay_status_e2e_pgtest_test.go`
- `go/internal/runnerhub/relay_code_integration_pgtest_test.go`
- `go/server/socket_door_read_limit_test.go`
- `go/internal/runner/sessions_read_limit_test.go`
- `go/internal/runner/gateway/publish_read_limit_test.go`
- `go/internal/runnerhub/commands.go`
- `go/server/serve.go`

### PR 2: `refactor(compass-go): keep wrapped causes through the v2 port`

Reshape the 63 `connect.NewError(code, <call>)` sites whose cause the tool
would drop. The tool's output then matches the Errors constraint, and
`errors.Is` chains survive. Each site binds the wrapped error to a local and
passes the identifier. Messages stay byte-identical.

Interfaces: none change.

Files (sites per file):

| File | Sites |
|---|---|
| `go/server/lifecycle.go` | 12 |
| `go/internal/guestd/supervisor.go` | 9 |
| `go/server/usage_service.go` | 6 |
| `go/server/service.go` | 5 |
| `go/server/secrets_service.go` | 5 |
| `go/server/agent_repository_service.go` | 5 |
| `go/server/forge_mirror_settings_service.go` | 4 |
| `go/server/service_tour.go` | 3 |
| `go/internal/runnerhub/session_blobs.go` | 3 |
| `go/internal/comms/board.go` | 3 |
| `go/internal/runnerhub/handler.go` | 2 |
| `go/internal/runnerhub/bind_lifetime.go` | 2 |
| `go/internal/comms/mapping.go` | 2 |
| `go/server/board.go` | 1 |
| `go/server/spawn.go` (`ctx.Err()`) | 1 |

### PR 3: `build(compass-go): otelconnect v0.12.0`

Still the v1 API. The changes otelconnect v0.10+ brings:

- It removed `WithoutTraceEvents`, along with every per-message span event, so
  RIG-5186's `gateway.Serve` call to it goes away with no change in behaviour.
- `WithFilter` still returns `next` before any span or metric state. RIG-5186's
  metrics-loss analysis holds, and its chosen option (b) does not use
  `WithFilter`.
- The semantic-convention renames apply (`rpc.server.duration` →
  `rpc.server.call.duration`). No compass file names the old metrics. Check
  dashboards and alerts outside compass in the same window.

Close #2310.

Interfaces: `gateway.Serve` builds `otelconnect.NewInterceptor()` with no
options.

Files:

- `go/internal/runner/gateway/gateway.go`
- `go/go.mod`, `go/go.sum`
- `flake.nix`, `guest-image/default.nix`

### PR 4: `feat(compass-go): move to connect-go v2`

The three-commit flip. Commit 3 holds:

- the plugin derivation;
- `grpchealth/v2`;
- `relayedError` at the 7 relay sites;
- the codec port (`ackBoundCodec` reads `src` whole within the read limit and
  then pre-scans; `frameJSONCodec` wraps `connectproto`'s JSON codec);
- typed bidi streams in `guestd` and `microvm`;
- the interceptor table above;
- client limits per Q3;
- a depguard deny on `connectrpc.com/connect$` and `connectrpc.com/grpchealth$`
  (exact match; `/v2` stays allowed);
- README and `proto/moon.yml` plugin notes;
- the `vendorHash` refresh.

Interfaces:

- `relayedError(err error) error`, in
  `internal/runner/gateway/relay_error.go`. It returns `err` unless
  `errors.AsType[*connect.Error]` finds one with `IsRemote()`. In that case it
  returns `connect.NewError(e.Code(), e.Message())` plus each detail, then
  `.WithCause(err)`.
- `runnerhub.Mount(mux connecthttp.ServeMux, hub *Hub, resolve TokenResolver, resolver secretResolver, configStore AgentConfigStore, otelIC connect.ServerInterceptor)`
  replaces `NewMountedHandler`.
- `auth.BearerInterceptor(st *store.Store) connect.ServerInterceptor`.
- `auth.AmbientIdentity(account store.AccountID) connect.ServerInterceptor`.
- `auth.NewAdminGate(admin store.AccountID) connect.ServerInterceptor`.
- `auth.ServiceBearerInterceptor(...) connect.ServerInterceptor`.
- `otel.NewTraceResponseInterceptor() connect.ServerInterceptor`.
- `otel.NewSessionIDInterceptor() connect.ServerInterceptor`.
- `sessionIDFromHeader(h *connect.Header) string`.
- `RunnerConfig.HTTPClient connecthttp.HTTPClient`.
- `runner.NewCATrustClient(caPath string) (connecthttp.HTTPClient, error)`.
- `httpClientFor(cfg connConfig) (connecthttp.HTTPClient, error)`.
- `bearerToken(token string) connect.ClientInterceptor`.
- `agentGatewayHandlerOptions() []connecthttp.Option`.
- `serverHealth` holds a `*connect.Server`.
- `BearerStreamInterceptor` and `AmbientStreamInterceptor` are deleted.

Files:

- every file that imports `connectrpc.com/connect`, `grpchealth` or
  `otelconnect` at port start
- `go/gen/**`, `go/internal/gen/**`
- `buf.gen.yaml`, `buf.gen.internal-go.yaml`
- `devenv.nix`
- `tools/toolchain/{protoc-gen-connect-go.nix,gate-tools.nix}`
- `tools/renovate/refresh-fod-hashes.ts`
- `go/.golangci.yml`
- `README.md`, `proto/moon.yml`
- `go/go.mod`, `go/go.sum`, `flake.nix`, `guest-image/default.nix`

## Tasks

- [ ] Matt answers Q1–Q3.
- [ ] Gate: both in-flight lines merged; importers re-counted; counts in this
  record updated.
- [ ] PR 1: real-boundary contract tests, mint-error fix, socket-door limits.
- [ ] PR 2: 63 cause-dropping `NewError` sites reshaped.
- [ ] PR 3: otelconnect v0.12.0, `WithoutTraceEvents` dropped, #2310 closed.
- [ ] PR 4: both lanes on v2 (plugin, relay errors, codec, streams,
  interceptors, grpchealth/v2, depguard).

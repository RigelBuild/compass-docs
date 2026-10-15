# Compass connect-go v2 migration

## Open Questions

The questions are independent.

**Q1. Stack shape.** Compass generates two stub lanes, public and internal.
Two facts break a stack that flips one lane at a time:

- **The tool decides readiness per file** (`discover.go`:
  `ready := !importsV1Stub(file, v1StubPkgs)`), so it rewrites early a file
  that uses stub types without importing a stub package, and the build breaks
  against the other lane. Example:
  [`internal/comms/agent_caller.go`](https://github.com/RigelBuild/compass/blob/main/go/internal/comms/agent_caller.go)
  calls the v1 public handler with `connect.NewRequest(req)`.
- **v1 and v2 `*connect.Error` cannot see each other.** v1's `asError` finds
  only a v1 `*Error`. v2's `CodeOf` uses `errors.AsType[*Error]` and finds
  only a v2 one. Mid-stack, an error that crosses from one major to the other
  arrives as `Unknown`. This happens at hub → server (`s.hub.Start` returned
  by v1 `CompassService` handlers), at comms → runnerhub (`commsCallError` and
  the board, forge and lifecycle envelopes), and in `classifyEnrollProbe`.

Options:

- (a) One code PR flips both lanes. It keeps the three-commit split.
- (b) Two lane PRs. Each runs the tool on explicit package roots. A temporary
  bridge between the error types covers both boundaries until the second lane
  lands.

**Recommendation:** (a). See Alternatives considered.

**Q2. Relayed errors.** Six runner-gateway handlers return the Server's error
to the agent unchanged: `Board`, `Forge`, `Comms`, `Lifecycle`,
`PostConversationFrame` and `PutSessionBlob` (`go/internal/runner/gateway/`).
The publisher's upstream `Send` is a seventh path. Their doc comments promise
"every status unchanged".

In v2, a client marks every error it decodes as remote. connecthttp's
`scrubHandlerError` turns a remote error that a handler returns into
`CodeInternal` with no message. The agent branches on codes that would
collapse to `Internal`:

- `relayCall` in
  [`relay-error.ts`](https://github.com/RigelBuild/compass/blob/main/packages/compass-agent/src/relay-error.ts)
  branches on `FailedPrecondition` and `Unavailable`.
- `session-blobs.ts` branches on `Unimplemented`.

Client-side classifiers, such as `CodeOf` in `internal/runner/run.go`, still
read a remote error's code. Only a handler that returns one needs a fix.

Options:

- (a) A gateway helper, `relayedError`, re-authors a remote error as a local
  one with the same code, message and details. The Server's messages then
  become an explicit contract with the agent.
- (b) Accept the scrub. The agent loses its unbound-session, retry and
  blob-fallback handling.
- (c) Report relay failures in the response body. This changes the proto of
  both lanes.

**Recommendation:** (a). Decision needed: may the gateway keep passing
Server-authored error text to the agent?

**Q3. Client read limits.** v1 has no per-message read limit. v2 defaults to
4 MiB on clients and on handlers. The server side is settled under Read
limits. On the client side, one read has no bound today: the Runner's
`Sessions` stream, which carries `ResumeBody.session_body`.
`ReconstructSessionBody` puts no limit on that body. Session-blob frames are
not at risk, because the hub sends them in `configChunkBytes` (512 KiB)
chunks.

Options:

- (a) Every client pins `WithReadMaxBytes(0)`, as the tool emits. This keeps
  v1 behaviour.
- (b') As (a), but the Runner's `Sessions` read gets a limit (code below), so
  a misbehaving Server cannot exhaust a Runner's memory. Cost: a legitimate
  resume above the limit fails, because nothing bounds the body on the Server.
- (b) A named limit on every client.
- (c) Take the 4 MiB default. Resumes above 4 MiB break.

```go
// (b'): commit 3 replaces the tool's bare zero pin on the Runner transport.
// The client transport resolves options per call through options.forSpec,
// which clones the base options and then applies each conditional, so the
// Sessions limit overrides the zero for that procedure only.
connecthttp.NewTransport(httpClient, cfg.ServerAddr,
	connecthttp.WithReadMaxBytes(0),
	connecthttp.WithConditionalOptions(func(spec connect.Spec) []connecthttp.Option {
		if spec.Procedure == compassv1internalconnect.RunnerServiceSessionsProcedure {
			// new const in internal/runner/runner.go, equal to runnerhub's runnerMaxReadBytes
			return []connecthttp.Option{connecthttp.WithReadMaxBytes(resumeMaxReadBytes)}
		}
		return nil
	}),
)
```

**Recommendation:** (a). The port should not add a new failure mode, and the
Runner already authenticates its Server. Decision needed: is an unlimited
`Sessions` read acceptable?

## Problem / Intent

Tracking: RIG-5471

Ledger-impact: none until the rulings.

Paths below are in RigelBuild/compass unless they name another repo. Counts
were taken at compass `main` `12489a0c`.

Compass's Go backend uses connect-go v1: `connectrpc.com/connect` v1.20.0 in
[`go/go.mod`](https://github.com/RigelBuild/compass/blob/main/go/go.mod). At
`12489a0c`, 266 Go files import it: 9 generated, and 257 hand-written (85
production, 172 test). The service owner counts 268 at `22d9fc0a`.

Matt ruled to move to `connectrpc.com/connect/v2` v2.0.1. Renovate cannot do
it: [compass#2310](https://github.com/RigelBuild/compass/pull/2310) bumped
only the `require` line, and `compass-go:tidy` (`go mod tidy -diff`) failed
because no file imports v2.

## Approach

**Shape.** Preparatory PRs stay on v1. Then one code PR moves both stub lanes
together (Q1):

- **public:** `buf.gen.yaml` writes `go/gen/.../compassv1connect` with 5
  services: Compass, Secrets, AgentRepository, Comms and Usage.
- **internal:** `buf.gen.internal-go.yaml` writes `compassv1internalconnect`
  with 6 services: AgentGateway, GatewayAuth, GatewayCredentials,
  GatewayRegistry, GuestControl and RunnerService.

Package `server` imports both stub packages, and `network_door.go` imports
both. The preparatory PRs move what the tool handles badly onto v1, so the
flip's hand-edit commit stays small.

**Flip mechanics.** The flip PR has three commits:

1. Regenerate both lanes.
2. Run `connect-go-v2-migrate -w` (v1.0.0) once from `go/` with
   `GOFLAGS=-tags=pgtest,podman,microvm`. Without the tags, `go/packages`
   skips 89 tagged importers. Commit the output unedited.
3. Hand edits for everything the tool flags.

A scratch trial made 167 rewrites and flagged 59 files. Its only build
failures were in planned hand work: typed streams in `guestd`, `microvm` and
`comms/subscribe.go`.

**Ecosystem modules.**

- `otelconnect` v0.12.0 is the only release that supports both majors. It
  keeps v1's `NewInterceptor` and adds `NewServerInterceptor` and
  `NewClientInterceptor`. After the flip, v1 stays in `go.mod` only as
  `// indirect`, through otelconnect.
- `grpchealth` moves to `connectrpc.com/grpchealth/v2` v2.0.0, which provides
  `Register(*connect.Server, Checker)`.
- `connectrpc.com/cors` v0.1.0 has no connect dependency and stays.

### API mapping

Uses are counted as production / test, in hand-written files.

| v1 symbol | Uses | v2 | How |
|---|---|---|---|
| `NewError(code, err)` | 383 / 73 | `NewError(code, msg string)`. Identifier argument (174 prod) → `NewError(code, err.Error()).WithCause(err)`. `%w`-free `fmt.Errorf` (31) → `Errorf(code, …)`. `fmt.Errorf("…%w")` (62) → `NewError(code, fmt.Errorf(…).Error())` with no cause, so PR 2 reshapes those first. | tool |
| `Code*`, `Code`, `CodeOf` | 498+ / 889+ | unchanged | — |
| `Request[T]`, `NewRequest` | 164 / 757 | plain `*T`; headers through `NewClientContext` / `CallInfoForServerContext` | tool (35 metadata warnings) |
| `Response[T]`, `NewResponse` | 198 / 180 | plain `*T` | tool |
| `UnaryFunc`, `UnaryInterceptorFunc`, `AnyRequest`, `AnyResponse` | 57 / 55 | `ServerInterceptor` / `ClientInterceptor` | hand |
| `Interceptor`, `StreamingHandlerFunc`/`Conn`, `StreamingClientFunc`/`Conn` | 38 / 22 | `ServerInterceptor` / `ClientInterceptor` | hand |
| `WithInterceptors` | 18 / 14 | positional arguments to `NewServer` / `NewClient`; v2 accepts no v1 option or interceptor | hand |
| `WithReadMaxBytes`, `HandlerOption` | 14 / 1 | `connecthttp.WithReadMaxBytes`, `connecthttp.Option` | tool |
| `WithCodec`, `Codec` | 4 / 0 | `connecthttp.WithCodecs`; `Codec` gets `MarshalWrite` / `UnmarshalRead(ctx, io…)` | hand |
| `HTTPClient` | 5 / 0 | `connecthttp.HTTPClient` | hand |
| `ServerStream`, `BidiStream`, `ClientStream` | 14 / 32 | generated `<Svc><Rpc>ServerStream` structs | partial (14 warnings) |
| `ServerStreamForClient`, `BidiStreamForClient`, `ClientStreamForClient` | 12 / 23 | generated `<Svc><Rpc>ClientStream` structs | tool |
| `Spec` (`req.Spec()`, `conn.Spec()`) | 3 / 5 | the `spec` argument of `ServerFunc` | hand |
| `Error` | 3 / 32 | `*Error`, plus `IsRemote` and `WithCause` | — |
| test only: `WithGRPC`, `WithProtoJSON`, `Peer`, `NewServerStreamHandler`, `NewClient`, `StreamTypeServer` | 0 / 9 | `connecthttp.WithGRPC` / `WithProtoJSON`, `CallInfo.PeerAddr`, `Server.Register`, `connect.NewClient(transport)` | hand |

There are 11 handler interfaces and 96 procedures. The procedure count is a
snapshot: it counts the `Procedure = "/` constants in the 9 generated
`*.connect.go` files at `12489a0c`, 64 public and 32 internal. It splits into
86 unary, 6 server-stream, 2 client-stream and 2 bidi.

- `New<Svc>Handler` (61 uses) becomes `Register<Svc>Handler(srv, impl)` plus
  `connecthttp.Mount(mux, srv, opts...)`.
- The `*Procedure` constants (150 uses) keep their names.

### Construction sites

| Kind | Sites |
|---|---|
| Server mounts | `buildNetworkServer` and `mountGatewayServices` (`server/network_door.go`); `buildDoors` (`server/serve.go`); `newServerHealth` (`server/health.go`); `NewMountedHandler` (`internal/runnerhub/handler.go`); `gateway.Serve`; the vsock mount (`internal/guestd/vsock.go`) |
| Clients | `cmd/compass/client.go` (4), `cmd/compass-app/bridge_service.go`, `e2e/clients.go` (3), `internal/embedded/embedded.go`, `internal/runner/runner.go`, `internal/runnertest/socket.go`, `internal/runtime/microvm/dial.go`, `internal/stack/adapters/health.go` |
| Direct handler calls | `internal/comms/agent_caller.go`, `server/spawn.go` (the tool strips `NewRequest`) |

Each v1 `New<Svc>Handler` mount becomes one `*connect.Server` that carries the
door's interceptor chain. It is mounted with that service's read limit.

v2 runs interceptors in argument order, first one outermost, as v1 does, so
AdminGate-before-ambient and otelconnect-first carry over. `Server.Call`
answers an unregistered method with `CodeUnimplemented` before any interceptor
runs. v1 answered with HTTP 404, which clients read as `Unimplemented`.

Clients are built as below:

```go
compassv1connect.NewCompassServiceClient(connect.NewClient(
	connecthttp.NewTransport(httpClient, serverURL, connecthttp.WithReadMaxBytes(0)),
	bearerToken(token),
))

// v2 client interceptors wrap stream opening, which covers unary and streaming
// calls alike. The header is the only change, so the returned ClientStream is
// passed through unwrapped.
func bearerToken(token string) connect.ClientInterceptor {
	return func(next connect.ClientFunc) connect.ClientFunc {
		return func(ctx context.Context, spec connect.Spec) (connect.ClientStream, error) {
			info, ok := connect.CallInfoForClientContext(ctx)
			if !ok {
				return nil, connect.NewError(connect.CodeInternal, "bearer token: no client call info")
			}
			info.RequestHeader().Set("Authorization", "Bearer "+token)
			return next(ctx, spec)
		}
	}
}
```

The Runner's `bearerTokenFrom(source TokenSource)` has the same shape. It
calls `source.Token()` before `next` and returns any error unchanged. Unary
calls already do this. For streams, v1 opens `Sessions` or `PublishEvents`
without the header after a token error and the Server answers
`Unauthenticated`. In v2 the open fails locally. The client is
`connect.NewClient(transport, otelClientIC, bearerTokenFrom(cfg.Token))`.

### Interceptor ports

| Interceptor | v2 port |
|---|---|
| `auth.BearerInterceptor` + `BearerStreamInterceptor` | one `BearerInterceptor(st) connect.ServerInterceptor`, reading `CallInfoForServerContext(ctx).RequestHeader()`; the stream twin is deleted |
| `auth.AmbientIdentity` + `AmbientStreamInterceptor` | one `AmbientIdentity(account) connect.ServerInterceptor`; the twin is deleted |
| `auth.AdminGate` | `NewAdminGate(admin) connect.ServerInterceptor`, checking `spec.Procedure` |
| `auth.ServiceBearerInterceptor` | same parameters, returns `connect.ServerInterceptor` |
| runnerhub `bearerAuth` unary + stream | one `interceptor() connect.ServerInterceptor` |
| `otel.NewTraceResponseInterceptor` | wraps the unary stream and sets `traceresponse` before the first `Send`. The v2 unary adapter sends inside `next`, so a header set after `next` returns is never sent. Errors still carry no header. |
| `otel.NewSessionIDInterceptor` | reads the request header from `CallInfo` |
| `otelconnect.NewInterceptor` | `NewServerInterceptor` in `serve.go` and `gateway.Serve`; `NewClientInterceptor` in `runner.go` |
| client `bearerToken` | code above |

### Error behaviour audit

In v2, only a locally created `*connect.Error` reaches the client with its
code and message. A plain error goes out as `CodeUnknown` and a remote error
as `CodeInternal`, both with no message. Context errors keep their codes. A
type-resolved trace followed each handler's returned errors back to where they
were created:

| Origin | v1 today | v2 unfixed | Plan |
|---|---|---|---|
| 6 relay forwards + publisher upstream `Send` | upstream code and message | `Internal`, no message | Q2 (a) `relayedError` |
| `(*Hub).Start` mint branch, `fmt.Errorf("minting fresh session id: %w")` | `Unknown` with text | `Unknown`, no message | Unreachable: since Go 1.24, `crypto/rand.Read` "never returns an error" and crashes instead. PR 1 makes the mint infallible, as `store/ids.go` does, so no error path is left to port. |
| `Send` / `Receive` / `Err` in the 8 streaming handlers: `SubscribeEvents`, `SubscribeComms`, `Publish`, `Control`, `Sessions`, `PublishEvents`, `FetchAgentConfig`, `FetchSessionBlobs` | see the next table | see the next table | PR 1 pins the over-limit cases |

These handlers only touch their own server-side stream, which never decodes a
peer's error. Their errors come from `envelope.go` (v1) and
`connecthttp/envelope.go` (v2):

| Failure | Code | Message (v1 and v2) |
|---|---|---|
| marshal | `Internal` | `marshal message: …` |
| write | `Unknown` | `write envelope: …` |
| unmarshal | `InvalidArgument` | `unmarshal message: …` |
| read | `Unknown` | `read enveloped message: …` |
| over read limit | `ResourceExhausted` | `message size N is larger than configured max M` |
| over send limit | `ResourceExhausted` | `message size N exceeds sendMaxBytes M` |
| context done | `Canceled` / `DeadlineExceeded` | from `wrapIfContextDone` |

Both majors create these locally, so the scrub keeps them, with the same text.

Every other origin is already a `*connect.Error`, and the tool keeps its text.
These message contracts survive:

- `invalid agent token` (`errGatewayTokenInvalid`, `server/gateway_auth.go`).
  The gateway agent verifier maps it to 401. It stays pinned by
  `TestVerifyAgentTokenInvalidIsUnauthenticated` and the string check in
  `gateway_credentials_service_test.go`. v2's `Error()` keeps the
  `code: message` format.
- `ErrMsgNoRunnerEnrolled` and `ErrMsgNoSessionsStream`, which
  `classifyEnrollProbe` matches.
- The envelope code tokens. Under Q1 (a), `commsCallError`, `boardCallError`,
  `forgeCallError`, `lifecycleCallError` and every caller that feeds them move
  to v2 in the same commit, so `CodeOf` sees v2 errors.

`classifyConnectErr` still reaches the TLS error, because v2 transport failures
attach it with `WithCause`. TS clients branch only on codes.

### Read limits

| Mount | v1 | Plan |
|---|---|---|
| `buildNetworkServer` CompassService / siblings / GatewayAuth | 128 MiB / 16 MiB / 4 KiB | same constants on `Mount` |
| RunnerService, AgentGateway, GuestControl, health | `runnerMaxReadBytes`, `maxAgentMessageBytes`, 16 MiB, 1 KiB | same values on `Mount` |
| `buildDoors` socket and dev doors: CompassService (carries `PutAgentConfig`) / siblings | unlimited | PR 1: `compassServiceMaxReadBytes` (128 MiB) / `siblingServiceMaxReadBytes`, as in `buildNetworkServer` |
| 11 clients | unlimited | per Q3 |

### Codegen plugin

Decision: one plugin swap in the flip PR, built from compass's own module
graph. `go get -tool connectrpc.com/connect/v2/cmd/protoc-gen-connect-go@v2.0.1`
adds the `tool` line. The plugin lives in the connect/v2 root module, so its
version is go.mod's library version by construction. `subPackages` cannot
name a dependency package, so `buildPhase` runs `go install`, and the default
`installPhase` copies `$GOPATH/bin`. buildGoModule already adds `-trimpath` and
sets `GOPROXY=file://$goModules`. The module FOD covers the whole `go/` graph,
so its hash is the existing `vendorHash`, kept in step through `mirrorFiles` in
`refresh-fod-hashes.ts`.

```nix
# tools/toolchain/protoc-gen-connect-go.nix
{ pkgs, goToolchain }:
(pkgs.buildGoModule.override { go = goToolchain; }) {
  pname = "protoc-gen-connect-go";
  version = "go-mod"; # the binary reports go.mod's connect/v2 version
  src = builtins.path { path = ../../go; name = "compass-go-src"; };
  proxyVendor = true;
  vendorHash = "sha256-e0IMARv5yIRFob2wUYTLTgcQPGy02mQZ7AjobkhHeD4="; # mirror of guest-image/default.nix
  doCheck = false; # src is all of compass go/; its tests run elsewhere
  buildPhase = ''
    runHook preBuild
    go install -ldflags=-buildid= connectrpc.com/connect/v2/cmd/protoc-gen-connect-go
    runHook postBuild
  '';
}
```

The binary keeps its name, so generated headers stay byte-identical.
`devenv.nix` drops the nixpkgs attribute and appends the derivation outside
the parsed `with pkgs` list, as it does for `goAnalysis`. Cost: the dev shell
refetches compass's modules after each `go.sum` change.

### Test strategy

The `httptest` and h2c harnesses (75 files) stay. They assert limits, codecs,
CORS, headers, interceptor order and error shape, all of which
`connectinprocess` bypasses. PR 1's contract tests run on v1 and must pass
unchanged after the flip.

## Alternatives considered

- **Two lane PRs (Q1 b).** Pro: the internal lane is reviewed alone. Con:
  package roots re-derived per rebase, a throwaway error bridge, and a second
  plugin binary mid-stack.
- **One code PR (Q1 a).** Pro: no mixed types or bridge; reviewers reproduce
  commits 1–2 and read commit 3. Con: every rebase repeats commits 1–3.
- otelconnect v0.11.0. Rejected: v2-only.
- The nixpkgs plugin. Rejected: plugin and library versions would drift.

## Global Constraints

- **Collision gate (ruled).**
  - The code stack starts after the board line (#2290 → #2292 → #2300) and
    the RIG-5186 line (#2255 → #2259 → #2262 → #2265 → #2267 → #2268 → #2269
    → #2270) merge. Until then, no rebase or regen against them.
  - Forge #2313–#2316, #2243, #2233 and #2312 do not overlap.
  - At port start, re-count importers and procedures, re-run the scratch
    migration, and update this record.
- **No repo-wide freeze, and its costs.** Other go/ PRs keep landing. The flip
  PR absorbs them by repeating commits 1–3 at each rebase.
  - Each `go.sum` move on `main`, including Renovate gomod bumps, conflicts
    with the shared `vendorHash` line in PRs 3–4. Re-run the refresh script.
  - Every push resets Matt's approval, and `reviewDecision: APPROVED` can
    survive a push, so re-request review on each new head.
  - Open the flip for review only after PRs 1–3 merge.
- **Per-PR gate.** Every PR passes
  `moon run compass-go:tidy compass-go:vet compass-go:test compass-go:lint compass-proto:drift compass-proto:gen-fence`
  and the pgtest CI job.
- **Pins.** `connectrpc.com/connect/v2` v2.0.1, `grpchealth/v2` v2.0.0,
  `otelconnect` v0.12.0, migrate tool v1.0.0, go 1.26.0.
- **Contracts.** The wire protocol, procedure names, and every code and
  message in the audit tables stay byte-identical. No proto edits. One
  exception: a Runner stream whose token source fails now fails before it
  opens, instead of reaching the Server and drawing `Unauthenticated`.
- **Errors.** A `NewError` argument is an identifier, a string, `errors.New`,
  or a `%w`-free `fmt.Errorf`. It is never a `%w` call. For an identifier
  `err`, the tool emits `NewError(code, err.Error()).WithCause(err)`. The code
  is kept, and the message is the same bytes v1 sent, which for a wrapped
  error includes the inner text. `WithCause` keeps `errors.Is` working on the
  Server and is never sent to clients.
- **Public repo boundary.** PR text cites compass paths only.

## Plan

### PR 1: `fix(compass-go): pin RPC contracts and cap socket-door reads`

Stays on v1. Every test crosses a real boundary.

- **hub → server.** A real `CompassService` handler with `runnerhub.NewHub` and
  no runner enrolled. `StartAgentSession` returns `Unavailable` carrying
  `ErrMsgNoRunnerEnrolled` over HTTP.
- **Gateway relay.** Uses `newE2EWire`, which provides a real AgentGateway
  socket, gateway, `RunnerService` and hub. The agent client sees upstream
  `FailedPrecondition`, `Unavailable` and `Unimplemented` with the same
  message.
- **Envelopes.** A hub from `newRunnerHub` plus `wireHubServiceCycles` and
  `SetForgeCaller`, as `serve.go` assembles it. `RelayCommsCall`,
  `RelayBoardCall`, `RelayForgeCall` and `RelayLifecycleCall` return the
  exact code token and message for a not-found case and an invalid-argument
  case. These tests pin `commsCallError`, `boardCallError`, `forgeCallError`
  and `lifecycleCallError`.
- **Read limits.**
  - A socket-door `PutAgentConfigRequest` with `proto.Size` equal to
    `compassServiceMaxReadBytes` is not `ResourceExhausted`. One byte more
    is.
  - The Runner receives a `Sessions` resume body above 4 MiB.
  - An over-limit AgentGateway `Publish` frame returns `ResourceExhausted`.
- **Code.**
  - Make the session-id mint infallible: `mintFreshSessionID() string`, and
    the `Hub.freshSessionID` field becomes `func() string`. `Start`'s mint
    error branch goes away.
  - Set the door limits in `buildDoors`, which keeps its signature.

Files:

- `go/server/rpc_contract_test.go`
- `go/server/relay_status_e2e_pgtest_test.go`
- `go/server/relay_envelope_pgtest_test.go`
- `go/server/socket_door_read_limit_test.go`
- `go/internal/runner/sessions_read_limit_test.go`
- `go/internal/runner/gateway/publish_read_limit_test.go`
- `go/internal/runnerhub/{commands,hub}.go`
- `go/server/serve.go`

### PR 2: `refactor(compass-go): keep wrapped causes through the v2 port`

The 62 `NewError(code, fmt.Errorf("…%w"))` sites, plus `spawn.go`'s
`NewError(CodeCanceled, ctx.Err())`, each bind the error to a local and pass
the identifier. The client then gets the full `fmt.Errorf` text, the same as
in v1, and the cause stays local. The 31 `%w`-free sites and the 174
identifier sites need no change.

Interfaces: none change.

| File | Sites |
|---|---|
| `go/server/lifecycle.go` | 12 |
| `go/internal/guestd/supervisor.go` | 9 |
| `go/server/usage_service.go` | 6 |
| `go/server/{service,secrets_service,agent_repository_service}.go` | 5 each |
| `go/server/forge_mirror_settings_service.go` | 4 |
| `go/server/service_tour.go`, `go/internal/runnerhub/session_blobs.go`, `go/internal/comms/board.go` | 3 each |
| `go/internal/runnerhub/{handler,bind_lifetime}.go`, `go/internal/comms/mapping.go` | 2 each |
| `go/server/board.go`, `go/server/spawn.go` | 1 each |

### PR 3: `build(compass-go): otelconnect v0.12.0`

otelconnect v0.10+ changes, still on the v1 API:

- `WithoutTraceEvents` is removed, along with all per-message events.
  RIG-5186's `gateway.Serve` call goes, and behaviour does not change.
- `WithFilter` still returns `next` before any span or metric state is
  created, so RIG-5186's metrics-loss analysis holds.
- Semconv renames, such as `rpc.server.call.duration`. No compass file uses
  the old names. Check outside dashboards and alerts in the same window.

Close #2310.

Interfaces: `gateway.Serve` builds `otelconnect.NewInterceptor()` with no
options.

Files: `go/internal/runner/gateway/gateway.go`, `go/go.mod`, `go/go.sum`,
`flake.nix`, `guest-image/default.nix`.

### PR 4: `feat(compass-go): move to connect-go v2`

This is the three-commit flip. Commit 3 holds:

- the plugin derivation;
- `grpchealth/v2`;
- `relayedError`;
- the codec port (`ackBoundCodec` reads `src` within the limit, then
  pre-scans it; `frameJSONCodec` wraps `connectproto`'s JSON codec);
- typed bidi streams;
- the interceptor ports;
- the client limits from Q3;
- a depguard deny on `connectrpc.com/connect$` and `connectrpc.com/grpchealth$`;
- README and `proto/moon.yml` plugin notes;
- the `vendorHash` refresh.

Interfaces:

- `relayedError(err error) error` (`internal/runner/gateway/relay_error.go`).
  It returns `err` unless `errors.AsType[*connect.Error]` finds an error with
  `IsRemote()`. In that case it returns
  `connect.NewError(e.Code(), e.Message())` with each detail added, then
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
- `bearerToken(token string) connect.ClientInterceptor`, in
  `cmd/compass/client.go` and `e2e/clients.go`.
- `bearerTokenFrom(source TokenSource) connect.ClientInterceptor`, in
  `internal/runner/runner.go`. The new `internal/runner/bearer_token_test.go`
  pins it: a unary call and a `Sessions` open with a failing source both
  return the source's error, and neither reaches the server.
- `RunnerConfig.HTTPClient connecthttp.HTTPClient`.
- `httpClientFor(cfg connConfig) (connecthttp.HTTPClient, error)`.
- `runner.NewCATrustClient(caPath string) (*http.Client, error)`. The concrete
  type is assignable to `connecthttp.HTTPClient`. Consumers:
  - `cmd/compass-runner/main.go`: `var httpClient connecthttp.HTTPClient`
  - `cmd/compass/client.go` `httpClientFor`
  - `e2e/clients.go` (2)
  - `e2e/forgestub_test.go` (2), which drops its `client.(*http.Client)`
    assertions
  - `internal/runner/tls_test.go`
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
- [ ] Gate: both lines merged; importers and procedures re-counted.
- [ ] PR 1: real-boundary contract tests, mint branch deleted, socket-door
  limits.
- [ ] PR 2: 63 cause-dropping `NewError` sites reshaped.
- [ ] PR 3: otelconnect v0.12.0, `WithoutTraceEvents` dropped, #2310 closed.
- [ ] PR 4: both lanes on v2.

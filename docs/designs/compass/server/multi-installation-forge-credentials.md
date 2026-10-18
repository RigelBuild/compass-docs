# Multi-installation forge credentials

Tracking: RIG-5653 (work; parent RIG-4898). Ruling: Matt, 2026-10-17, on RIG-4898: "we need to
support multiple installs in the product."

## Resolved decisions

Matt ruled on RIG-5672, 2026-10-18.

1. **OQ-1, wildcard scope: (b).** A `*` grant covers the default installation. Exact grants under
   other owners keep their own owner groups. `checkOrg` drops the wildcard rule from compass#2385,
   so a `*` agent can also hold `B/two`.
2. **OQ-2, issue edits: (c).** Issues go through the forge tools on the owner's installation, and a
   new `forge_edit_issue` tool edits title and body (DL-582). The brokered token keeps its
   permissions, so `gh issue create` and `gh issue edit` still fail. Matt asked whether an edit
   tool exists already. It does not. The issue tools are `forge_create_issue`,
   `forge_comment_on_issue` and `forge_transition_issue_state`, which only opens or closes.
   `Provider.EditComment` edits comments, not issues, and no tool exposes it.
3. **OQ-3, subscriptions and reviews: every installation.** "Everything needs to be supported on
   all installs." Board ingestion, the notify lane and the reviewer leg route by owner like the
   author leg (DL-564).
4. **OQ-4, mixed runners: none.** Server and runners cut over together, and dev can be wiped. The
   default credential is still emitted last, because `GHHostsScript` is last-wins and needs no
   change.
5. **OQ-5, gh: (b).** Only `compass-forge-credential token --repo` ships. The gh wrapper is
   RIG-5819.

## Problem / Intent

The GitHub App can be installed on many owners, and each installation mints tokens only for its
own owner's repositories. The dev author App shows the failure. Its RigelBuild installation
returns 422 for a token on a repository under a personal-account installation, and that account's
own installation returns 201. compass#2385 resolves an owner's installation, so an agent whose
grants all sit under one owner now works. One agent still cannot hold repositories under two
owners. This record makes the broker mint one token per owner, gives git and jj-vine the right
token for the repository they act on, and routes the forge tools through that owner's
installation.

## Approach

### Today

| Concern | Code today | Effect for two owners |
| --- | --- | --- |
| Grant check | `checkOrgFromGrants` in `go/server/agent_repository_service.go` returns "repository org differs from the agent's credential org" | The second owner is rejected |
| Broker scope | `gitCredentialScope` in `go/server/git_credential.go` returns `ok=false` for mixed owners | The owner-grants fallback serves only the owner's own grants |
| Mint routing | `credentialForRepos` calls `MintFor(owner, …)`, or `Mint` for the `*` key | One installation per agent |
| Wire | `brokeredSecretResolver.ResolveFor` appends one `ResolvedSecret{Name: GITHUB_APP_TOKEN, Kind: SecretGH, Host}` | One token per host |
| Container | `SecretMaterializer.Install` in `go/internal/runtime/secrets_materialize.go` sends every `SecretGH` to `GHHostsScript`, which writes `~/.config/gh/hosts.yml` and collapses duplicate hosts last-wins | One token per host |
| git | `/etc/gitconfig` in `agent-image/toolchain.nix` sets `helper = !gh auth git-credential` | Host-keyed |
| jj-vine | `tokenCommand = [gh, auth, token, --hostname, {host}]` in the same file | Host-keyed |
| Forge tools | `forgeService` calls `rf.author`, the one shared `*forge.GitHub` from `buildBoardWebhookWiring` in `go/server/serve.go` | The default installation writes every repository |

`installCredentials` in `go/internal/runtime/agent.go` is not a delivery path. It runs
`Workspace.CredentialSetupScript()`, and `BuildSpec` never sets `Workspace.Credentials`.

How each tool picks a token:

- **gh** (v2.100.0). The `auth git-credential` helper in `pkg/cmd/auth/gitcredential/helper.go`
  answers only `get`, with username `x-access-token`, from `cfg.ActiveToken(host)`. `ActiveToken`
  in `internal/config/config.go` reads `GH_TOKEN`, `GITHUB_TOKEN` and the two enterprise names
  first, then `hosts.yml`, then the keyring. The host is the only key, so
  `credential.useHttpPath` does not help while gh is the helper.
- **git**. Git ignores the URL path for helpers unless `credential.useHttpPath` is set. Each
  helper is tried in turn until one returns a username and password. A helper that returns
  `quit=1` ends the lookup (gitcredentials(7), git-credential(1)).
- **jj-vine** (RigelBuild/jj-vine at the image pin). `GitHubConfig::token_command_argv` in
  `src/config.rs` is "The `tokenCommand` argv with each `{host}` replaced by the web host."
  `GitHubForge::new_from_config` in `src/forge/github.rs` resolves the project from the remote
  before it calls `resolved_token()` once. The command gets no project and runs with no
  `current_dir`. `jj git push` goes through git's helper. gh-stack linking receives the same token
  as `GH_TOKEN` with `GH_REPO` set to the target project.

How the broker holds tokens. Entries are keyed by the sorted, lowercased grant list
(`owner/a,owner/b`, or `*`). A token refreshes 15 minutes before expiry, on a 10-second tick.
Concurrent mints for a key share one singleflight, under a shared limit of one mint per second
with a burst of 30. Rejected scopes are negative-cached: 30 seconds for a missing installation and
5 minutes for a mismatch. A replaced token is revoked 30 seconds later with
`DELETE /installation/token`, which authenticates as the token itself, so revoke needs no
installation id. When the agent's set is rejected, `credential` retries with the owner user's
grants alone, so an agent row never leaves the agent worse off than its owner ("Broker: widen
only" in the workstream repository source record). DL-466 serves an agent's last key only when
that key is inside its current grants. Rotation reaches the container through `RefreshSecrets` in
`go/internal/runner/host.go`, which re-materializes file and gh secrets live.

### Per-owner mint

The broker partitions an agent's grants by owner and runs today's per-key path once per owner
(DL-562). Each owner group keeps today's key shape, `owner/a,owner/b`, so the cache, negative
cache, singleflight, refresh and revoke stay per key. Only the agent-level maps change.

- `gitCredentialScope` becomes `gitCredentialScopes`. It returns one group per owner, sorted by
  owner, plus a `*` group when the union holds `*`. The only invalid input left is a malformed
  grant: not `*` and not exactly `owner/name`.
- `credentials` drops an exact group whose owner resolves to `DefaultInstallation()` while a `*`
  group exists, because `*` already covers it (OQ-1 (b)).
- The 500-repository cap (`gitCredentialMaxRepos`) applies per group, because GitHub's limit is
  per token.
- `credentials` serves each group independently. When owner X's group is rejected, it retries
  with the owner user's grants under X, if that set is non-empty and differs. This keeps "widen
  only" per owner. A group that still fails drops out, and the other groups are still served.
- `last` becomes `map[store.AccountID]map[string]string` (agent, then owner, then key). DL-466
  applies per owner: a failed mint for owner B can fall back only to B's last key, and only when
  that key is inside B's current group.
- `grantsChanged` keeps a served key only if it is inside the new group for its own owner. Every
  other path is unchanged: generation, signal and `queueRevoke`.
- `ResolveFor` appends one `ResolvedSecret` per credential. Each carries the new `Owner` field, an
  account login. The `*` group carries the default installation's login from
  `InstallationResolver.DefaultOwner`; `*` stays internal to grouping, caching and the mint. The
  **default credential** is the `*` group, else the group on
  `DefaultInstallation()`, else the first group by owner. It is appended last, so last-wins
  `GHHostsScript` puts it in `hosts.yml`.

Each owner costs one mint per refresh. A 20-owner agent adds 20 mints per hour, which fits the
shared limiter.

### Agent-side delivery

The runner writes every per-owner token to its own file. A small Go helper in the image answers
git and jj-vine from those files by repository owner, and fails closed for an owner it cannot
serve (DL-563).

- **Wire.** `ResolvedSecret` gains `owner` (field 8, set only for a brokered `SECRET_KIND_GH`).
  `secrets.ResolvedSecret` gains `Owner`, and the handler and fetch mappings copy it.
- **Container layout.** `Install` writes each owner token to `~/.compass/forge/<host>/<owner>`
  (mode 0600, owner lowercased, written atomically), and deletes owner files that are no longer
  in the set. Beside them it writes `.default-owner`, which holds the account login of the
  installation behind the default credential. For a `*` group the broker sets `owner` to the
  default installation's login, found by reverse lookup in the resolver's snapshot, so the marker
  always names one owner. A GitHub login cannot start with a dot, so the marker cannot collide
  with an owner file.
  `GHHostsScript` is unchanged, so `hosts.yml` holds the default credential.
- **Helper.** A new command, `compass-forge-credential`, is a static Go binary.
  - `git-credential get` reads git's helper input. With `useHttpPath`, the input carries
    `path=owner/repo.git`. With an owner file, the helper prints `username=x-access-token` and
    the token. For the default owner or a request with no path, it prints nothing, and git
    falls through to `gh auth git-credential` and `hosts.yml`. For any other owner it
    prints `quit=1` and names the owner on stderr.
  - `token --host H [--repo owner/name]` follows the same rules. A refused owner exits non-zero
    with "no credential for owner X", which jj-vine reports as a token-command failure.
- **Image.** In `/etc/gitconfig`, `useHttpPath = true` is set, the helper comes first, and gh's
  helper second. The jj-vine `tokenCommand` becomes
  `[compass-forge-credential, token, --host, {host}, --repo, {project}]`.
- **jj-vine.** `token_command_argv` gains a `{project}` placeholder, replaced with
  `target_project()`. The PR is opened on the target repository, so that is the token the call
  needs. If `{project}` is used with no project resolved, it fails with a config error, as `{host}`
  already does.

The helper is Go because the runner's writer and the helper's reader share one layout package,
`go/internal/forgecred`. That package is new: the path contract needs a single owner that
`go/internal/runtime` can import without the helper pulling in the runtime. git calls the helper on
every fetch and push, so a static binary also avoids starting the agent's bun bundle each time.
The repository bars real logic in shell scripts, and a Go binary keeps the image free of it.

### Forge calls

Every forge call routes by repository owner (DL-564). A router implements `forge.Provider` and
the read interfaces the board and notify lanes use. Every one of those methods takes `repo`, so the
router is a drop-in for the shared `*forge.GitHub`.

- The default installation uses the existing shared primary client. Board, notify and author
  calls on that installation keep one RIG-2991 rate gate.
- Another installation gets its own `NewAppTokenSource` and `NewGitHub`, built on first use and
  cached by installation id. Each has its own rate gate, because GitHub budgets per installation.
- `Name`, `BodyLimit` and `AppLogin` delegate to the primary client. The App's bot login is the
  same on every installation, so `forge_mirror`'s identity check is unchanged.
- The router wraps resolver errors in `forge.ErrInstallationLookup`. `mapForgeError` classifies
  them with `checkInstallation`'s rules. A missing installation becomes the same not-found result
  as a 403 or 404. Budget exhaustion becomes resource-exhausted, an App credential failure becomes
  internal, and any other lookup failure becomes unavailable. A transient lookup failure never
  reads as "not found".
- **Author leg.** `rf.author` is the router over the primary App.
- **Reviewer leg.** The reviewer App is a second App with its own installations. It gets its own
  `InstallationResolver` and router, built the same way from `ReviewerApp`.
- **Board and notify lanes.** `buildBoardIngestLane` and `buildForgeNotifyLane` take the author
  router instead of `*forge.GitHub`, so issue hydration, the reconcile sweeps, check roll-ups and
  the head-SHA lookup read through the owner's installation. GitHub sends one App's webhooks for
  every installation to the App's single webhook URL, and the ingress does not filter by
  installation, so events from owner B already arrive.

### Issue edits

A new `forge_edit_issue` tool edits an issue's title, body or both (DL-582). It follows
`forge_transition_issue_state`: the same scope check, the same author leg, and no ownership row.
A body edit goes through `StampOwner` with the caller's identity, so the edited body carries the
editor's attribution header. A title-only edit sends no body and leaves the body untouched. GitHub
uses `PATCH /repos/{repo}/issues/{number}`. Linear uses its `issueUpdate` mutation with `title` and
`description`.

### Grant acceptance

`checkOrg` drops the owner-match rule and the wildcard rule from compass#2385, so
`checkOrgFromGrants` is deleted. A new owner must have an installation of the primary App, and of
the reviewer App when one is configured. Otherwise the grant fails with `FAILED_PRECONDITION`,
and the message names the missing App. Granting under a new owner signals a secrets refresh as any
grant does. The owner's file appears in the container on the next materialize.

### Alternatives considered

- Several tokens in `hosts.yml`: gh keys tokens by host only (`ActiveToken`).
- One token across installations: GitHub mints per installation, so the wrong one returns 422.
- URL-scoped `credential.https://github.com/<owner>.helper` entries: the container's gitconfig
  would be rewritten on every grant change, which the path-keyed helper avoids.
- Agent asks the broker on each call: needs a new agent-to-server credential RPC on every git
  operation, while files already rotate through `RefreshSecrets`.
- Helper as a `compass-agent` subcommand: starts the full bun bundle on every git operation, and
  splits the layout contract across two languages.
- Fall through to `hosts.yml` for any owner without a file: a refused owner gets the default
  token and an opaque 404 instead of a named error.
- Derive jj-vine's repository from the working directory: wrong under `jj-vine -R`, which runs the
  token command in the caller's directory.

## Plan

### Global Constraints

- Go at the compass module's floor. Helper and runner code stay `CGO_ENABLED=0`.
- `--forge-installation-id` names the default installation: the `*` group, the `hosts.yml`
  token and the primary client. Every forge call on another owner uses that owner's installation.
- No token value in a log, error, argv, or `String()`. `ResolvedSecret` keeps redacting `Value`
  and `Version`, and the helper never echoes its input.
- No change to the brokered permission set (`contents: write`, `pull_requests: write`,
  `metadata: read`).
- No shell logic. Nix wrappers are a single `exec` line.
- Public repository: no private-repository names, paths or PR links in code, comments, tests,
  docs or PR bodies. This includes the names of private test repositories.
- Each task lands its failing test first, then the code that turns it green.
- Stack compass PRs linearly on compass#2385 (`forge/rig-5653-installation-lookup`):
  T3, T4, T5, T6, T7, then T8. T2 is a separate RigelBuild/jj-vine PR off its `main`.
- Rollout: the server and runners cut over together. Only dev runs this, and dev can be wiped, so
  there is no mixed-runner window.
- Follow-ups: RIG-5819 (gh wrapper).

### T1. Installation resolver, `MintFor`, `checkOrg` installation check (done)

compass#2385: `forge.InstallationResolver`, `ScopedAppMinter.MintFor`, broker routing by owner,
and `FAILED_PRECONDITION` for an owner without an installation.

### T2. jj-vine `{project}` placeholder

Lane: forge. Repository: RigelBuild/jj-vine.

Interfaces:

```rust
// src/config.rs, GitHubConfig
/// The `tokenCommand` argv with each `{host}` replaced by the web host and each
/// `{project}` replaced by `target_project()`.
fn token_command_argv(&self) -> Result<Cow<'_, [String]>>;
// New error when `{project}` appears and target_project() is empty:
// "github.tokenCommand uses {project}, but no project is resolved"
```

Tests: an argv with both placeholders; `{project}` with an empty project errors; an argv with
neither placeholder is borrowed unchanged. Done when merged and the image pin can move to it.

### T3. Runner delivery and image helper

Lane: forge. Base: compass#2385.

Interfaces:

```proto
// proto/compass/v1/runner.proto, message ResolvedSecret
string owner = 8;  // set only for a brokered SECRET_KIND_GH: login of the installation that minted it
```

```go
// go/internal/secrets: ResolvedSecret gains
Owner string // lowercase account login whose installation minted a brokered SecretGH; "" otherwise

// go/internal/forgecred (new)
func TokenPath(home, host, owner string) string        // home/.compass/forge/<host>/<lowercase owner>
func DefaultOwnerPath(home, host string) string        // home/.compass/forge/<host>/.default-owner
func LookupToken(home, host, owner string) (string, bool, error)
func DefaultOwner(home, host string) (string, bool, error) // default installation's login
func OwnerFromCredentialPath(path string) (string, bool)   // "owner/repo(.git)" -> owner

// go/internal/runtime
type GHCredentials struct{ Host, Owner, Token string }
// Writes owner files and .default-owner (owner of the LAST SecretGH per host), removes stale files.
func GHOwnerTokensScript(homeDir string, creds []GHCredentials) (string, error)
// GHHostsScript is unchanged (last-wins).

// go/cmd/compass-forge-credential
// compass-forge-credential git-credential get|store|erase   (store/erase are no-ops)
// compass-forge-credential token --host H [--repo OWNER/NAME]
// The gh wrapper is RIG-5819; this task ships only `token`.
```

Also: `resolvedSecretToProto` in `go/internal/runnerhub/handler.go` and the fetch mapping in
`go/internal/runner/secrets_fetch.go` copy `Owner`. A flake package builds the helper with
`buildGoModule`. `agent-image/toolchain.nix` takes it as an input, sets the gitconfig and jj
config above, and moves the jj-vine pin to T2. `TestAgentImageGHTokenAuth` in
`go/e2e/image_toolchain_test.go` installs owner tokens for A (default) and B and asserts:

1. `git credential fill` for `owner-a/x` returns A's token, and for `owner-b/y` B's token.
2. A fill for a third owner fails, and stderr names that owner.
3. With the marker naming A, a fill for A without an owner file returns the `hosts.yml` token,
   and a fill for a third owner without a file is refused, also under a wildcard grant.
4. The jj `tokenCommand` with a project returns that owner's token, and exits non-zero for the
   third owner.

### T4. Broker mints one token per owner

Lane: forge. Base: T3.

Interfaces:

```go
// go/server/git_credential.go
type gitCredentialGroup struct {
	owner string   // lowercase owner; "*" for the wildcard group
	key   string   // "owner/a,owner/b" or "*"
	names []string // leaf names for the mint; nil for "*"
}
func gitCredentialScopes(grants []string) ([]gitCredentialGroup, bool) // false only for a malformed grant

// go/internal/forge/installations.go: login of the default installation, for the wire Owner of a
// "*" group. ErrNoInstallation when the snapshot lacks it.
func (r *InstallationResolver) DefaultOwner(ctx context.Context) (string, error)

type ownerCredential struct{ owner, key, token string }
// One credential per group; a rejected group retries with the owner user's grants under the same
// owner (widen only). The default credential is LAST.
func (b *gitCredentialBroker) credentials(ctx context.Context, agent store.AccountID) []ownerCredential
// last: map[store.AccountID]map[string]string, agent -> owner -> key
func (b *gitCredentialBroker) credentialForLastKey(agent store.AccountID, owner, requested string) (token, key string)
```

`ResolveFor` emits one `ResolvedSecret{Name: GITHUB_APP_TOKEN, Kind: SecretGH, Delivery:
DeliveryFile, Host, Owner}` per credential. Tests (`go/server/git_credential_test.go`):

- A two-owner grant set mints once per owner, each with its own owner.
- Owner B with no installation still serves A.
- An agent row under A that the installation rejects still serves the owner's grants under A.
- A mint failure for B falls back only to B's last key.
- Revoking B's last repository revokes B's token and keeps A's.
- The default credential is emitted last.
- A `*` credential carries the default installation's login in `Owner`, never `*`.
- An owner `*` plus an agent row under B serves `*` and B; `*` plus a row under the default owner
  mints only `*`.
- A single-owner agent emits exactly today's one secret, with `Owner` set.

### T5. Author and reviewer legs route by repository owner

Lane: forge. Base: T4.

Interfaces:

```go
// go/internal/forge/owner_routed.go (new)
var ErrInstallationLookup = errors.New("forge: installation lookup failed")
type OwnerRoutedGitHub struct { /* primary *GitHub; resolver *InstallationResolver; cfg GitHubAppConfig; httpClient *http.Client; mu; clients map[int64]*GitHub */ }
func NewOwnerRoutedGitHub(primary *GitHub, resolver *InstallationResolver, cfg GitHubAppConfig, httpClient *http.Client) *OwnerRoutedGitHub
// Implements forge.Provider; every repo-taking method resolves the owner's installation first and
// wraps a resolver error as fmt.Errorf("%w: %w", ErrInstallationLookup, err).
func (r *OwnerRoutedGitHub) AppLogin(ctx context.Context) (string, error) // delegates to primary

// go/server
// Shared by checkInstallation and mapForgeError; each caller maps forge.ErrNoInstallation itself.
func installationErrorCode(err error) connect.Code
func registerGitHubForgeCoordinate(reg *forgeProviderRegistry, fc ForgeConfig, author, reviewer forge.Provider) error
```

`buildForgeWriteService` wraps the primary client, and builds a reviewer `InstallationResolver`
and router from `ReviewerApp`. Tests:

- A write on owner B's repository uses B's installation token.
- The default owner's write uses the primary client and its rate gate.
- `forge_submit_review` on B uses the reviewer App's installation on B.
- An owner with no installation returns not-found, and a throttled lookup returns unavailable.
- `forge_mirror`'s `AppLogin` assertion holds on the router.

### T6. Board and notify lanes read through the owner's installation

Lane: forge. Base: T5.

`OwnerRoutedGitHub` also implements `forge.NotifyReader`, `forge.PullRequestResolver` and the
ingest reader interfaces (`ListIssues`, `GetPullRequest`, `ListOpenPullRequests`, and the updated
lister). `buildBoardWebhookWiring` builds the router once and hands it to `buildBoardIngestLane`,
`buildForgeNotifyLane` and the author leg, so the RIG-2991 test still sees one shared reader.
Tests:

- A notify reconcile sweep on a subscribed B repository reads with B's installation token.
- A board webhook for a B repository hydrates the issue through B's installation.
- `forge_subscribe` on B, then a new comment on that issue, notifies the subscriber.

### T7. `forge_edit_issue`

Lane: forge. Base: T6.

Interfaces:

```proto
// proto/compass/v1/agent_gateway.proto
message EditIssueRequest {
  string repo = 1;                // REQUIRED
  uint64 issue_number = 2;
  optional string title = 3;      // unset = unchanged
  optional string body = 4;       // WITHOUT the owner header; the Server stamps it. Unset = unchanged
}
// ForgeCallRequest.call gains: EditIssueRequest edit_issue = 17;
// The result is the updated compass.v1.Issue in ForgeCallResult.issue.
```

```go
// go/internal/forge/provider.go
type EditIssue struct{ Title, Body *string }
// EditIssue returns the UPDATED issue; nil fields are left unchanged.
EditIssue(ctx context.Context, repo string, number uint64, in EditIssue) (Issue, error)
```

The agent tool `forge_edit_issue` in `packages/compass-agent/src/forge.ts` has `approval:
"write"`. Tests:

- With neither field set, the call fails with invalid-argument before any provider call.
- A body edit stamps the caller, and an agent-supplied header is stripped.
- A title-only edit sends no body.
- An edit outside the caller's scope returns the scope error.
- GitHub sends a `PATCH` with only the set fields; Linear sends `issueUpdate`.

### T8. Accept mixed owners, spec, docs, proof

Lane: forge. Base: T7.

Interfaces:

```go
// go/server/agent_repository_service.go
func (s *agentRepositoryService) checkOrg(ctx context.Context, agent store.AccountID, repo string) error
// keeps: checkInstallation(org), now also on the reviewer resolver when configured
// deletes: checkOrgFromGrants and the wildcard DefaultInstallation() rule
```

Tests:

- Granting `B/two` to an agent holding `A/one` succeeds when B has an installation.
- Without a primary installation it fails with `FAILED_PRECONDITION`.
- With a reviewer App configured and no reviewer installation on B, it fails with
  `FAILED_PRECONDITION` naming the reviewer App.
- A `*` agent may add `B/two`.

Add this requirement under `## Agent sessions` in `docs/specs/product/compass.md`:

```markdown
### Requirement: Agent repository credentials follow each owner's App installation

The Server SHALL mint an agent's GitHub credential separately for each repository owner the agent
is granted, on that owner's GitHub App installation. The agent's git and jj-vine SHALL each use
the credential for the repository they act on. Every forge call, including subscriptions and
reviews, SHALL use that owner's installation. Granting a repository whose owner lacks an
installation of a configured App SHALL fail with `FAILED_PRECONDITION`. A wildcard grant SHALL
cover the default installation; repositories under other owners SHALL need exact grants.

#### Scenario: Agent holds repositories under two owners

- **Given** the GitHub App is installed on owners A and B
- **And** an agent is granted `A/one` and `B/two`
- **When** the agent pushes to each repository and opens a pull request on `B/two`
- **Then** each push and the pull request use a credential minted on that owner's installation
- **And** the credential for `A/one` does not reach `B/two`

#### Scenario: Owner without an installation

- **Given** the GitHub App has no installation for owner C
- **When** a user grants an agent `C/three`
- **Then** the grant fails with `FAILED_PRECONDITION`
- **And** the agent's other credentials are unchanged

#### Scenario: Forge tools use the owner's installation

- **Given** an agent granted `B/two`, where B is not the default installation's owner
- **When** the agent creates, edits, subscribes to, or reviews on `B/two` with the forge tools
- **Then** the Server makes each call with a credential for owner B's installation
```

Replace the repository-grant paragraph in `docs/self-host.md` with the text below, and drop the
wildcard clause from the deployment-wide installations paragraph.

```markdown
Each repository must be an exact `org/name`, and its owner must have an installation of the GitHub
App, and of the reviewer App when one is configured; otherwise the grant is rejected with
`FAILED_PRECONDITION`. An agent may hold repositories under several owners: Compass mints a
separate token on each owner's installation, and the agent's git and jj-vine pick the token for
the repository they act on. `gh` uses the default installation's token; for another owner, run
`GH_TOKEN="$(compass-forge-credential token --host github.com --repo owner/name)" gh …`. The `*`
grant covers the default App installation (`--forge-installation-id`); repositories under other
owners need exact grants. A newly installed owner is accepted within about 30 seconds.
```

Proof on dev, recorded in the PR body. One agent holds `RigelBuild/compass-forge-testbed` and a
public repository under the second owner's personal-account installation.

- `jj-vine submit` pushes to the second owner's repository and opens a PR there.
- On that repository, `forge_create_issue`, `forge_edit_issue`, `forge_comment_on_issue` and
  `forge_transition_issue_state` succeed, and `forge_subscribe` delivers a notification.
- `forge_submit_review` reviews the PR there.
- A push to the testbed still succeeds.

## Tasks

- [x] T1. Installation resolver, `MintFor`, `checkOrg` installation check (compass#2385)
- [ ] T2. jj-vine `{project}` placeholder (RigelBuild/jj-vine)
- [ ] T3. Runner delivery: `owner` wire field, owner token files, `compass-forge-credential`, image
- [ ] T4. Broker mints one token per owner (DL-562)
- [ ] T5. Author and reviewer legs route by repository owner (DL-564)
- [ ] T6. Board and notify lanes read through the owner's installation (DL-564)
- [ ] T7. `forge_edit_issue` (DL-582)
- [ ] T8. Accept mixed owners in `checkOrg`, spec requirement, `docs/self-host.md`, dev proof

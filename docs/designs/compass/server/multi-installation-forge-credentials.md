# Multi-installation forge credentials

Tracking: RIG-5653 (work; parent RIG-4898). Ruling: Matt, 2026-10-17, on RIG-4898: "we need to
support multiple installs in the product."

Length: the record is about 3,150 prose words. The excess over the 2,500-word target sits in
Open Questions, which shrinks to a short Resolved decisions section once Matt rules.

## Open Questions

1. **OQ-1. What does a wildcard grant cover?** compass#2385 mints `*` on the default installation
   and rejects a `*` agent's grant under any other owner. That check runs only in
   `AgentRepositoryService`. Seeded `ScopeGrants` and an owner's later `*` grant bypass it, and
   `gitCredentialScope` lets a `*` anywhere in the union hide every exact grant. So an agent that
   holds `B/two` loses B silently when its owner later gains `*`.
   - (a) Keep #2385's rule. A `*` in the union collapses to one `*` group, and the hole above stays.
   - (b) `*` covers the default installation. Exact grants under other owners keep their own owner
     groups, and `checkOrg` drops the wildcard rule.
   - (c) `*` mints on every installation, which means one token per installation on every refresh.

   **Recommendation:** (b). It closes the hole, and it costs one installation comparison per
   exact owner in T4. It changes the wildcard sentence that #2385 put in `docs/self-host.md`.
2. **OQ-2. What does "create and edit an issue" on the second owner mean?** The brokered token has
   no `issues: write` (DL-442 OQ-10), so `gh issue create` fails on every owner today.
   - (a) Issues go through the forge tools (`forge_create_issue`, `forge_comment_on_issue`,
     `forge_transition_issue_state`) on the owner's installation (T5). No permission change.
   - (b) Add `issues: write` to the brokered token so `gh issue create` and `gh issue edit` work.
     Those writes carry no Compass attribution stamp or ownership row.
   - (c) Do (a) and add a `forge_edit_issue` tool for title and body edits. This is a new tool
     contract.

   **Recommendation:** (a), which **narrows the RIG-5653 goal**. "Create and edit issues" becomes
   create, comment and open or close; no title or body edit. Ruling (a) accepts that narrower
   goal. Keeping the goal as written means (c).
3. **OQ-3. Are subscriptions and reviews on a second-owner repository in scope?** The notify lane
   polls with the default installation's client, so `forge_subscribe` on such a repository never
   notifies. The reviewer App is bound to the default installation, so `forge_submit_review`
   there fails.
   - (a) Both arms return an explicit in-band error for such a repository (T5). Notify and the
     reviewer get a follow-up issue.
   - (b) Route the notify lane's reads through the T5 router in this issue. Reviews still fail.

   **Recommendation:** (a). The proof does not need either. The notify lane shares the RIG-2991
   rate gate, which T5 leaves alone.
4. **OQ-4. How does the default credential reach `hosts.yml` while runners are mixed?** Mixed-owner
   grant sets exist today. `ListForgeScopeRepos` unions the owner's grants with the agent's rows,
   and seeded `ScopeGrants` bypass `checkOrg`. So T4 changes the wire as soon as the server
   deploys. Runners deploy separately, and a runner without T3 writes the last `SecretGH` per host
   into `hosts.yml`.
   - (a) Emit the default credential last, and keep `GHHostsScript` last-wins. Old and new runners
     both put the default credential in `hosts.yml`. This is never worse than today's token, except
     in one case: the owner's own grants sit on a non-default installation while agent rows sit on
     the default one.
   - (b) Mark the default credential explicitly on the wire. Old runners ignore the mark, so (b)
     still needs (a)'s order.
   - (c) The runner's secret fetch declares that it reads `owner`, and the server sends old runners
     today's single secret. This closes every case, but it adds a capability field to the fetch.

   **Recommendation:** (a). It needs no new field and no test churn, and it leaves the one gap
   above. Depends on OQ-1: under (b) there, the `*` group is the default credential.
5. **OQ-5. Does gh get per-owner tokens in this issue?** Nothing on the proof path runs gh. PRs go
   through jj-vine, and issues go through the forge tools (OQ-2). A `gh` wrapper must infer the
   owner from `-R`, `GH_REPO`, `gh api repos/…` or the working directory's remote. It misses
   positional repositories, URL arguments, GraphQL variables and directories outside a checkout. A
   checkout's devenv that ships gh would also shadow it on `PATH`.
   - (a) Ship the wrapper in T3 (the `gh` subcommand in T3's Interfaces).
   - (b) Ship only `compass-forge-credential token --repo`, so an agent runs
     `GH_TOKEN="$(compass-forge-credential token --host github.com --repo owner/name)" gh …`. The
     wrapper becomes a follow-up issue with its own review.

   **Recommendation:** (b). It keeps the largest heuristic surface out of an issue whose proof
   never exercises it, and plain gh keeps today's default-token behaviour.

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
- Under OQ-1 (b), `credentials` drops an exact group whose owner resolves to
  `DefaultInstallation()` while a `*` group exists, because `*` already covers it. Under (a), a `*`
  collapses the union to the `*` group, as today.
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
- `ResolveFor` appends one `ResolvedSecret` per credential. Each carries the new `Owner` field,
  and the `*` group carries `*`. The **default credential** is the `*` group, else the group on
  `DefaultInstallation()`, else the first group by owner. Under OQ-4 (a) it is appended last.

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

### Forge writes

The GitHub author leg becomes a `forge.Provider` that routes each call by repository owner
(DL-564). Every `Provider` method that touches the network takes `repo`, so the router is a
drop-in `rf.author`.

- The default installation uses the existing shared primary client. Board, notify and author
  writes on that installation keep one RIG-2991 rate gate.
- Another installation gets its own `NewAppTokenSource` and `NewGitHub`, built on first use and
  cached by installation id. Each has its own rate gate, because GitHub budgets per installation.
- `Name`, `BodyLimit` and `AppLogin` delegate to the primary client. The App's bot login is the
  same on every installation, so `forge_mirror`'s identity check is unchanged.
- The router wraps resolver errors in `forge.ErrInstallationLookup`. `mapForgeError` classifies
  them with `checkInstallation`'s rules. A missing installation becomes the same not-found result
  as a 403 or 404. Budget exhaustion becomes resource-exhausted, an App credential failure becomes
  internal, and any other lookup failure becomes unavailable. A transient lookup failure never
  reads as "not found".
- The reviewer leg, board ingestion, webhooks and the notify lane stay on `--forge-installation-id`.
  Under OQ-3 (a), `forge_subscribe` and `forge_submit_review` check the owner after the scope
  check. On a non-default installation they return a failed-precondition result that names the
  limit. The scope check runs first, so the result reveals nothing about ungranted repositories.

### Grant acceptance

`checkOrg` drops the owner-match rule, so `checkOrgFromGrants` is deleted. A new owner must still
have an installation, or the grant fails with `FAILED_PRECONDITION`. Under OQ-1 (b) the wildcard
rule goes too, and under (a) it stays. Granting under a new owner signals a secrets refresh as any
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
- `--forge-installation-id` stays the default installation for board ingestion, webhooks, the
  reviewer leg and the notify lane.
- No token value in a log, error, argv, or `String()`. `ResolvedSecret` keeps redacting `Value`
  and `Version`, and the helper never echoes its input.
- No change to the brokered permission set (`contents: write`, `pull_requests: write`,
  `metadata: read`) unless OQ-2 rules (b).
- No shell logic. Nix wrappers are a single `exec` line.
- Public repository: no private-repository names, paths or PR links in code, comments, tests,
  docs or PR bodies. This includes the names of private test repositories.
- Each task lands its failing test first, then the code that turns it green.
- Stack compass PRs linearly on compass#2385 (`forge/rig-5653-installation-lookup`):
  T3, then T4, then T5, then T6. T2 is a separate RigelBuild/jj-vine PR off its `main`.
- Rollout: mixed-owner grant sets already exist, so T4 reaches them as soon as the server deploys.
  OQ-4 decides how a runner without T3 stays safe.
- Follow-ups: none filed. OQ-3 (a) and OQ-5 (b) each add one follow-up issue, filed when Matt
  rules.

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
// Only if OQ-5 rules (a): compass-forge-credential gh REAL_GH [ARGS...], which picks the owner from
// -R/--repo, GH_REPO, a `gh api [/]repos/<owner>/…` endpoint, then the remote gh would choose
// (remote.<name>.gh-resolved, then upstream > github > origin); it execs REAL_GH with GH_TOKEN
// set, and execs unchanged when GH_TOKEN or GITHUB_TOKEN is set or the owner is the default.
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
// owner (widen only). The default credential is LAST (OQ-4 (a)).
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
- Under OQ-1 (b): an owner `*` plus an agent row under B serves `*` and B; `*` plus a row under
  the default owner mints only `*`.
- A single-owner agent emits exactly today's one secret, with `Owner` set.

### T5. Forge writes route by repository owner

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
func (r *OwnerRoutedGitHub) OnDefaultInstallation(ctx context.Context, repo string) (bool, error)

// go/server
// Shared by checkInstallation and mapForgeError; each caller maps forge.ErrNoInstallation itself.
func installationErrorCode(err error) connect.Code
func registerGitHubForgeCoordinate(reg *forgeProviderRegistry, fc ForgeConfig, author forge.Provider, reviewer *forge.GitHub) error
```

`buildForgeWriteService` wraps the primary client when the installation resolver is non-nil.
Under OQ-3 (a), `subscribeForge` and `submitReview` call `OnDefaultInstallation` after
`requireForgeScope`, and return `forgeErr(connect.CodeFailedPrecondition, "forge: subscriptions
and reviews cover only repositories on the default GitHub App installation")` when it is false.
Tests:

- A write on owner B's repository uses B's installation token.
- The default owner's write uses the primary client and its rate gate.
- An owner with no installation returns not-found, and a throttled lookup returns unavailable.
- `forge_subscribe` and `forge_submit_review` on B return the failed-precondition result.
- `forge_mirror`'s `AppLogin` assertion holds on the router.

### T6. Accept mixed owners, spec, docs, proof

Lane: forge. Base: T5.

Interfaces:

```go
// go/server/agent_repository_service.go
func (s *agentRepositoryService) checkOrg(ctx context.Context, agent store.AccountID, repo string) error
// keeps: checkInstallation(org); deletes: checkOrgFromGrants
// OQ-1 (b) also deletes the wildcard DefaultInstallation() rule; (a) keeps it.
```

Tests:

- Granting `B/two` to an agent holding `A/one` succeeds when B has an installation.
- Without an installation it fails with `FAILED_PRECONDITION`.
- Under OQ-1 (b), a `*` agent may add `B/two`; under (a), it is refused.

Add this requirement under `## Agent sessions` in `docs/specs/product/compass.md`. The wording
follows the OQ-1 and OQ-3 recommendations; adjust it to the rulings.

```markdown
### Requirement: Agent repository credentials follow each owner's App installation

The Server SHALL mint an agent's GitHub credential separately for each repository owner the agent
is granted, on that owner's GitHub App installation. The agent's git and jj-vine SHALL each use
the credential for the repository they act on, and the forge tools SHALL write through that
owner's installation. Granting a repository whose owner has no installation SHALL fail with
`FAILED_PRECONDITION`. A wildcard grant SHALL cover the default installation; repositories under
other owners SHALL need exact grants. Subscriptions and reviews SHALL cover only repositories on
the default installation.

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

#### Scenario: Forge tools write through the owner's installation

- **Given** an agent granted `B/two`, where B is not the default installation's owner
- **When** the agent creates an issue on `B/two` with the forge tools
- **Then** the Server writes it with a credential for owner B's installation
- **And** a subscription or review on `B/two` fails with an error that names the limit
```

Replace the repository-grant paragraph in `docs/self-host.md` with:

```markdown
Each repository must be an exact `org/name`, and its owner must have an installation of the GitHub
App; otherwise the grant is rejected with `FAILED_PRECONDITION`. An agent may hold repositories
under several owners: Compass mints a separate token on each owner's installation, and the agent's
git and jj-vine pick the token for the repository they act on. `gh` uses the default
installation's token; for another owner, run
`GH_TOKEN="$(compass-forge-credential token --host github.com --repo owner/name)" gh …`. The `*`
grant covers the default App installation (`--forge-installation-id`); repositories under other
owners need exact grants. Subscriptions and reviews work only on repositories of the default
installation. A newly installed owner is accepted within about 30 seconds. The GitHub App must be
configured.
```

Proof on dev, recorded in the PR body. One agent holds `RigelBuild/compass-forge-testbed` and a
public repository under the second owner's personal-account installation.

- `jj-vine submit` pushes to the second owner's repository and opens a PR there.
- `forge_create_issue`, `forge_comment_on_issue` and `forge_transition_issue_state` work on that
  repository, per OQ-2 (a).
- A push to the testbed still succeeds.

## Tasks

- [x] T1. Installation resolver, `MintFor`, `checkOrg` installation check (compass#2385)
- [ ] T2. jj-vine `{project}` placeholder (RigelBuild/jj-vine)
- [ ] T3. Runner delivery: `owner` wire field, owner token files, `compass-forge-credential`, image
- [ ] T4. Broker mints one token per owner (DL-562)
- [ ] T5. Forge writes route by repository owner (DL-564)
- [ ] T6. Accept mixed owners in `checkOrg`, spec requirement, `docs/self-host.md`, dev proof

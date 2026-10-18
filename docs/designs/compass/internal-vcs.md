# Compass internal VCS — a server-held change store with GitHub as a mirror

Tracker: RIG-5665

> Freezes on merge; later changes supersede by citation, never rewrite
> (convention: the `docs/designs/agent/compass-agent-config-delivery/design.md`
> header). Unless a path says otherwise, every path is in
> [RigelBuild/compass](https://github.com/RigelBuild/compass).

Ledger-impact: DL-578..DL-581 file D1–D4. DL-578 supersedes the DL-535
clause "from a git bundle the agent sends". DL-580 supersedes the DL-090
clause "agents self-clone after launch with the container's scoped git
credential" and the DL-326 clause "the agent clones/fetches in-container
with its existing `$HOME` machine-user token". Both are clause supersessions,
so the old files keep `Active`, as DL-052 did under DL-561. By citation, this
record also replaces three parts of `agent-vcs-tools.md`: the T3 field
`bytes bundle = 4`, the T10 `ApplyBundle`, and the T9 sentence that says
agent egress keeps `github.com`. DL-579 keeps DL-537's "no squash" and adds
a lease-guarded force-push on base moves only.

**Named decisions this record introduces:** D1–D4 in [Decisions](#decisions).

Length: the record is about 3,100 prose words. The excess over the
2,500-word target sits in Open Questions (about 900 words), which shrinks to
a short Resolved decisions section once Matt rules.

## Open Questions

The record is written against each recommendation. OQ-2 depends on OQ-1.
OQ-3 depends on OQ-4.

**OQ-1. What is the store?**

- (a) Grow the RIG-5558 T10 mirror into the store. Keep one bare git repo
  per tenant and repo. Add change and version rows in Postgres. Agents
  upload changesets.
- (b) The same mirror, but agents upload a git bundle, as T10 planned. This
  is the smallest diff. It lost to (a) because the Server must unpack a
  bundle whole before it can check anything. A changeset sends only the
  blobs the Server lacks, and the Server writes nothing until the checks
  pass.
- (c) A Scion-style store: changesets and blobs in Postgres and object
  storage, with git commits made only for GitHub. It needs a second object
  model, an exporter, and an object-storage cap.
- (d) Adopt Twigg. It is AGPL-3.0; its repo does not say whether that is
  `-only` or `-or-later`, and Compass is AGPL-3.0-only. Its server is SQLite
  with one writer, and its client is `tw`, not jj.

**Recommendation:** (a). Compass runs one Server. The Scion gains we want
come from where checks and refs live, not from the object format.

**OQ-2. What does an agent work in?** (depends on OQ-1)

- (a) A local jj repo, filled only from the Server. The first fill is
  shallow: one commit, the trunk tip. Later fills are incremental.
- (b) Plain files with no `.git`, and all history read through API tools.
- (c) A virtual (FUSE) checkout, like CitC.

**Recommendation:** (a). The RIG-5558 tools are built on jj, and jj accepts
a shallow repo. jj does not support partial (blob-filtered) clones
(jj-vcs/jj issue #8920), so a fill is shallow in history but full in files.

**OQ-3. How does a PR branch follow a base move?** (depends on OQ-4)

A PR branch must move when its base moves: when trunk moves, or when a
parent PR in the stack changes. GitHub refuses a push from an App that
creates or updates a file under `.github/workflows/` unless the App has the
`workflows` permission (Mergifyio/mergify issue #5055). Compass trunk
changes workflow files often. Its `.github/workflows/renovate.yml` says
Renovate "pushes commits under .github/workflows/". The Compass App does not
have the `workflows` permission today; no `githubapp*.go` file asks for it.

- (a) Merge the new base into the PR branch, and grant `workflows` to the
  push token only. Each PR shows every commit and every base move. This
  works whatever GitHub checks. Every installation of the App must accept
  the new permission.
- (b) Force-push the rebased line with a lease. This is what RIG-5558 T10
  already planned. No new permission is needed. GitHub shows no interdiff
  across a base move. Review fixes stay additive commits. Nothing is
  squashed.
- (c) A merge commit whose first parent is the new base. How GitHub checks
  such a push is not known, so this needs a probe first.

The PR #39 ruling was "no squash", not "no force-push". It is not verified
whether GitHub checks each new commit or the old-tip-to-new-tip diff. Under
the second, (b) fails too.

**Recommendation:** (b), gated. Before T4 merges, a probe moves a scratch
PR past a trunk workflow commit with a token that lacks `workflows`, and
the PR records the result. If GitHub refuses, use (a). A change's own
workflow edits are refused in every option (D4).

**OQ-4. What is the review unit?**

- (a) One jj change is one PR, and one issue may cover the whole line. This
  is Twigg's model, and a version means one state of one PR. Costs:
  - a feature split into three changes is three PRs for Matt to review;
  - red → green work (the failing test lands first) splits into a red PR
    and a green PR, unless the agent folds the test and the fix into one
    change;
  - DL-537 ("PR text from the segment's first commit") and DL-538
    ("refuses a bookmark with no issue") need supersession;
  - the bookmark-keyed RIG-5558 tool inputs (`vcs_commit { bookmark }`,
    `vcs_retire`, `vcs_pr_status`, the `issues` map) move to change ids.
- (b) Keep the RIG-5558 segment: a bookmark is one PR with one or more
  commits. Versions live in the Server per change, not per PR.

**Recommendation:** (b). It keeps Matt's rulings on PR #39 and the tool API,
and it keeps red → green inside one PR. Twigg versions still exist in the
store.

**OQ-5. What GitHub egress does an agent keep?**

- (a) Drop `github.com` (git transport). Keep `api.github.com` and the
  read-only token for `gh` reads, such as CI logs.
- (b) Drop all GitHub egress. First, every read needs a `forge_*` tool.
- (c) Keep both, as RIG-5558 T9 does.

**Recommendation:** (a). The write barrier is the token's `contents: read`
(RIG-5558 T9). Dropping `github.com` is defense in depth: it also stops
reads that skip the Server.

**OQ-6. How does this order against RIG-5558?**

- (a) RIG-5558 ships whole on git. This record then replaces the bundle
  and the egress line.
- (b) RIG-5558 builds its T6/T7 against this record's upload and
  `FetchObjects` protocol, and this record's T2 replaces its T10.

**Recommendation:** (b). Compass has no RIG-5558 code yet: there is no
`packages/compass-agent/src/vcs.ts`, no `go/internal/forge/mirror.go`, and
no `submit_stack`. Under (a), the `ApplyBundle` code and the `bundle` field
would ship only to be deleted. Under (b), proto field 4 is never `bundle`.

## Problem / Intent

RIG-5558 gives agents `vcs_*` tools. Agents still clone from GitHub, keep a
git route to it, and send the Server a bundle. Matt wants agents off git
transport inside Compass. The Server becomes the only writer to GitHub and
the place to check code before it leaves. Every landed change still reaches
GitHub as normal commits and PRs.

## Approach

**What this takes from each source.**

- Scion ("Redesigning source control", Anthropic, 2026):
  - the Server holds history and is the only writer to the outside;
  - a client sends a changed-file list and the blobs the Server lacks;
  - objects are fetched by id;
  - a version moves by compare-and-swap on one Postgres row;
  - the only advertised ref is trunk.

  Not taken: Scion's Server-created commits (here the agent's jj creates
  each commit, and the Server verifies it byte for byte), its object format,
  and its virtual working copy.
- Twigg: each jj change id gets numbered versions in the store, and a git
  mirror carries the work to GitHub.
- Piper: the agent repo is a cache that only the Server fills.

Review and merge stay on GitHub.

**Flow.**

1. `vcs_checkout {repo}` streams a shallow pack of the trunk tip from the
   Server. It builds a colocated jj repo and runs `jj new 'trunk()'`. The
   repo has no remote.
2. The agent edits and commits with local jj, as in RIG-5558.
3. `vcs_submit` uploads each own change, parent first. An upload is the raw
   commit, its changed entries (`git diff-tree -r --raw --no-renames`
   against its parent), and the blobs the Server lacks. The Server rebuilds
   the tree and runs the D4 checks. Only then does it store the commit
   unchanged and append a version. It pushes the segment's bookmark with a
   lease and does the PR writes through the RIG-5558 arms, with their write
   intents.
4. `vcs_sync` fetches new trunk objects from the Server, then runs the
   RIG-5558 local rebase. A conflict is resolved in jj, as before.
5. The PR lands through GitHub. The next fetch brings the merged trunk in.

**Why the T10 mirror and forge-call arms.** T10 already has one bare repo
per repo on a capped volume with `Push` and `Rebase`. This record swaps
`ApplyBundle` for intake and serving on that interface. The two unary calls
ride `ForgeCallRequest`, which reuses the runner relay
(`runnerhub.ForgeCaller`), the caller identity, and `requireForgeScope` in
`go/server/forge.go`. The object download copies the stream shape of
`RunnerService.FetchSessionBlobs`: a header frame, then chunk frames.

## Plan

### Global Constraints

- All `agent-vcs-tools.md` Global Constraints carry over.
- The Server never pushes trunk, never pushes a ref it did not create, and
  always pushes with a lease on the old commit.
- Git runs from an argument array with no user config and
  `GIT_TERMINAL_PROMPT=0`.
- **Header allowlist.** An uploaded commit has exactly these headers:
  `tree`, one `parent`, `author`, `committer`, and one `change-id`.
  - Refused: any other header, which covers `gpgsig` and jj's conflict
    headers `jj:trees` and `jj:conflict-labels`.
  - Refused: a merge, and a gitlink (mode `160000`).
  - Refused: a parent that is neither trunk-reachable nor a stored version.
  - Refused: an author or committer that is not the agent identity.
- **Agent identity (assumption).** The name is the agent handle and the
  email is `<handle>@agents.invalid`. Accounts have no email field
  (`go/internal/store/accounts.go`). The checkout header carries both, and
  the tool writes them to repo config. A Server `git replay` sets
  `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` to the identity of the
  agent that owns the change.
- **Caps.** Each cap refuses rather than truncates, and each is set by a
  flag:
  - one blob ≤ 15 MiB (`MAX_SESSION_BLOB_BYTES` in
    `packages/compass-agent/src/session-blobs.ts`);
  - one put batch ≤ 15 MiB;
  - ≤ 2,000 entries per change;
  - pack bytes per session per day;
  - the T10 per-repo and total volume caps.
- A finding names a path and a rule id, never the matched text.
- Red → green: failing tests land first. Use temp repos, `pgtest`,
  `FakeProvider`, and `bun test`. The gate is `moon run :ci`. Proto edits
  run `moon run compass-proto:gen`. The migration passes
  `moon run sql-migration-gate:check`.
- Name no private repository or path.

### T1 — store: changes and versions

Interfaces: `go/internal/store/migrations/0004_vcs_changes.sql` and
`go/internal/store/vcs_changes.go`. The tenant column, grants,
`FORCE ROW LEVEL SECURITY`, `tenant_isolation` policy, and `set_updated_at`
trigger all copy `0002_agent_config_overlays.sql`.

```sql
CREATE TABLE vcs_changes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('compass.tenant_id', TRUE)
    REFERENCES tenants (id) ON DELETE RESTRICT,
  repo TEXT NOT NULL,
  change_id TEXT NOT NULL,
  agent_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 0,
  closed_at TIMESTAMPTZ,            -- landed or retired; refs deleted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vcs_changes_key ON vcs_changes (tenant_id, lower(repo), change_id);
CREATE TABLE vcs_versions (
  change_row BIGINT NOT NULL REFERENCES vcs_changes (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT current_setting('compass.tenant_id', TRUE)
    REFERENCES tenants (id) ON DELETE RESTRICT,
  commit_id TEXT NOT NULL,
  parent_commit TEXT NOT NULL,
  parent_change_id TEXT,            -- NULL: based on trunk
  pushed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (change_row, version),
  UNIQUE (change_row, commit_id)
);
```

```go
type VcsChange struct {
	ID              int64
	Repo, ChangeID  string
	Agent           AccountID
	Version         int
	Closed          bool
}
type VcsVersion struct {
	Version                             int
	CommitID, ParentCommit, ParentChange string
	Pushed                              bool
}
func (s *Store) EnsureVcsChange(ctx context.Context, c VcsChange) (VcsChange, error)
// AppendVcsVersion moves version from expect to expect+1; a stale expect
// returns ErrVersionConflict. A commit already stored returns that version.
func (s *Store) AppendVcsVersion(ctx context.Context, change int64, expect int, v VcsVersion) (VcsVersion, error)
func (s *Store) MarkVcsPushed(ctx context.Context, change int64, version int) error
func (s *Store) VcsChangeByID(ctx context.Context, repo, changeID string) (VcsChange, []VcsVersion, error)
// VcsReadableCommit reports whether caller may fetch commit: a version of
// its own change or of a change whose agent has the same owner user.
func (s *Store) VcsReadableCommit(ctx context.Context, caller AccountID, repo, commit string) (bool, error)
func (s *Store) CloseVcsChange(ctx context.Context, change int64) error
```

`EnsureVcsChange` returns `ErrPermissionDenied` when the change id belongs
to another agent.

Red → green:

- two appends at one `expect` race, and one gets `ErrVersionConflict`;
- another tenant reads nothing;
- a repo name in another case finds the same row;
- `VcsReadableCommit` is false for another owner's change.

### T2 — the mirror becomes the store

Interfaces (`go/internal/forge/mirror.go`, replacing the RIG-5558 T10
interface; `ApplyBundle` is gone):

```go
type TreeEntry struct {
	Path string
	Mode uint32 // 0 deletes the path
	Blob string // hex object id; "" when Mode is 0
}
type Identity struct{ Name, Email string }
type Mirror interface {
	Push(ctx context.Context, repo string, refs map[string]string) error // lease on old commit
	Rebase(ctx context.Context, repo, ref, onto string, as Identity) (newHead string, conflict bool, err error)
	MissingBlobs(ctx context.Context, repo string, oids []string) ([]string, error)
	PutBlobs(ctx context.Context, repo string, blobs [][]byte) ([]string, error)
	// Diff returns the patch of commit raw's tree (rebuilt from its parent
	// plus entries) against its parent; it writes no commit and no ref.
	Diff(ctx context.Context, repo string, raw []byte, entries []TreeEntry) (patch []byte, err error)
	// AddCommit writes raw unchanged after the header allowlist and tree
	// checks, and pins it with refs/compass/v/<change_id>/<n>.
	AddCommit(ctx context.Context, repo string, raw []byte, entries []TreeEntry, who Identity, version int) (commit string, err error)
	DropVersions(ctx context.Context, repo, changeID string) error
	FetchTrunk(ctx context.Context, repo string) (ref, commit string, err error)
	Pack(ctx context.Context, repo string, wants, haves, shallow []string, w io.Writer) (newShallow []string, err error)
}
```

`repo` is the mirror key. The path is
`<--vcs-mirror-dir>/<tenant>/<host>/<owner>/<name>.git`, so one mirror never
holds two tenants.

**Tree check.** `AddCommit` rebuilds the tree with `read-tree`, then
`update-index --index-info` (mode 0 deletes), then `write-tree`, all under a
temp `GIT_INDEX_FILE`. It refuses unless the result equals the commit's
`tree` line. A jj-made tree with a delete, a 755 file, and a symlink
rebuilds to the same id (checked with git 2.55.0).

**Pack.** `Pack` feeds `pack-objects --revs --stdout` with the wants,
`^<have>`, and one `--shallow <id>` line per client shallow root, as
`upload-pack` does. With no haves, it sends only the want commit's own tree.
The caller (T3) checks that each want is the trunk tip or
`VcsReadableCommit`.

**Retention.** `DropVersions` deletes `refs/compass/v/<change_id>/*` when a
change lands or retires. A daily `git gc --prune=2.weeks.ago` frees the
space. Unreferenced blobs from a refused upload are never served, and gc
removes them.

**Cost.** The mirror stays off unless `--vcs-mirror-dir` is set. The T10
rule stands: the change that enables it in a deployment adds an enforced cap
at each billing layer (account, cluster, volume), a budget alert that pages
Matt, and a spend-cap row per layer. This record adds one meter: Server →
Runner pack bytes. Where they sit in different networks, that traffic is
billed egress. Its caps are the per-session pack cap and a spend-cap row for
data-transfer egress. When a DL-326 session snapshot holds a repo,
`vcs_checkout` sends its trunk as a have, so only the first fill is full.

Red → green (temp repos):

- each header-allowlist refusal fails, and so does a tree mismatch;
- a jj-made commit round-trips to the same id;
- a shallow first `Pack` fills a jj repo that can `jj new` and commit;
- an object deleted before a shallow root and restored after it is still
  sent;
- `Rebase` writes the given committer;
- a repo at its cap accepts uploads again after `DropVersions` and gc;
- each cap refuses.

### T3 — proto, arms, and the object stream

Interfaces (`proto/compass/v1/agent_gateway.proto`,
`proto/compass/v1/runner.proto`):

```proto
message TreeEntry { string path = 1; uint32 mode = 2; string blob = 3; }
message ChangeUpload { string change_id = 1; bytes commit = 2; repeated TreeEntry entries = 3; }
message MissingBlobsRequest { string repo = 1; repeated string oids = 2; }
message MissingBlobsResult { repeated string oids = 1; }
message PutBlobsRequest { string repo = 1; repeated bytes blobs = 2; }
message PutBlobsResult { repeated string oids = 1; }
message FetchObjectsRequest {
  string repo = 1; repeated string wants = 2; repeated string haves = 3; repeated string shallow = 4;
}
message ObjectsHeader {
  string trunk_ref = 1; string trunk_commit = 2; uint64 pack_bytes = 3;
  repeated string shallow = 4; string author_name = 5; string author_email = 6;
  string forge_url = 7;
}
message FetchObjectsResponse { oneof frame { ObjectsHeader header = 1; bytes chunk = 2; } }
```

- `SubmitStackRequest` (RIG-5558 T3) takes `repeated ChangeUpload changes = 4`
  in place of `bytes bundle = 4`.
- `ForgeCallRequest` adds `missing_blobs = 20` and `put_blobs = 21`.
- `ForgeCallResult` adds `missing_blobs = 12` and `blobs_put = 13`.
- `AgentGateway` adds
  `rpc FetchObjects(FetchObjectsRequest) returns (stream FetchObjectsResponse)`.
- `RunnerService` adds `rpc RelayFetchObjects(RelayFetchObjectsRequest)
  returns (stream FetchObjectsResponse)`, with request
  `{string session_id = 1; FetchObjectsRequest request = 2;}`.

The Server side is in `go/server/vcs_objects.go`:

- `(s *forgeService) missingBlobs` and `putBlobs` are dispatched from
  `ExecuteForgeCallAsAccount`.
- `(s *forgeService) FetchObjects(ctx, caller store.AccountID, sessionID string, req *FetchObjectsRequest, send func(*FetchObjectsResponse) error) error`
  fetches trunk from GitHub first.
- A `runnerhub` relay leg and a gateway leg
  (`go/internal/runner/gateway/vcs_objects.go`) carry the stream.

Each call runs `requireForgeScope` first.

Red → green:

- an out-of-scope repo is not found;
- a want for another owner's version is not found;
- the stream sends a header, then chunks that index into a fresh repo;
- the per-session pack cap returns `resource_exhausted`.

### T4 — submit through the store

Interfaces: the RIG-5558 `submitStack` arm reads `changes`. For each
upload, parent first:

1. Run `Mirror.Diff`, then `checkChange`.
2. Run `EnsureVcsChange`.
3. Run `AddCommit`, then `AppendVcsVersion`.

The RIG-5558 checks follow. Each bookmark must point at an uploaded or
stored commit. Then come `Push` with a lease, `MarkVcsPushed`, and the PR
writes. When the line sits on a same-owner foreign PR (DL-536), the Server
`Rebase`s that PR as its owning agent and appends the version for that
agent. A PR seen as merged or closed triggers `CloseVcsChange` and
`DropVersions` for its changes.

D4 checks (`go/server/vcs_checks.go`):

```go
type Finding struct{ Path, Rule string }
func checkChange(patch []byte) ([]Finding, error)
```

- The added lines of each file in the change's own patch go to gitleaks as
  one `detect.Fragment`, via `detect.Detector.Detect`.
- The detector comes from `NewDetectorDefaultConfig()` with
  `IgnoreGitleaksAllow = true`, so a `gitleaks:allow` comment cannot skip
  the scan.
- Any path under `.github/workflows/` is a finding.
- A finding fails its entry and every entry above it with
  `failed_precondition`. No commit, ref, or row is written for them.

The pre-push hook (DL-538) gets the inputs a real push would give it: remote
`origin`, the header's `forge_url`, and the PR head from `stack_status` as
the remote sha (zeros for a new ref).

Red → green:

- a planted token fails, and so does the same token with `gitleaks:allow`;
- the failure text holds no token bytes;
- a workflow path fails;
- a refused upload leaves no ref and no row;
- a stale lease pushes nothing and leaves `pushed_at` NULL;
- a merged PR drops its version refs;
- the OQ-3 probe result is in the PR.

### T5 — agent tools

Interfaces: `packages/compass-agent/src/vcs.ts` (RIG-5558 T6–T7, built
against this record per OQ-6).

- `VcsDeps` gains
  `objects: (req: FetchObjectsRequest) => AsyncIterable<FetchObjectsResponse>`.
  It is wired in `transport/**`.
- New write tool `vcs_checkout {repo, dir?}`:
  1. Pipe the pack to `git index-pack --stdin`.
  2. Write `.git/shallow` and `refs/remotes/origin/<trunk_ref>`.
  3. Run `jj git init --colocate`.
  4. Set `user.name` and `user.email` with `jj config set --repo`.
  5. Run `jj new 'trunk()'`.
- `vcs_sync` replaces `jj git fetch` with a `FetchObjects` call:
  - wants: trunk and the latest versions of the foreign bases;
  - haves: the local trunk and own commits;
  - shallow: `.git/shallow`.

  It then updates the remote refs and runs the RIG-5558 rebase.
- `vcs_submit` sends `missing_blobs`, then `put_blobs` (batches of
  ≤ 15 MiB), then `submit_stack` with `changes`.
- The bookmark-keyed inputs are unchanged (OQ-4 b).
- No tool runs `jj git fetch`, `jj git push`, or `git push`.

Red → green (temp jj repo, fake transport):

- after checkout, `trunk()` is the header commit;
- submit sends only the missing blobs;
- sync fetches before it rebases;
- a sync conflict leaves jj conflict markers;
- no test spawns a network git command.

### T6 — egress, skill, and prompt cutover

- The `--egress-allow` help text in `go/cmd/compass-runner/main.go` changes
  from "Agents that push with jj-vine need github.com and api.github.com"
  to "Agents need api.github.com for `gh` reads; git goes through the
  Server."
- `gitCredentialPermissions` stays as RIG-5558 T9 leaves it:
  `contents: read`, `pull_requests: read`.
- `config/skills/jj/SKILL.md` replaces `jj git clone --colocate` with
  `vcs_checkout`.
- `config/prompts/manager/SYSTEM.md` says to start with `vcs_checkout`.

Red → green:

- `TestAgentImageVCSTools` (`go/e2e/image_toolchain_test.go`) still finds
  git and jj;
- an e2e agent whose egress allows only `api.github.com` checks out,
  submits, and gets a PR from the GitHub-shaped stub (DL-371);
- `git ls-remote` to GitHub from the agent fails.

## Tasks

- [ ] T1 — store: changes, versions, version CAS, read check
- [ ] T2 — mirror: intake, tree check, shallow packs, retention, caps
- [ ] T3 — proto, blob arms, and the object stream
- [ ] T4 — submit through the store; D4 checks; OQ-3 probe
- [ ] T5 — agent tools: `vcs_checkout`, sync and submit over the Server
- [ ] T6 — egress, skill, and prompt cutover

## Decisions

- **D1 — DL-578.** The Server holds agent history. The T10 mirror becomes
  the store, with change and version rows. Agents upload changesets, and
  the Server verifies and stores each commit.
- **D2 — DL-579.** The review unit stays the RIG-5558 segment. The Server
  pushes commits as made, and force-pushes with a lease only after a base
  move.
- **D3 — DL-580.** Agents fill and sync their jj repo only from the Server,
  and agent egress drops `github.com`.
- **D4 — DL-581.** The Server checks each change's own diff and headers at
  intake, before it writes anything.

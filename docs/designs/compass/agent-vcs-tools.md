# Compass agent VCS tools — commit, stack, and submit without raw git or jj

Tracker: RIG-5558

> Freezes on merge; later changes supersede by citation, never rewrite
> (convention: the `docs/designs/agent/compass-agent-config-delivery/design.md`
> header). Unless a path says otherwise, every path is in
> [RigelBuild/compass](https://github.com/RigelBuild/compass).

Ledger-impact: pending. D1–D4 file as DL-535..DL-538 when the open
questions close. DL-558 supersedes the DL-142 clause that keeps
`jj-vine submit` as the push path (T8). DL-559 supersedes the OQ-10 clause
of DL-442 (T9).

**Named decisions this record introduces:** D1–D4 in
[Decisions](#decisions).

## Open Questions

1. **OQ-8 (load-bearing) — where the push credential lives.** The Server
   mints a scoped App token and returns it as a file secret
   (`brokeredSecretResolver.ResolveFor` in `go/server/git_credential.go`:
   `Delivery: secrets.DeliveryFile`). `agentHost.Start` in
   `go/internal/runner/host.go` installs it in the agent home
   (`h.materializer.Install(ctx, handle.ID(), handle.HomeDir(), handle.WorkspaceUID(), resolved)`),
   and `go/internal/runtime/secrets_materialize.go` routes the gh credential
   to `~/.config/gh/hosts.yml`, "writing 0600 files". Any process with the
   agent UID can read it. A local OMP tool or a stdio MCP server runs as
   that UID with the same files as `bash`, so it is not a boundary. Runner
   egress is default-deny (`EgressPolicy.NftScript` in
   `go/internal/runtime/egress.go`: `policy drop`). The `--egress-allow` help
   in `go/cmd/compass-runner/main.go` says "Agents that push with jj-vine
   need github.com and api.github.com". `ForgeCallRequest`
   (`ExecuteForgeCallAsAccount` in `go/server/forge.go`) carries forge API
   calls, not git objects.
   - (a) Server push. `vcs_submit` sends a `git bundle` of the own commits
     (`<base>..<tips>`) in the `submit_stack` call. The Server applies it to
     a per-repo bare mirror and pushes with its own App token, then runs D2.
     The agent keeps a read-only token (`contents: read`,
     `pull_requests: read`) for clone and fetch; a raw push fails at the
     forge.
   - (b) Credential sidecar: a separate UID in the agent pod holds the write
     token and pushes; the tool calls it over a socket. This adds a process
     per agent and does not help OQ-6.
   - (c) Keep the agent push with the narrowed token now; move it later.

   **Recommendation: (a).** The write credential leaves the agent UID, and
   the Server holds the objects it needs for OQ-6. Limits: a bundle must fit
   one relay message (`runnerMaxReadBytes` in
   `go/internal/runnerhub/handler.go` is `agentmsg.MaxBytes + 1<<20`, 17 MiB),
   so a larger bundle is refused with that reason. Mirrors are usage-billed
   storage and need a per-repo size cap with a row in the spend-cap table.
   The Server rebase needs a VCS binary (T10). Fetch through the Server
   mirror is [future direction](#future-direction).
2. **OQ-2 (load-bearing) — what RIG-1882 becomes.** The push guard draft
   (RigelBuild/docs PR #13, DL-507..DL-510, not merged) blocks protected
   pushes, merges, and writes outside an owner allowlist.
   - (a) Narrow it: block every remote VCS write in `bash` and `eval` and
     name the tool to use.
   - (b) Keep the draft; redirect DL-510 to `vcs_submit`.
   - (c) Drop RIG-1882.

   **Recommendation: (c) if OQ-8 is (a), else (a).** Under OQ-8(a) the agent
   holds only read scopes, so the forge refuses a raw push, merge, or PR
   write, and the Server checks scope on every write it makes. A guard would
   only add a second refusal. Under OQ-8(c) the agent still holds a write
   token, and (a) is the narrow guard.
3. **OQ-9 — pre-push time limit.** Under the OQ-7 ruling, `vcs_submit` runs
   the repo's pre-push hook before push. (a) Fail open: after 120 s the tool
   stops the hook, pushes, and reports the timeout. (b) Fail closed: refuse
   the push.

   **Recommendation: (a).** CI on the PR is the main gate, and the hook only
   catches cheap mistakes early.

## Rulings

Matt ruled on 2026-10-17 in the review threads of RigelBuild/docs PR #39.

- **OQ-1 — agent token.** If the agent keeps any forge token, it has
  `pull_requests: read`. Raw PR edits fail; `gh` PR reads work.
- **OQ-3 — issue check.** The Server checks that the issue exists at
  create. Accepted formats are the user's own: GitHub `#12` and
  `owner/repo#12`, and a Linear key for any team the user has configured.
  No team key is hard-coded (D3).
- **OQ-4 — stack shape.** Linear only; `vcs_submit` refuses a fork (D4).
  GitHub's stacked-PR feature allows only linear lines.
- **OQ-5 — jj-vine cutover.** Close and resubmit. The cutover closes each
  open jj-vine PR and resubmits its line through the tools. The new PR body
  links the old PR; review history on the old PR is lost. There is no
  period where both paths run (T8, T9).
- **OQ-6 — another agent's PR in the line.** The Server manages the whole
  line. When a line holds a PR another agent authored under the same owner
  (DL-442: "grants are owner-level"), the Server rebases and pushes that
  bookmark and tells the owning agent. On a rebase conflict it pushes
  nothing and asks the owning agent to resolve. This needs the Server to
  hold the repo and push (OQ-8). The jj skill rule to "base the later
  change on the tip of the first PR's line" only worked around missing
  coordination.
- **OQ-7 — pre-push gate.** `vcs_submit` runs cheap format and lint checks
  through the repo's own configured hook runner, not a runner Compass picks.
  The Setup agent installs basic hooks in a repo that has none. CI on the
  PR is the main gate, because full suites do not fit small agent compute.
  Time limit: OQ-9.

## Problem / Intent

Compass agents drive version control with raw jj, git, gh, and
`jj-vine submit`. They spend turns on VCS mechanics, PRs can lack an issue,
and a PR body can carry two stack blocks. These tools write the PR title and
body, require an issue per PR, and let the Server own one stack block.

## Global Constraints

- The agent gains no credential. Every PR write and, under OQ-8(a), every
  push goes through the Server forge broker (DL-052).
- The Server alone writes the owner header (DL-050) and the stack block, and
  strips both from agent text.
- No `@connectrpc` import outside `packages/compass-agent/src/transport/**`.
- `jj` runs from an argument array with `--no-pager --color=never`; no editor.
- No agent tool rebases, tracks, or pushes another agent's bookmark; only
  the Server does (OQ-6 ruling).
- Write tools in one agent run one at a time.
- `vcs_*` are Manager tools; `subagent-tool-split.test.ts` is unchanged.
- PR numbers are `uint64` in Go, as in `forge.Provider`.
- Red → green: failing tests land first (`bun test`; Go `FakeProvider`,
  `pgtest`).
- Gate: `moon run :ci`; proto edits run `moon run compass-proto:gen`.
- T3 and T5 start after RigelBuild/compass#2354 (connect-go v2, RIG-5471)
  merges.
- Name no private repository or path.

## Approach

**D1 — hybrid split.** Local jj work runs in the agent
(`packages/compass-agent/src/vcs.ts`). PR writes run in the Server through
two new `ForgeCallRequest` arms. The push location depends on OQ-8; this
record describes the recommended shape, a Server push from a bundle
(T10). Seven tools:

| Tool | Approval | Does |
| --- | --- | --- |
| `vcs_status` | read | Stack from the base to the tip: change, commit, bookmark, subject, conflict, empty. |
| `vcs_commit` | write | Describes `@` (or `<workspace>@`) from fields, sets a bookmark, then `jj new <bookmark>`. |
| `vcs_workspace` | write | `add`, `forget`, or `update-stale` one subagent workspace. |
| `vcs_sync` | write | `jj git fetch`, then rebases the own commits onto the base (D4). Reports conflicts. |
| `vcs_submit` | write | Sync, D4 checks, pre-push hook, then `submit_stack` with a bundle of the own commits. |
| `vcs_retire` | write | Deletes one own local bookmark; the Server closes its PR and deletes that one remote branch. |
| `vcs_pr_status` | read | Calls `stack_status`: PR, state, draft, checks, and authorship per bookmark. |

Subagents edit files only. The Manager commits their work with
`vcs_commit {workspace}`, run in that workspace's root.

**D2 — PR writes through Server arms.** `createPullRequest` in
`go/server/forge.go` creates on the forge first, then records:

```go
pr, err := rf.author.CreatePullRequest(ctx, req.GetRepo(), forge.CreatePR{
// ...
if fe := s.recordPullRequest(ctx, rf, id, caller, sessionID, call.GetClientRequestId(), req.GetRepo(), pr, wire, link); fe != nil {
```

So a failed record leaves a PR with no ownership row.
`submit_stack` (field 17) takes entries bottom to top. Per entry:

1. Find the PR by head in any state, open first. The repo squash-merges and
   deletes merged branches, so a merged or closed hit refuses: "sync first".
2. On a miss, commit a submit intent (caller, repo, head) in its own
   transaction, then create a draft with the issue link through the
   `createPullRequest` steps. If the record fails after the create, the
   entry fails and the intent stays.
3. On an unrecorded hit, adopt the PR only if the intent names the caller:
   write the ownership row and the link, with no second create. Else the PR
   is foreign.
4. On an own hit, PATCH only changed fields: base, block, header, draft,
   and the text only on `replace_text`.

The first failed entry stops the call: later entries return `skipped`, and
no restamp runs. Otherwise the Server restamps each lower PR whose block
changed. Only `ready_head_ref` leaves draft. `stack_status` (field 18) is the
read twin.

Rows written here carry a NULL `client_request_id`.
`forge_authored_artifacts_request_memo_idx` is unique on
`(agent_account_id, client_request_id)`, so one call key would fail every
create after the first, after the forge create. The head lookup and the
intent are the idempotency.

Repo strings are canonical. The intent keys on `ForgeCoord.Normalized()`.
The ownership row stores the forge's `base.repo.full_name`, the string
webhooks key on (`wh.Repository.FullName`). `AuthoredArtifactByCoordinate`
matches `repo = $3` exactly, and `CreatePullRequestWithLink` "keeps the
caller's repo casing", so the new lookup folds GitHub case, as
`InsertPullRequestIfAbsent` does
(`CASE WHEN $1 = 1 THEN lower(s.repo) ELSE s.repo END`). When old rows
differ only in case, the oldest wins, as write-once authorship does.

Only the author updates a PR, with one exception (OQ-6 ruling): when a
foreign PR in the caller's line has an ownership row with the caller's
owner, the Server rebases that bookmark in its mirror, pushes it, restamps
only its block, and posts a message to the owning agent naming the new
head. On a conflict it pushes nothing, marks the entry failed, and asks the
owning agent to resolve. Any other foreign write is refused, as is every
write to an unrecorded PR the caller cannot adopt.

`vcs_retire` closes through `transition_pull_request_state`.
`transitionPullRequestState` goes from scope check to forge call with no
authorship check:

```go
if fe := s.requireForgeScope(ctx, caller, rf, req.GetRepo()); fe != nil {
// ...
pr, err := rf.author.TransitionPullRequestState(ctx, req.GetRepo(), req.GetPrNumber(), forge.TransitionState{State: req.GetState()})
```

T5 makes close fail closed: it runs only when an ownership row names the
caller. After the OQ-5 cutover every open PR was created by the tools, so a
PR with no row is a human's or a foreign App's, and refusing it is correct.

**D3 — issue and text.** Each PR names its own issue: #2334
("Refs RIG-5511") stacks on #2333 (RIG-5510). `vcs_submit` takes a
bookmark-to-issue map, required for bookmarks with no PR. The Server parses
the user's ref into `PullRequestIssueLink`, whose `repo` is "owner/name;
the team key on Linear". `refs.Parse` reads a Linear key (`TEAM-12`, any
2–10 character team key) or `owner/repo#12`; the tool expands a bare `#12`
to the PR's own repo first. `resolveIssueLink` in `go/server/forge.go`
refuses a forge with no provider: "forge: no provider configured for the
issue's coordinate". The Server then reads the issue with `GetIssue`. Not
found, including a team key the user has not connected, refuses. An outage
allows and says so.

The tools compose the agent's content. A segment's first commit is
`roots(<below>..<bookmark>)`. The title is its subject plus `(RIG-12)`; the
body is its description plus `Refs <issue>`. Only a first commit takes
`sections`, one per `.github/PULL_REQUEST_TEMPLATE.md` heading, checked
against the template limits. Text is written at create and kept until
`vcs_submit {text}` replaces it, because the jj skill says "Never amend a
pushed commit".

**D4 — stack, sync, and one block.** The own commits are
`::<tip> ~ ::(trunk() | untracked_remote_bookmarks())`. The tip is the
`bookmark` input, else the one bookmark on `@` or `@-`. An untracked remote
bookmark is another agent's branch, immutable by jj's default; own commits
on one have a foreign base.

Sync runs `jj git fetch --remote origin`, then
`jj rebase -s 'roots(<own>)' -o <base> --skip-emptied`, where `<base>` is
`trunk()` or `<foreign>@origin`. In jj 0.45.1, `--skip-emptied` drops a
squash-landed commit and fetch does not follow an advanced foreign base.
Sync tracks a remote bookmark only if `stack_status` says the caller
authored its PR.

Before push the tool refuses conflicts, merges, empty descriptions, two
bookmarks on one commit, unpublished commits above the tip, and a fork:
`(descendants(<own>) & bookmarks()) ~ ::<tip>` is not empty. It then runs
`git hook run --ignore-missing pre-push` in the colocated repo root, so the
repo's own hook runner decides what runs; OQ-9 bounds the time.
`jj git push` runs no git hooks (jj 0.45.1, checked), so the tool calls the
hook itself.

Under OQ-8(a), `vcs_submit` runs `git bundle create` for
`<base>..<own bookmarks>` and sends it with `submit_stack`. The Server
fetches the bundle into its mirror, checks that each bookmark's commit is
in it, and pushes the own bookmarks with its App token before the PR
writes. A foreign base must already be on the forge.

Each bookmark is one PR, based on the bookmark below, the foreign base, or
trunk. The block sits between `<!-- compass:stack -->` and
`<!-- /compass:stack -->` below the owner header. Before each write the
Server strips every compass and jj-vine block in a loop, because
`remove_jj_vine_stack_from_description` in jj-vine matches only one pair.

**Alternatives.** An agent-side push keeps a write token on the agent UID
(OQ-8). Wrapping jj-vine keeps agent-token PR writes.

## Plan

### T1 — provider update and lookup

Interfaces (`go/internal/forge/provider.go`):

```go
type UpdatePR struct {
	Title   string
	Body    string
	BaseRef string
	Ready   bool
}

UpdatePullRequest(ctx context.Context, repo string, number uint64, u UpdatePR) (PullRequest, error)
FindPullRequestByHead(ctx context.Context, repo, headRef string) (PullRequest, bool, error)
```

GitHub PATCHes `/repos/{repo}/pulls/{n}`; `Ready` runs GraphQL
`markPullRequestReadyForReview` with a new `NodeID` (`json:"node_id"`) on
`ghPullDetail`. Both `ghPull` (the create response, whose `Base` holds only
`Ref` today) and `ghPullDetail` gain `Base.Repo.FullName`
(`json:"full_name"`), surfaced as `PullRequest.RepoFullName`, so a create
records the canonical name with no extra read. Lookup:
`GET /repos/{repo}/pulls?state=all&head=<owner>:<ref>`; merged means
non-null `merged_at`. Linear returns `ErrUnsupported`. Red → green
(`httptest`): PATCH body, ready, hit, miss, merged, `full_name` on create
and on read, 422, Linear.

### T2 — stack block

Interfaces (`go/internal/forge/stack.go`):

```go
type StackLine struct {
	Number uint64
	Title  string
}

func RenderStack(lines []StackLine, self uint64) string
func StripStack(body string) string
func StampStack(body, block string) string
```

Red → green: two jj-vine pairs and one compass pair yield one block; an
unclosed marker stays text; `StampStack` is idempotent, header first.

### T3 — proto

Interfaces (`proto/compass/v1/agent_gateway.proto`):

```proto
message StackEntry {
  string head_ref = 1;
  string base_ref = 2;
  string title = 3;
  string body = 4;
  string issue_ref = 5;  // user's format; required when the PR is created
  bool replace_text = 6;
}
message SubmitStackRequest {
  string repo = 1;
  repeated StackEntry entries = 2;  // bottom to top
  string ready_head_ref = 3;        // empty = no entry leaves draft
  bytes bundle = 4;                 // git bundle of the own commits (OQ-8a)
}
message RetireHeadRequest {
  string repo = 1;
  string head_ref = 2;
}
message StackStatusRequest {
  string repo = 1;
  repeated string head_refs = 2;
}
enum StackEntryStatus {
  STACK_ENTRY_STATUS_UNSPECIFIED = 0;
  STACK_ENTRY_STATUS_DONE = 1;
  STACK_ENTRY_STATUS_FAILED = 2;
  STACK_ENTRY_STATUS_SKIPPED = 3;  // an entry below failed
}
message StackEntryResult {
  string head_ref = 1;
  compass.v1.PullRequest pull_request = 2;
  bool created = 3;
  bool authored = 4;  // the caller authored this PR
  ForgeCallError error = 5;
  StackEntryStatus status = 6;
}
message StackResult {
  repeated StackEntryResult entries = 1;
}
```

`ForgeCallRequest` adds `submit_stack = 17`, `stack_status = 18`,
`retire_head = 19`; `ForgeCallResult` adds `stack = 11`. The
`client_request_id` comment ("oneof arms 2-11, 14-16") becomes
`2-11, 14-19`. Red → green: buf gates.

### T4 — store: submit intent and case-folded lookup

Interfaces (`go/internal/store/forge_authored.go`):

```go
type SubmitIntent struct {
	Provider       ForgeProvider
	Host           string // ForgeCoord.Host, as forgeCoordinate resolves it
	Repo           string // ForgeCoord.Normalized()
	HeadRef        string
	AgentAccountID AccountID
	OwnerUserID    AccountID
}

// ErrConflict when another agent holds the head.
func (s *Store) RecordSubmitIntent(ctx context.Context, in SubmitIntent) error
// ErrNotFound on a miss.
func (s *Store) SubmitIntentForHead(ctx context.Context, provider ForgeProvider, host, repo, headRef string) (SubmitIntent, error)
// Folds GitHub case; the oldest row wins.
func (s *Store) AuthoredArtifactByCoordinateFold(ctx context.Context, provider ForgeProvider, host, repo string, kind ForgeArtifactKind, number uint64) (AuthoredArtifact, error)
```

Table `forge_pr_submit_intents` in `migrations/0001_init.sql`: PK
`(tenant_id, forge_provider, forge_host, repo, head_ref)`, the
`forge_authored_artifacts` agent/owner FK, RLS; sqlc queries in
`queries/forge_authored.sql`. `RecordSubmitIntent` commits on its own.
Existing rows need no backfill. Red → green (`pgtest`): another agent's
intent conflicts; a retry succeeds; the same repo and head on two hosts are
two intents; mixed case finds the row; two rows that differ only in case
return the oldest.

### T5 — Server arms

Interfaces (`go/server/forge.go`):

```go
func (s *forgeService) submitStack(ctx context.Context, caller store.AccountID, sessionID string, call *compassv1internal.ForgeCallRequest, req *compassv1internal.SubmitStackRequest) *compassv1internal.ForgeCallResult
func (s *forgeService) stackStatus(ctx context.Context, caller store.AccountID, call *compassv1internal.ForgeCallRequest, req *compassv1internal.StackStatusRequest) *compassv1internal.ForgeCallResult
func (s *forgeService) retireHead(ctx context.Context, caller store.AccountID, call *compassv1internal.ForgeCallRequest, req *compassv1internal.RetireHeadRequest) *compassv1internal.ForgeCallResult
```

`forgeStore` adds the T4 methods; `transitionPullRequestState` gains the D2
authorship refusal. `submitStack` resolves `issue_ref` and checks it with
`GetIssue` (D3). Red → green (`FakeProvider`, T10 fake mirror):

- A new entry without `issue_ref` fails; two entries make two drafts with
  chained bases; a retry creates nothing; a merged head refuses.
- `TEAM-12` for an unconfigured team and a not-found issue refuse; an
  outage allows with a warning.
- Two new entries under one call key: two PRs, two rows with a NULL key.
- The store write after a create fails; a retry ends with one PR on the
  forge and one ownership row.
- An unchanged entry sends no PATCH; an agent-written block is replaced.
- A mid-stack 429: earlier entries done, that entry failed, later entries
  skipped with no provider call.
- Only `ready_head_ref` leaves draft.
- A same-owner foreign PR in the line is rebased, pushed, and restamped,
  and its agent gets a message; a conflict pushes nothing and asks that
  agent to resolve; a different-owner foreign PR is refused.
- A same-scope close of a PR another agent authored, and of a PR with no
  row, is refused with no provider call; the author's own close runs.
- `retireHead` closes an own PR and deletes only that branch; a retry after
  either step finishes with no second close; a foreign head refuses.

### T6 — jj runner and local tools

Interfaces (`packages/compass-agent/src/vcs.ts`):

```ts
export interface JjResult { stdout: string; stderr: string; code: number }
export interface JjRunner {
  run(args: readonly string[], cwd: string): Promise<JjResult>;
}
export interface VcsDeps { jj: JjRunner; cwd: string; forge: ForgeBroker }
export function ownCommits(tip: string): string; // D4 revset
export function createVcsTools(deps: VcsDeps): AgentTool[];
// vcs_status    { bookmark?: string; workspace?: string }
// vcs_commit    { bookmark: string; subject: string; sections?: Record<string, string>; text?: string; workspace?: string }
// vcs_workspace { action: "add" | "forget" | "update-stale"; name: string; base?: string }
// vcs_sync      { bookmark?: string }
```

Rows come from one `jj log --no-graph` call with a `json(self)` template.
Red → green (fake `JjRunner`): exact argument arrays; a first commit missing
a heading fails; `vcs_commit` ends with `jj new <bookmark>`; fetch precedes
the rebase; a foreign base is never a rebase source; a conflict is reported.

### T7 — submit, retire, PR status, and wiring

```ts
// vcs_submit    { bookmark?: string; issues?: Record<string, string>; ready?: boolean;
//                 text?: { bookmark: string; subject: string; sections: Record<string, string> } }
// vcs_retire    { bookmark: string }
// vcs_pr_status { bookmark?: string }
```

`vcs_submit` syncs, checks, runs the pre-push hook (D4, OQ-9), builds the
bundle, then calls `submit_stack` (`ready_head_ref` = tip on `ready`); it
refuses trunk and a bundle over the relay limit. `vcs_retire` calls
`retire_head`, then deletes the local bookmark and fetches. A closed PR
with no `<name>@origin` returns success, so a retry is safe.
`packages/compass-agent/src/cli.ts` adds the tools to `nativeTools`.
Red → green: each D4 refusal and a missing issue fail before the broker
call; a hook failure refuses; a hook that runs past the OQ-9 limit is
stopped and reported; the bundle names every own bookmark; `vcs_retire`
changes no local state when `retire_head` fails.

### T8 — prompt, skill, cutover, and DL-558

`config/prompts/manager/SYSTEM.md` and `config/skills/jj/SKILL.md` name the
tools and drop `jj-vine submit` and `jj-hp`. Red → green:
`packages/compass-agent/src/vcs-prompt.test.ts` fails on `jj-vine submit`.
The Setup agent's prompt installs a basic pre-push hook (format and lint)
in a repo that has none. Cutover (OQ-5): for each open jj-vine PR, the
owning agent resubmits its line through `vcs_submit` with new bookmark
names, the new body links the old PR, and the old PR is closed with a link
to the new one.

### T9 — remove jj-vine and narrow the token

Runs after the T8 cutover. Drop `jjVine` and `[jj-vine]` from
`agent-image/toolchain.nix` (`TestAgentImageVCSTools` in
`go/e2e/image_toolchain_test.go` expects it absent). Set
`gitCredentialPermissions` to `contents: read`, `pull_requests: read`,
pinned in `git_credential_test.go` first. The agent egress allowlist keeps
`github.com` and `api.github.com` for fetch and `gh` reads; the read-only
token is what blocks writes. Files DL-559.

### T10 — Server mirror and push

Interfaces (`go/internal/forge/mirror.go`):

```go
type Mirror interface {
	ApplyBundle(ctx context.Context, repo string, bundle []byte) error
	Push(ctx context.Context, repo string, refs map[string]string) error // ref -> commit; "" deletes
	Rebase(ctx context.Context, repo, ref, onto string) (newHead string, conflict bool, err error)
}
```

A per-repo bare git repo on Server storage with a per-repo size cap,
fetched from the forge before each apply and pushed with the App token.
`Push` pushes only the refs it is given, with a lease on the old commit.
`Rebase` uses `git replay`. The Server image gains `git`. The spend-cap
table gains a mirror storage row. Red → green (temp repos): a bundle with
missing commits refuses; a stale lease refuses; a conflicting rebase
returns `conflict` and pushes nothing; a repo over its cap refuses.

## Tasks

- [ ] T1 — provider update and lookup
- [ ] T2 — stack block
- [ ] T3 — proto
- [ ] T4 — store: submit intent and case-folded lookup
- [ ] T5 — Server arms
- [ ] T6 — jj runner and local tools
- [ ] T7 — submit, retire, PR status, and wiring
- [ ] T8 — prompt, skill, cutover, and DL-558
- [ ] T9 — remove jj-vine and narrow the token
- [ ] T10 — Server mirror and push

## Future direction

Out of scope. The Server mirror in T10 can grow into the remote agents talk
to instead of the forge: the Server runs extra checks before anything
leaves, which matters most for public repos, and keeps git and GitHub
compatibility because users stay on GitHub. Agents would then fetch from
the mirror too. References: [Redesigning source
control](https://www.anthropic.com/engineering/redesigning-source-control)
(server-side commits and rebases, clients always online) and
[Twigg](https://github.com/twigg-vc/monorepo) (open-source stacked-change
review with a git mirror).

## Decisions

- **D1** (DL-535 on ruling) — Local jj in the agent; PR writes and, per
  OQ-8, push in the Server; seven Manager tools.
- **D2** (DL-536 on ruling) — Any-state head lookup, a durable intent
  before create, author-only updates and closes, and Server-managed
  same-owner foreign PRs in a line.
- **D3** (DL-537 on ruling) — An issue per PR in the user's formats,
  checked to exist; text composed once.
- **D4** (DL-538 on ruling) — Linear lines, sync, the repo's own pre-push
  hook, and one Server-owned stack block.

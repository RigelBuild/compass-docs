# Compass agent VCS tools — commit, stack, and submit without raw git or jj

Tracker: RIG-5558

> Freezes on merge; later changes supersede by citation, never rewrite
> (convention: the `docs/designs/agent/compass-agent-config-delivery/design.md`
> header). Unless a path says otherwise, every path is in
> [RigelBuild/compass](https://github.com/RigelBuild/compass).

Ledger-impact: pending. D1–D4 file as DL-535..DL-538 when Matt rules.
DL-558 supersedes the DL-142 clause that keeps `jj-vine submit` as the push
path (T8). DL-559 supersedes the OQ-10 clause of DL-442 unless OQ-1 is (c)
(T9).

**Named decisions this record introduces:** D1–D4 in
[Decisions](#decisions).

## Open Questions

1. **OQ-1 (load-bearing) — narrow the agent token.** DL-442 (OQ-10) keeps
   `pull_requests: write` because "agents must be able to open pull
   requests". After D2 the agent writes no PR.
   - (a) `pull_requests: read`. Raw PR edits fail; `gh` PR reads work.
   - (b) No `pull_requests`. `gh pr view` fails too.
   - (c) Keep `write`. Any process can still edit a PR.

   **Recommendation: (a).** The push guard draft kept `write` only because
   a narrower token "breaks `jj-vine submit` PR creation".
2. **OQ-2 (load-bearing) — what RIG-1882 becomes.** The push guard draft
   (RigelBuild/docs PR #13, DL-507..DL-510, not merged) blocks protected
   pushes, merges, and writes outside an owner allowlist.
   - (a) Narrow it: block every remote VCS write in `bash` and `eval` and
     name the tool to use. Drop the allowlist; the Server checks scope.
   - (b) Keep the draft; redirect DL-510 to `vcs_submit`.
   - (c) Drop RIG-1882.

   **Recommendation: (a).** Simpler and stricter. `vcs_retire` covers branch
   deletion, so no carve-out is needed.
3. **OQ-3 (load-bearing) — issue check.** `resolveIssueLink` in
   `go/server/forge.go` checks shape only, "so a tracker outage never fails
   a PR create". `RIG-99999` passes.
   - (a) Forge issue, read with `GetIssue` at create. Not found refuses; an
     outage allows and says so.
   - (b) Forge issue, shape only.
   - (c) Also a Compass board issue id.

   **Recommendation: (a).** "Always an issue" then means a real issue.
4. **OQ-4 (load-bearing) — stack shape.** (a) Linear only, refusing a fork
   (D4). (b) Trees.

   **Recommendation: (a).** The merge queue accepts linear lines only.
5. **OQ-5 (load-bearing) — jj-vine cutover.** Open jj-vine PRs have no
   ownership row, so D2 treats them as foreign.
   - (a) Coexist. T8 keeps a jj-vine section; T9 waits until no jj-vine PR
     is open.
   - (b) Close and resubmit. Review history is lost.
   - (c) Adopt on first submit. Agent pushes and Server creates use one App:
     `forge.NewScopedAppMinter` in `go/server/git_credential.go` and
     `forge.NewAppTokenSource` in `go/server/serve.go` both take
     `rc.App.AppID`. `ListMirrorComments` in `go/server/forge_mirror.go`
     reads that login through an optional `AppLogin` assertion, not a
     `forge.Provider` method. The forge author cannot name the agent, so
     the claim cannot be checked.

   **Recommendation: (a).** No lost history, no unchecked claim.
6. **OQ-6 (load-bearing) — another agent's PR in the line.** The jj skill
   says to "base the later change on the tip of the first PR's line". No
   tool rebases or pushes a foreign bookmark (D4).
   - (a) The Server writes only the caller's PRs; a foreign block lags.
   - (b) It also restamps the block, and only the block, in a foreign PR
     with the same owner. DL-442 rules "grants are owner-level".
   - (c) Refuse the line.

   **Recommendation: (b).** One block everywhere; D2 limits the write to the
   block.
7. **OQ-7 (load-bearing) — pre-push gate.** The jj skill says "Every push
   runs the local gate first, through `jj-hp`". The image ships no `jj-hp`
   (`agent-image/toolchain.nix`), and `jj git push` runs no git hooks
   (jj 0.45.1, checked).
   - (a) `vcs_submit` runs `hk run pre-push` (`moon ci`) with a time limit.
   - (b) CI and the merge queue are the gate; T8 drops the promise.

   **Recommendation: (b).** It states what runs today; (a) blocks one call
   for minutes.

## Problem / Intent

Compass agents drive version control with raw jj, git, gh, and
`jj-vine submit`. They spend turns on VCS mechanics, PRs can lack an issue,
and a PR body can carry two stack blocks. These tools write the PR title and
body, require an issue per PR, and let the Server own one stack block.

## Global Constraints

- No new agent credential. Push uses the RIG-4724 token; every PR write goes
  through the Server forge broker (DL-052).
- The Server alone writes the owner header (DL-050) and the stack block, and
  strips both from agent text.
- No `@connectrpc` import outside `packages/compass-agent/src/transport/**`.
- `jj` runs from an argument array with `--no-pager --color=never`; no editor.
- No tool rebases, tracks, or pushes another agent's bookmark.
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

**D1 — hybrid split.** Local jj work and push run in the agent
(`packages/compass-agent/src/vcs.ts`). PR writes run in the Server through
two new `ForgeCallRequest` arms. Seven tools:

| Tool | Approval | Does |
| --- | --- | --- |
| `vcs_status` | read | Stack from the base to the tip: change, commit, bookmark, subject, conflict, empty. |
| `vcs_commit` | write | Describes `@` (or `<workspace>@`) from fields, sets a bookmark, then `jj new <bookmark>`. |
| `vcs_workspace` | write | `add`, `forget`, or `update-stale` one subagent workspace. |
| `vcs_sync` | write | `jj git fetch`, then rebases the own commits onto the base (D4). Reports conflicts. |
| `vcs_submit` | write | Sync, D4 checks, push of the own bookmarks, then `submit_stack`. |
| `vcs_retire` | write | Closes one own PR through the Server, deletes its bookmark, pushes that one deletion. |
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

Only the author updates a PR, with one exception if OQ-6 is (b): when a
foreign PR's ownership row names the caller's owner, the Server rewrites its
stack block only. It strips the compass and jj-vine blocks, stamps the new
block, and keeps every other byte. Any other foreign write is refused, as is
every write to an unrecorded PR the caller cannot adopt.

`vcs_retire` closes through `transition_pull_request_state`.
`transitionPullRequestState` goes from scope check to forge call with no
authorship check:

```go
if fe := s.requireForgeScope(ctx, caller, rf, req.GetRepo()); fe != nil {
// ...
pr, err := rf.author.TransitionPullRequestState(ctx, req.GetRepo(), req.GetPrNumber(), forge.TransitionState{State: req.GetState()})
```

T5 makes close fail closed: it runs only when an ownership row names the
caller. A PR with no row, such as a jj-vine PR under OQ-5(a), is refused;
during coexistence its author closes it outside the tools.

**D3 — issue and text.** Each PR names its own issue: #2334
("Refs RIG-5511") stacks on #2333 (RIG-5510). `vcs_submit` takes a
bookmark-to-issue map, required for bookmarks with no PR. The Server parses
the raw ref with `refs.Parse` and maps it as `resolveMirrorCoordinate` in
`go/server/forge_mirror.go` does: tracker key to Linear, `owner/repo#12` to
GitHub.

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
squash-landed commit, fetch does not follow an advanced foreign base, and a
push over a foreign name fails ("Non-tracking remote bookmark fx@origin
exists"). Sync tracks a remote bookmark only if `stack_status` says the
caller authored its PR.

Before push the tool refuses conflicts, merges, empty descriptions, two
bookmarks on one commit, unpublished commits above the tip, and a fork:
`(descendants(<own>) & bookmarks()) ~ ::<tip>` is not empty.

Each bookmark is one PR, based on the bookmark below, the foreign base, or
trunk. The block sits between `<!-- compass:stack -->` and
`<!-- /compass:stack -->` below the owner header. Before each write the
Server strips every compass and jj-vine block in a loop, because
`remove_jj_vine_stack_from_description` in jj-vine matches only one pair.

**Alternatives.** Server-side push waits on RIG-4433. Wrapping jj-vine keeps
agent-token PR writes. GitHub native stacks can follow once their
merge-queue effect is checked.

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
  string issue_ref = 5;  // refs grammar; required when the PR is created
  bool replace_text = 6;
}
message SubmitStackRequest {
  string repo = 1;
  repeated StackEntry entries = 2;  // bottom to top
  string ready_head_ref = 3;        // empty = no entry leaves draft
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

`ForgeCallRequest` adds `submit_stack = 17`, `stack_status = 18`;
`ForgeCallResult` adds `stack = 11`. The `client_request_id` comment
("oneof arms 2-11, 14-16") becomes `2-11, 14-18`. Red → green: buf gates.

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
```

`forgeStore` adds the T4 methods; `transitionPullRequestState` gains the D2
authorship refusal. Red → green (`FakeProvider`):

- A new entry without `issue_ref` fails; two entries make two drafts with
  chained bases; a retry creates nothing; a merged head refuses.
- Two new entries under one call key: two PRs, two rows with a NULL key.
- The store write after a create fails; a retry ends with one PR on the
  forge and one ownership row.
- An unchanged entry sends no PATCH; an agent-written block is replaced.
- A mid-stack 429: earlier entries done, that entry failed, later entries
  skipped with no provider call.
- Only `ready_head_ref` leaves draft.
- Under OQ-6(b), a same-owner foreign body changes only inside the block; a
  foreign title, base, draft, or `replace_text` write and a different-owner
  foreign PR are refused.
- A same-scope close of a PR another agent authored, and of a PR with no
  row, is refused with no provider call; the author's own close runs.

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

`vcs_submit` syncs, checks, runs `jj git push --remote origin -b <own>…`,
then `submit_stack` (`ready_head_ref` = tip on `ready`); it refuses trunk.
`vcs_retire` refuses a PR it did not author. Before any write it runs
`jj git push --deleted --dry-run --remote origin` and refuses if any
bookmark or tag is already pending deletion (`--deleted` pushes all of
them). It then closes the PR through `transition_pull_request_state`, runs
`jj bookmark delete <name>`, repeats the dry run, checks the plan deletes
exactly `<name>`, and runs `jj git push --deleted --remote origin`.
(`-b <name>` does not push a deleted bookmark.)
`packages/compass-agent/src/cli.ts` adds the tools to `nativeTools`.
Red → green: each D4 refusal and a missing issue fail before push; push
precedes the broker call; `vcs_retire` deletes exactly one remote ref; a
pending deletion of another ref refuses with no close and no local change.

### T8 — prompt, skill, and DL-558

`config/prompts/manager/SYSTEM.md` and `config/skills/jj/SKILL.md` name the
tools and drop `jj-vine submit` and `jj-hp`, except the OQ-5(a) section.
Red → green: `packages/compass-agent/src/vcs-prompt.test.ts` fails on
`jj-vine submit` outside that section.

### T9 — remove jj-vine and narrow the token

Gated on OQ-5 and OQ-1. Drop `jjVine` and `[jj-vine]` from
`agent-image/toolchain.nix` (`TestAgentImageVCSTools` in
`go/e2e/image_toolchain_test.go` expects it absent). Set
`gitCredentialPermissions` per OQ-1, pinned in `git_credential_test.go`
first. Files DL-559.

## Tasks

- [ ] T1 — provider update and lookup
- [ ] T2 — stack block
- [ ] T3 — proto
- [ ] T4 — store: submit intent and case-folded lookup
- [ ] T5 — Server arms
- [ ] T6 — jj runner and local tools
- [ ] T7 — submit, retire, PR status, and wiring
- [ ] T8 — prompt, skill, and DL-558
- [ ] T9 — remove jj-vine and narrow the token

## Decisions

- **D1** (DL-535 on ruling) — Local jj and push in the agent; PR writes in
  the Server; seven Manager tools.
- **D2** (DL-536 on ruling) — Any-state head lookup, a durable intent
  before create, and updates and closes only by the author.
- **D3** (DL-537 on ruling) — An issue per PR; text composed once.
- **D4** (DL-538 on ruling) — Sync without rewriting foreign bookmarks; one
  Server-owned stack block.

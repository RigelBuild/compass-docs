# Repair commit statuses left pending after a pipeline ends (RIG-3462)

## Open Questions

1. **Index on `pipelines.updated`.** T1 indexes `updated`, which the
   candidate query filters on. xorm `Sync` builds it at startup; on
   Postgres the build blocks writes to `pipelines`. Without it, each pass
   scans the terminal rows. **Recommendation:** add it. Decision needed:
   approve the index, or accept the scan.
2. **Which delivered states to repair.** Independent of Q1. Two losses do
   not leave `pending`. An outage can lose both writes, so the context is
   `absent`. And `Restart` (server/pipeline/restart.go) makes a new
   pipeline on the same commit; if its writes drop, the old final state
   stays, for example a false `success`.
   - **A.** Repair `pending` only.
   - **B.** Repair `pending` and `absent`. A final state unlike the stored
     verdict gives `mismatch` and a `warn` line, with no write.
   - **C.** Repair `pending`, `absent` and a final mismatch.

   **Recommendation:** B. `absent` blocks a merge like `pending`. A mismatch
   write is safe only with no other writer, and the `mismatch` count shows
   that first. Decision needed: A, B or C. D2 assumes B.

## Decisions

D2 waits on Q2.

- **D1** (DL-565) — Owned contexts: the aggregate when `StatusAggregate` is on, and
  the meta context when `StatusMeta` is on and a pull request pipeline has a
  meta gate. Per-workflow contexts and `pull_request_closed` pipelines are
  out of scope.
- **D2** (DL-566) — Repair when the pipeline is terminal, owns the context, and
  GitHub shows `pending` or `absent` (Q2 option B). Liveness is never used.
- **D3** (DL-567) — Delivered state: the combined status of the SHA, about one
  request per finished pipeline.
- **D4** (DL-568) — Supersede: a store check for a later owner, then, for a pull
  request pipeline, a head read before the delivered read. Both run again
  under the key lock before the write.
- **D5** (DL-569) — Repairs use the existing posters with one write attempt. A
  refresher skip returns `types.ErrSuperseded`.
- **D6** (DL-570) — Cadence `2m`. Candidates were updated in the last `3h` but not
  the last `2m`. `3h` covers a one-hour quota outage, as in RIG-3462, plus
  a restart.
- **D7** (DL-571) — Memory: one entry per pipeline, in process. A restart sweeps the
  lookback again.
- **D8** (DL-572) — Budget: at most `30` GitHub requests per pass, token mints
  and retries included. Quota below 20 % or a rate-limit error ends the pass.
- **D9** (DL-573) — The third failed write gives `gave_up`. Open work that leaves
  the lookback gives `expired`.
- **D10** (DL-574) — Metrics: a results counter, a calls counter, a backlog gauge.
- **D11** (DL-575) — A single server replica is a correctness requirement.
- **D12** (DL-576) — Tests use a hand-written fake forge. `MockForge` lacks optional
  capabilities.

## Problem / Intent

`updatePipelineStatus` (server/pipeline/helper.go) and
`RPC.updateForgeStatus` (server/rpc/rpc.go) post the required statuses. A
write is lost when `doForgeWrite` (server/forge/github/retry.go) gives up
after 4 attempts in 30 s, or when a restart stops `reportForgeStatusAsync`.
Both callers only log. One run lost 1 of 3 contexts. The check stays
`pending` and blocks the merge until a person restarts the pipeline.

Intent: on a cadence, post the stored verdict again for terminal pipelines
whose owned context is not final on GitHub, at a bounded quota cost.
Write coalescing, the other half of RIG-3462, is out of scope.

## Approach

### Where it runs

`StatusReconciler` lives in server/pipeline/status_reconcile.go.
cmd/server/server.go runs it like the orphan reaper: a pass at start, one
per tick, a stop on `ctx.Done()`.

### One pass

1. Prune the memory. `GetTerminalPipelinesUpdated(now-lookback,
   now-settle)` gives the candidates, newest first. It uses `updated`:
   `UpdateToStatusDeclined` leaves `Finished` at `0`, and xorm sets
   `updated` on every `UpdatePipeline`.
2. Per repo, once per pass: `GetRepo`, `GetUser(repo.UserID)`,
   `Manager.ForgeFromRepo` and `forge.Refresh`. An inactive repo needs no
   forge call. No `forge.StatusReader` gives `unsupported`.
3. `GetPipeline`, then `ownedContexts` (D1).
4. Store check per context (D4). A later owner gives `superseded`.
5. Pull request pipelines: `PullRequestHead`. A moved head gives
   `superseded`; a pull request that is not open gives `closed`.
6. `DeliveredStatuses` against `ExpectedState`. Equal gives `clean`, another
   final state `mismatch`, and `unknown` `incomplete`. `pending` and
   `absent` go on.
7. `forge.RepairAggregateStatus` or `forge.RepairMetaStatus`, fenced by
   steps 4 and 5 again, gives `reposted`, `superseded`, or `write_error`.
8. A failed read gives `read_error`. `types.ErrQuotaLow` and
   `types.ErrBudgetSpent` end the pass.

### Memory

Each entry holds the pipeline's `updated`; a change resets it.

- Done: `clean`, `reposted`, `mismatch`, `incomplete`, `gave_up`,
  `unsupported`, a moved head, an inactive repo, or no owned context.
- Read again after 15 minutes: `superseded` by a later owner or the fence,
  and `closed`. A later owner can be deleted; a pull request can open again.
- Open, read next pass: `read_error`, `write_error`, and not reached. The
  third `write_error` gives `gave_up`.
- At pass start, an entry whose `updated` left the lookback is removed. An
  open one gives `expired`. The backlog gauge counts open entries.

### Budget

- `forge.WithReconcile(ctx, maxCalls)` marks the pass context and holds its
  budget. `rateLimitObserver.RoundTrip` (server/forge/github/ratelimit.go)
  wraps every GitHub client, the App JWT client too. It calls
  `forge.SpendCall` before each request; a spent budget gives
  `types.ErrBudgetSpent` and sends nothing. So `max-calls` caps real
  requests, an unplanned retry or mint included. `forge.Refresh` uses the
  OAuth endpoint, not the API.
- Before each step, the reconciler adds the step's reserve to the real
  count and ends the pass if it exceeds `max-calls`: 3 for a status read,
  1 for a head read, 1 for a write, 1 for a fence's head read. A repo's
  first status read in a pass adds 2 for the App token mint
  (`GetRepositoryInstallation`, `CreateInstallationToken`); later steps
  share the token. The forge client and its token cache last 10 minutes
  (`forgeCacheTTL`, server/services/manager.go), so mints are common.
- The worst pipeline costs 10: a mint, 3 pages, a head read and two fenced
  writes. So `max-calls` has a minimum of `10`. The default `30` allows at
  most 900 requests an hour.
- `Remaining` below 20 % of `Limit` on a read, or a rate-limit error, gives
  `types.ErrQuotaLow` and leaves the last fifth to the live path. Repair
  writes make one attempt, to spare the secondary limit.
- Servers on one App share each installation's limit: the floor sees the
  shared `Remaining`, but `max-calls` caps only this server.

### Races

- **Write order.** Every write to a context runs under the per-context key
  lock in `statusDedupe.post` (server/forge/github/status_dedupe.go), with
  the refresher inside it. Live writes and reposts land in decision order
  with the same verdict, so the worst case is a duplicate.
- **A later pipeline on the same SHA.** It owns the aggregate when its
  event renders the same context; with `{{ .context }}`, every event does.
  Step 4 and the fence then skip. A pipeline created after the fence posts
  its pending under the key lock, after the repost.
- **A moved pull request head.** Step 5 runs before the delivered read, so
  a stale-head pipeline is never `clean` or `mismatch`. The fence reads the
  head again under the key lock, just before the POST. A head that moves
  after that read leaves the post on a SHA the merge no longer checks.
- **A stale `created` row.** A restart during creation leaves it; it never
  posts. Both later-owner checks ignore it after `CreationTimeout`.
- **Replicas (D11).** The key lock is per process. With two replicas, a
  repost is not ordered against the other replica's live write, and can
  hide a newer pending until that pipeline ends.

### Reading GitHub

`DeliveredStatuses` (server/forge/github/status_read.go) uses
`requiredStatusClient`, the token of the writes. It reads at most 3 pages;
a context not found is `absent` only after the last page, else `unknown`.
`ExpectedState` applies `convertStatus`, so `canceled` compares as
`success`. `PullRequestHead` uses `common.UserToken`; a closed pull request
returns `200`, so a `404` is `read_error`. Reads do not retry.

## Alternatives considered

- **Blind re-post.** A write per context per pipeline per pass on the
  secondary limit, over final states it cannot see.
- **Webhook-driven repair.** A lost write sends no `status` event.
- **A failure hook and a restart sweep.** It misses strands where no write
  was tried: RIG-1129, RIG-1170, and the meta tree self-load in
  `ReportMetaStatus`.
- **An out-of-server cron job.** It needs a second credential and a copy of
  the rollup, and cannot use the key lock.
- **An outbox table.** A store write per transition, and a write lost
  before its row commits still needs a reader.
- **Liveness.** True of every finished pipeline; the RIG-3462 triage rule
  rejects it.

## Global Constraints

- One PR on `rigel-release`, read at `207f9887`. No API or web change, no
  new Go module. The only schema change is the index (Q1).
- Live write paths keep their retries, and a skip there still returns nil.
  `CHANGELOG.md` is not edited.
- With the interval above `0`, setup.go returns an error if the lookback is
  not above `2m` or max-calls is below `10`. server.go starts the
  reconciler only when `StatusAggregate` or `StatusMeta` is on.
- New files have the Apache header, `Copyright 2026 Woodpecker Authors`.
  Commit the mocks from `make generate`.
- `testify` table tests. A test that swaps `server.Config` does not call
  `t.Parallel`.

The flags go after `pending-timeout` in cmd/server/flags.go:

```go
&cli.DurationFlag{
	Sources: cli.EnvVars("WOODPECKER_STATUS_RECONCILE_INTERVAL"),
	Name:    "status-reconcile-interval",
	Usage:   "interval for re-posting required commit statuses that a finished pipeline left pending or absent; 0 disables",
	Value:   2 * time.Minute,
},
&cli.DurationFlag{
	Sources: cli.EnvVars("WOODPECKER_STATUS_RECONCILE_LOOKBACK"),
	Name:    "status-reconcile-lookback",
	Usage:   "how far back the status reconciler checks finished pipelines",
	Value:   3 * time.Hour,
},
&cli.IntFlag{
	Sources: cli.EnvVars("WOODPECKER_STATUS_RECONCILE_MAX_CALLS"),
	Name:    "status-reconcile-max-calls",
	Usage:   "maximum forge API requests in one status reconciler pass; at least 10",
	Value:   30,
},
```

## Plan

### T1. Store queries

Files: server/model/pipeline.go, server/store/store.go,
server/store/datastore/pipeline.go, server/store/datastore/pipeline_test.go,
server/store/mocks/mock_Store.go (generated).

Interfaces:

```go
// server/model/pipeline.go: the Updated tag gains INDEX (Q1).
Updated int64 `json:"updated" xorm:"INDEX 'updated' NOT NULL DEFAULT 0 updated"`

// server/store/store.go, after GetPipelineQueue

// GetTerminalPipelinesUpdated returns the terminal pipelines, except
// deployment and pull_request_closed, whose updated time is above after and
// not above before, newest first. Only ID, RepoID and Updated are set.
GetTerminalPipelinesUpdated(after, before int64) ([]*model.Pipeline, error)

// HasLaterPipeline reports whether p's repo holds a pipeline with p's commit,
// an event in events, and a higher number. It counts every status, except a
// created row whose created time is not above createdAfter: its creation
// stopped, so it never posts.
HasLaterPipeline(p *model.Pipeline, events []model.WebhookEvent, createdAfter int64) (bool, error)
```

- `GetTerminalPipelinesUpdated` uses `Cols("id", "repo_id", "updated")`,
  `builder.In` on the six statuses of `model.IsTerminalStatus`,
  `builder.NotIn` on `model.EventDeploy` and `model.EventPullClosed`, and
  `Desc("updated")`.
- `HasLaterPipeline` uses `Exist` and quotes `commit` as `getFeedSelect`
  does. An `error` row counts: `publishPipeline` still posts its aggregate.
- Tests with `newTestStore`. Rows are inserted with `NoAutoTime()`:
  1. `success` inside the window is returned. `running` is not.
  2. A row at exactly `before` is returned. A row at exactly `after` is not.
  3. `declined` with `Finished` `0` is returned. `deployment` and
     `pull_request_closed` are not.
  4. Rows come newest first, and `Commit` is empty.
  5. `HasLaterPipeline` is true for a higher number on the same commit and
     event, including an `error` row. It is false for another commit,
     event or repo, or a lower number.
  6. A `created` row counts when `created` is above `createdAfter`, and not
     at or below it.

### T2. Forge capability and repair posters

Files: server/forge/types/errors.go, server/forge/reconcile.go (new),
server/forge/status_reader.go (new), server/forge/forge.go,
server/forge/common/status.go, server/forge/common/status_test.go,
server/forge/github/status_aggregate.go, server/forge/github/retry.go,
server/forge/github/ratelimit.go, server/forge/github/status_read.go (new),
server/forge/github/status_read_test.go (new),
server/pipeline/helper_test.go, server/forge/mocks (generated).

Interfaces:

```go
// server/forge/types/errors.go
ErrQuotaLow    = errors.New("forge rate-limit quota is low")
ErrBudgetSpent = errors.New("forge call budget is spent")
ErrSuperseded  = errors.New("a later pipeline owns this status context") // replaces github.errSupersededReport

// server/forge/reconcile.go

// WithReconcile marks ctx as a reconciler call with a budget of maxCalls
// forge HTTP requests. The counter holds the requests sent under ctx.
func WithReconcile(ctx context.Context, maxCalls int64) (context.Context, *atomic.Int64)

// Reconciling reports whether ctx is a reconciler call.
func Reconciling(ctx context.Context) bool

// SpendCall charges one request to a reconciler ctx. At maxCalls it returns
// types.ErrBudgetSpent and charges nothing. It does nothing for other
// contexts.
func SpendCall(ctx context.Context) error

// server/forge/status_reader.go

// DeliveredUnknown is the state of a context that a capped read did not reach.
const DeliveredUnknown = "unknown"

// StatusReader is an optional Forge capability for the status reconciler.
type StatusReader interface {
	// DeliveredStatuses returns the newest state of each context on commit:
	// "pending", "success", "failure" or "error". A context not found is ""
	// when the last page was read, and DeliveredUnknown when the page cap
	// ended the read first.
	DeliveredStatuses(ctx context.Context, u *model.User, r *model.Repo, commit string, contexts []string) (map[string]string, error)
	// ExpectedState returns the state the posters write for the terminal
	// pipeline p, with p.Workflows loaded for pull request events.
	ExpectedState(p *model.Pipeline, meta bool) string
	// PullRequestHead returns the head SHA of p's pull request and whether
	// it is open.
	PullRequestHead(ctx context.Context, u *model.User, r *model.Repo, p *model.Pipeline) (head string, open bool, err error)
}

// server/forge/common/status.go, after GetPipelineAggregateStatusContext

// GetAggregateContextEvents returns each event whose aggregate context for
// repo renders the same non-empty string as p's. It tries every event except
// deployment, which posts no aggregate. A template error gives nil.
func GetAggregateContextEvents(repo *model.Repo, p *model.Pipeline) []model.WebhookEvent

// server/forge/forge.go

// HasLaterMetaPipeline is hasLaterMetaPipeline, exported. It also skips a
// created row whose Created is not above createdAfter, as
// store.HasLaterPipeline does. ReportMetaStatus passes 0: today's behaviour.
func HasLaterMetaPipeline(s store.Store, r *model.Repo, b *model.Pipeline, createdAfter int64) (bool, error)

// RepairAggregateStatus posts b's aggregate verdict again. Its refresher
// calls later under the key lock, before the POST. It returns
// types.ErrSuperseded when later is true, and types.ErrNotImplemented when f
// has no AggregateStatusReporter.
func RepairAggregateStatus(ctx context.Context, f Forge, s store.Store, u *model.User, r *model.Repo, b *model.Pipeline, later func() (bool, error)) error

// RepairMetaStatus posts b's meta verdict again. Its refresher calls later
// under the key lock, before the POST. It skips the early check of
// ReportMetaStatus: the reconciler has just made it. It returns
// types.ErrSuperseded when later is true, and types.ErrNotImplemented when f
// has no MetaStatusReporter.
func RepairMetaStatus(ctx context.Context, f Forge, s store.Store, u *model.User, r *model.Repo, b *model.Pipeline, later func() (bool, error)) error

// server/forge/github/ratelimit.go: RoundTrip calls
// forge.SpendCall(req.Context()) first, and returns its error without
// sending.
func (o *rateLimitObserver) RoundTrip(req *http.Request) (*http.Response, error)

// server/forge/github/retry.go: signature unchanged. When
// forge.Reconciling(ctx), it makes one attempt and returns quotaErr(err).
// That covers the token mint in requiredStatusClient and the POST in
// postAggregate.
func doForgeWrite(ctx context.Context, fn func() (*github.Response, error)) (*github.Response, error)

// server/forge/github/status_aggregate.go

// ignoreSkip drops types.ErrSuperseded and errUnchangedStatus. It keeps
// types.ErrSuperseded when forge.Reconciling(ctx).
func ignoreSkip(ctx context.Context, err error) error

// server/forge/github/status_read.go
const (
	reconcileQuotaFloor   = 0.2
	combinedStatusPages   = 3   // page cap of one DeliveredStatuses call
	combinedStatusPerPage = 100 // statuses per page
)

// DeliveredStatuses reads GetCombinedStatus pages within statusReportTimeout
// until it finds every context, reads the last page (resp.NextPage == 0), or
// reaches combinedStatusPages.
func (c *client) DeliveredStatuses(ctx context.Context, u *model.User, r *model.Repo, commit string, contexts []string) (map[string]string, error)
func (c *client) ExpectedState(p *model.Pipeline, meta bool) string

// PullRequestHead parses the number from p.Ref (headRefs, mergeRefs) and
// calls PullRequests.Get. Another ref is an error.
func (c *client) PullRequestHead(ctx context.Context, u *model.User, r *model.Repo, p *model.Pipeline) (string, bool, error)

// quotaLow reports whether resp shows Remaining below reconcileQuotaFloor of Limit.
func quotaLow(resp *github.Response) bool

// quotaErr wraps a *github.RateLimitError or *github.AbuseRateLimitError
// as types.ErrQuotaLow. It returns other errors unchanged.
func quotaErr(err error) error
```

- Each `Report*` and `Repair*` pair shares one unexported helper.
- GitHub tests use an `httptest` server and a real client, as
  `TestRequiredStatusesUseAppToken` does; a `githubClientKey` client skips
  `rateLimitObserver`:
  1. Raw states come back; a missing context gives `""`.
  2. A context on page 4 gives `DeliveredUnknown` after 3 requests. When
     page 3 is the last, it gives `""`.
  3. `Remaining` 900 of 5000 gives `ErrQuotaLow`; 1100 does not.
  4. A `403` with `X-RateLimit-Remaining: 0` gives `ErrQuotaLow` on a read
     and on a repair write, which posts once.
  5. An open pull request gives its head and `true`, a closed one `false`,
     a `404` an error.
  6. `ExpectedState`: `canceled` gives `success`; meta with a failed gate
     gives `failure`.
  7. A `500` on a repair write: one POST and an error. Live: four POSTs.
  8. A refresher skip on a meta repair: `ErrSuperseded`, no POST. Live: nil.
  9. An App with an empty token cache: the mint sends 2 requests before
     page 1. A budget of 4 sends 2 pages and gives `ErrBudgetSpent`; 5
     reads all 3. A second read costs 3.
- status_test.go: `GetAggregateContextEvents` gives only `push` for a push
  pipeline with the default format, every event but `deployment` with
  `{{ .context }}`, and nil for a template error.
- helper_test.go: `HasLaterMetaPipeline` ignores a later `created` row at
  or before `createdAfter`; `ReportMetaStatus` passes 0 and still skips.
  With `aggregateResilienceForge`, each `Repair*` puts `later` in the
  refresher, with no early call.

### T3. The reconciler

Files: server/pipeline/status_reconcile.go (new),
server/pipeline/status_reconcile_test.go (new), server/config.go,
cmd/server/flags.go, cmd/server/setup.go, cmd/server/server.go,
docs/docs/30-administration/10-configuration/10-server.md,
docs/docs/30-administration/10-configuration/12-forges/20-github.md.

Interfaces:

```go
// server/pipeline/status_reconcile.go
const (
	statusReconcileSettle  = 2 * time.Minute
	statusReconcileRecheck = 15 * time.Minute // superseded and closed are read again after this
	statusReadReserve      = 3                // combined-status pages
	mintReserve            = 2                // App token mint, added to a repo's first status read in a pass
	headReadReserve        = 1                // PullRequestHead; a pull request write adds one for its fence
	repairWriteReserve     = 1
	repairMaxWrites        = 3 // the third write_error gives gave_up
)

var (
	statusReconcileResults = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "woodpecker",
		Name:      "status_reconcile_results_total",
		Help:      "Owned status contexts the reconciler checked, by result. expired counts pipelines.",
	}, []string{"result"})
	statusReconcileCalls = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: "woodpecker",
		Name:      "status_reconcile_calls_total",
		Help:      "Forge HTTP requests the reconciler sent.",
	})
	statusReconcileBacklog = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: "woodpecker",
		Name:      "status_reconcile_backlog",
		Help:      "Pipelines with repair work left after the last pass.",
	})
)

type ownedContext struct {
	name   string
	meta   bool
	owners []model.WebhookEvent // aggregate only: common.GetAggregateContextEvents
}

// repoPass is one repo's state in one pass (step 2).
type repoPass struct {
	forge  forge.Forge
	reader forge.StatusReader
	user   *model.User
	repo   *model.Repo
	minted bool // a status read ran in this pass, so the App token mint is paid
}

// reconcileEntry is the memory for one pipeline. A pipeline is skipped while
// updated is unchanged, open is false, and until is zero or in the future.
type reconcileEntry struct {
	updated int64     // the pipeline's updated time when the entry was written
	until   time.Time // zero: done; else read again after this time
	open    bool      // repair work is left
	writes  int       // failed repair writes
}

type StatusReconciler struct {
	store           store.Store
	lookback        time.Duration
	creationTimeout time.Duration
	maxCalls        int64
	entries         map[int64]*reconcileEntry // by pipeline ID
}

func NewStatusReconciler(s store.Store, lookback, creationTimeout time.Duration, maxCalls int) *StatusReconciler

// Run does one pass. It returns an error only when the candidate query fails.
func (r *StatusReconciler) Run(ctx context.Context, now time.Time) error

// ownedContexts applies D1: deployment and pull_request_closed pipelines own
// no context. For pull request events it loads the tree into p.Workflows, as
// ReportAggregateStatus does. An empty context name (a template error) is
// skipped.
func ownedContexts(s store.Store, repo *model.Repo, p *model.Pipeline) ([]ownedContext, error)

// fence returns the later check passed to the repair: step 4 again
// (s.HasLaterPipeline with oc.owners, or forge.HasLaterMetaPipeline) and, for
// a pull request pipeline, PullRequestHead again. It is true when a later
// pipeline owns oc, the head is not p.Commit, or the pull request is not open.
func fence(ctx context.Context, s store.Store, rp *repoPass, p *model.Pipeline, oc ownedContext, createdAfter int64) func() (bool, error)

// reconcilePipeline does steps 3 to 7 for p and updates e. It returns
// types.ErrQuotaLow and types.ErrBudgetSpent unchanged, and Run ends the pass
// on them.
func (r *StatusReconciler) reconcilePipeline(ctx context.Context, rp *repoPass, p *model.Pipeline, e *reconcileEntry, used *atomic.Int64, now time.Time) error
```

```go
StatusReconcileInterval time.Duration // server/config.go, after PendingTimeout
StatusReconcileLookback time.Duration
StatusReconcileMaxCalls int

server.Config.Server.StatusReconcileInterval = c.Duration("status-reconcile-interval") // cmd/server/setup.go
server.Config.Server.StatusReconcileLookback = c.Duration("status-reconcile-lookback")
server.Config.Server.StatusReconcileMaxCalls = c.Int("status-reconcile-max-calls")

reconciler := pipeline.NewStatusReconciler(_store, server.Config.Server.StatusReconcileLookback, // cmd/server/server.go
	server.Config.Server.CreationTimeout, server.Config.Server.StatusReconcileMaxCalls)
```

- `Run` calls `forge.WithReconcile` once per pass and adds the counter to
  `statusReconcileCalls`. `createdAfter` is `now - creationTimeout`;
  setup.go always sets `CreationTimeout`.
- Result labels: `clean`, `reposted`, `mismatch`, `superseded`, `closed`,
  `unsupported`, `read_error`, `incomplete`, `write_error`, `gave_up`,
  `expired`.
- Logs: `info` per `reposted` (repo, pipeline, SHA, context, status);
  `warn` per `mismatch`, `incomplete`, `gave_up`, `expired`, and a pass
  that budget or quota ends.
- Q2 option A or C changes only the step-6 branch and test row 2.
- server.go copies the orphan reaper loop and log lines.
- Docs: the three `STATUS_RECONCILE_*` sections go after
  `### STATUS_AGGREGATE_FORMAT`, with the defaults, `0` disables, the two
  repaired contexts, and one replica. The GitHub page: the App needs
  **Commit statuses** read and write, and servers on one App share its
  rate limit.

### T3 tests

`TestStatusReconciler` rows use a strict `store_mocks.MockStore`,
`manager_mocks.MockManager`, and a fake `reconcileForge` that embeds
`forge.Forge` and implements both reporters and `StatusReader`. It calls
`forge.SpendCall` once per call unless a row says otherwise, and its
posters call the refresher. Counters use `testutil.ToFloat64`.

1. A push pipeline with `CI (push)` pending: one repair, `reposted` 1, an
   `info` line. A second `Run` makes no call.
2. Absent: repaired. Final and equal: `clean`. Final and different:
   `mismatch`, no write, a `warn` line. `DeliveredUnknown`: `incomplete`,
   no write, a `warn` line, no read next `Run`.
3. `HasLaterPipeline` true: `superseded`, no forge call. Its events: every
   event but `deployment` with `{{ .context }}`, only `push` with the
   default format.
4. A pull request pipeline whose head moved: `superseded`, no
   `DeliveredStatuses` call. Closed: `closed`. A `PullRequestHead` error:
   `read_error`, read again next `Run`.
5. A meta-gated pull request pipeline with both contexts pending: both
   repaired. With `StatusMeta` off, only the aggregate is read.
6. The repair returns `types.ErrSuperseded`: `superseded`, no `reposted`,
   no `info` line.
7. The write fails in three passes: `write_error` twice, then `gave_up`. A
   fourth `Run` makes no call.
8. `maxCalls` 10, one repo: the first read counts 5 (a mint), later reads
   3, writes 1. Of three pending push pipelines, the third is not read;
   calls 10, backlog 1.
9. The first read returns `ErrQuotaLow`: no other forge call, a `warn` line.
   A read that spends past `maxCalls` gets `ErrBudgetSpent` and ends the
   pass.
10. No `StatusReader`: `unsupported`. An inactive repo, or a
    `pull_request_closed` or `deployment` pipeline: no forge call.
11. A new `StatusReconciler` reads a pipeline the old one repaired. A
    changed `updated` also makes it read again.
12. Store `superseded`: skipped for 15 minutes, then read. With
    `HasLaterPipeline` now false, it is repaired.
13. An open pipeline whose `updated` leaves the lookback: `expired` 1, a
    `warn` line, the entry removed.
14. The head matches at step 5 and moves before the write: the fence sees
    it. `superseded`, no POST.

## Tasks

- [ ] Matt answers Q1 and Q2.
- [ ] T1, T2, T3 in order: tests fail first, then the code.
- [ ] `make generate`, `make lint` and `make test-server` pass.
- [ ] On the CI deployment (one replica), set the interval.
- [ ] After deploy: `reposted` lines name pipelines whose checks then go
      final; `status_reconcile_calls_total` grows at most `max-calls` per
      interval; the App's `woodpecker_github_ratelimit_remaining` shows no
      new dip. Record the `mismatch` count for Q2.

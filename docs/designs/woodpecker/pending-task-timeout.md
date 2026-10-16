# Time out pending workflows no agent takes (RIG-5475)

## Decisions

Matt ruled on RIG-5485 (2026-10-16): Q1 is C; the other recommendations stand.

- **D1** (DL-530) — A queued workflow times out when its task has been
  runnable in `Info.Pending` longer than `pending-timeout` and no live agent
  matches its labels. A pool at zero has no agent rows, so for scale-from-zero
  pools this is age-only: a pool outage longer than the timeout errors real
  work. A `hostname`-pinned task never times out.
- **D2** (DL-531) — `pending-timeout` defaults to `6h`, on by default; `0`
  disables. That is about twice the worst observed backlog wait, and a backlog
  on a pool with live agents never trips it.
- **D3** (DL-532) — A timed-out workflow and its pending steps end `error`,
  with the reason in their `Error` fields. Never `canceled`: it posts success.
- **D4** (DL-533) — The sweep finalizes only the timed-out workflow and the
  dependents that can never run. Running siblings and `runs_on: failure`
  dependents continue.
- **D5** (DL-534) — An agent counts as live when `NoSchedule` is false and its
  `LastContact` is within `pending-timeout`. `ReportHealth` stores
  `LastContact` every 10 s, and it survives a restart. Agents that ever
  reported do not count: a persisted-config or individual-token agent never
  removes its row (`UnregisterAgent` in server/rpc/rpc.go).

## Problem / Intent

Five pipelines in a consumer repo sat `pending` for 7 to 33 days. Their 12 tasks
carried `type=linux`, a label no agent advertises. Nothing removes such a task:
the queue only expires running leases (`fifo.resubmitExpiredPipelines` in
server/queue/fifo.go), and the orphan reaper skips queued workflows. The tasks
inflate `pending_count` and hold forge checks pending. Matt ruled on RIG-5470
that they must be cancelled automatically after a timeout. The cancel ends the
workflow `error`, because a never-started `canceled` pipeline posts success.

## Approach

### Where it runs

`ReapOrphanedWorkflows` (server/pipeline/reap.go) walks every pending and
running pipeline, loads its tree, and skips each workflow in the queued set
built from `storage.TaskList()` and `Scheduler.Info`:

```go
if _, exists := queued[fmt.Sprint(workflow.ID)]; exists {
	continue
}
```

The new checks run in this pass. The reaper tail finishes the pipeline, posts
forge status and publishes the event. `pending-timeout` or
`orphan-reap-interval` set to `0` turns them off.

### When a queued workflow times out

All must hold:

1. `pending-timeout` is above `0`, and the queue is not paused (`Info.Paused`).
2. Its task is in `Info.Pending`. `Info.WaitingOnDeps` is excluded: the
   autoscaler counts demand only from `queueInfo.Pending` (`calcAgents` in
   engine/autoscaler.go), so a dependent's pool can sit at zero while its
   dependency runs. `Info.Running` is leased.
3. The task has been runnable for longer than `pending-timeout`. The clock is
   the latest of `pipeline.Created`, `pipeline.Reviewed` (set on approval) and
   `Finished` of each workflow in `task.Dependencies`, from the loaded tree.
   All are stored, so a restart neither resets nor extends it. `task.Created`
   is not used: older rows hold `0`. A clock of `0` never times out.
4. Every dependency is terminal and lets it run (*Dependents that can never
   run*).
5. No live agent matches the task labels (*Matching against live agents*).

A blocked pipeline has no task: `Create` returns before `start` while it is
`StatusBlocked`. Backlog and scale-from-zero tasks wait up to the timeout.

### Finalizing a timed-out workflow

1. `reapWorkflow` gets the reason. The workflow and each pending step end
   `error`, with the reason in `Error` and `Finished` set, so the step log bar
   shows it. A started step (a resubmitted lease) ends `killed`, as today.
   Example reason:
   `no agent took this workflow within 6h0m0s (pending-timeout); labels: [type=linux]`.
   Labels are sorted `key=value` pairs, without `woodpecker-ci.org/` labels,
   empty values, `repo` and `org-id`.
2. Then `Scheduler.CancelWorkflows(ctx, []string{id})`, one ID per call:
   `persistentQueue.ErrorAtOnce` deletes no row when one ID is missing. A
   failed store write leaves the workflow pending for the next pass. A failed
   cancel is logged (*Stale task rows*).
3. The tail finishes the pipeline when nothing is pending or running.
   `statusPriorityOrder` (server/pipeline/status.go) ranks `error` above
   running and pending, so a pull request aggregate turns red at once. The
   tail's `if changed && !pipelineEverStarted { status = model.StatusCanceled }`
   is not applied when a workflow in the tree is `error`: `convertStatus`
   (server/forge/github/convert.go) posts `canceled` as success
   (`case model.StatusCanceled: ... return statusSuccess`).
4. One `log.Info` line per finalized workflow, with `reason=pending-timeout`
   or `reason=dependency-failed` and the labels. The counter
   `woodpecker_pending_workflows_timed_out_total` counts timeouts.

An agent that takes the task after the `Info` snapshot gets `ErrCancel`, and
`checkWorkflowState` makes `RPC.Done` reject its report.

### Dependents that can never run

Each pass checks every `pending` workflow whose task is in `Info.Pending` or
`Info.WaitingOnDeps`, so a failed write is retried next pass. `DepStatus` is
the `State` of each workflow in `task.Dependencies`, from the tree. If one is
missing or `Running()`, the check waits. Otherwise the workflow is dead when
`(&model.Task{RunOn: task.RunOn, DepStatus: deps}).ShouldRun()` is false. All
dependencies count: a `runs_on: failure` dependent of one timed-out and one
successful workflow is dead.

A dead workflow ends `skipped` through `Cancel`'s helpers:
`UpdateWorkflowToStatusSkipped`, and `UpdateStepToStatusSkipped(store, step, 0,
model.StatusCanceled)` for pending steps, then `CancelWorkflows`. The scan
repeats until it finalizes nothing. The fifo cannot do it: its skip waits
until a matching agent polls (`markSkipped` in `impl.Poll`), and the stored
`DepStatus` stays empty, so after a restart the dependent runs.

### Stale task rows

`persistentQueue.ErrorAtOnce` drops the task from memory before it deletes the
row. If the delete fails, nothing revisits the row, and a restart reloads it.
So each pass checks every `TaskList()` row against the workflow state loaded at
the start of the pass, or `storage.WorkflowLoad` for a pipeline not walked. A
row whose workflow is terminal or missing goes. If its task is in
`Info.Pending` or `Info.WaitingOnDeps`, the pass calls what
`persistentQueue.Poll` calls: `Scheduler.Done` with the workflow state, or
`Scheduler.Error` when it is missing. Both delete the row. Otherwise it calls
`storage.TaskDelete`. `Info.Running` rows are left to their lease. `Done`
passes the real state, so dependents of a stale `success` row are not killed.

### Matching against live agents

The server stores every label an agent polls with except `hostname`. The agent
builds its poll labels in `run` (cmd/agent/core/agent.go):

```go
labels[pipeline.LabelFilterHostname] = hostname
labels[pipeline.LabelFilterPlatform] = engInfo.Platform
labels[pipeline.LabelFilterBackend] = backendEngine.Name()
labels[pipeline.LabelFilterRepo] = "*" // allow all repos by default
// ... and let it overwrite by custom ones
maps.Copy(labels, customLabels)
```

`RPC.RegisterAgent` stores `Platform`, `Backend` and `CustomLabels`, and
`RPC.Next` copies `Agent.GetServerLabels()` over the poll labels.
`Agent.PollLabels` rebuilds that map with `hostname="*"` unless a custom label
sets it, so a hostname-pinned task never times out. `scheduler.NewLabelFilter`
wraps `createFilterFunc`, so the rules exist once. An agent counts when
`NoSchedule` is false, because `RPC.Next` returns before `Poll` for it, and its
`LastContact` is within `pending-timeout` (D5). The autoscaler deletes a
drained agent (`removeDrainedAgents`) or clears the flag (`createAgents`).

## Alternatives considered

- **Sweep inside `fifo.process`.** No store, agent rows or pipeline times
  there, and the loop holds the fork's ordering rules.
- **A separate ticker.** A second scan and a second reaper tail.
- **Reject at enqueue when no agent matches.** Breaks scale from zero.
- **Final state `canceled`.** Posts success.
- **Final state `killed`.** Reads as a user stop, and ranks below running.
- **WaitingOnDeps candidates with a creation clock.** Errors dependents whose
  pool is at zero by design.
- **Queue cancel before the store write.** A failed write is then reaped as
  `agent-gone` and `canceled`: success.
- **Probe with only the timed-out dependency.** Misses a dead `runs_on:
  failure` dependent whose other dependency succeeded.
- **Check dependents only after a timeout in that pass.** A failed write is
  never retried.
- **Drop stale queued tasks with `CancelWorkflows`.** Kills dependents of a
  stale `success` workflow.
- **Age only, `72h` (option A).** Less code, but a task that can never run
  holds its check pending for 3 days.
- **Agent match with a short grace (option B).** Every scale-from-zero task
  looks unschedulable until its agent boots.

## Global Constraints

- One PR on the fork base branch `rigel-release`. New code sits next to the
  reaper in server/pipeline.
- `server/queue` does not change: `taskOrderLess`, `canRunConcurrent` and the
  `fifo.process` loop stay as they are.
- No database migration, no API or web change, no new Go module.
- `CHANGELOG.md` is not edited. Upstream generates it.
- Flag `pending-timeout`, env `WOODPECKER_PENDING_TIMEOUT`, a
  `cli.DurationFlag`, default `6h` (D2), `0` disables. It goes after
  `orphan-reap-grace` in cmd/server/flags.go.
- The sweep runs only where the orphan reaper runs: one replica.
- A new file starts with the Apache header and `Copyright 2026 Woodpecker
  Authors`, as in server/pipeline/reap.go.
- Table tests with `testify`. `TestReapOrphanedWorkflows` swaps
  `server.Config` globals, so its cases do not call `t.Parallel`.
- Existing `TestReapOrphanedWorkflows` rows keep their expectations.

## Plan

T1 adds the age sweep. T2 adds the live agent match, after T1. One PR holds
both.

### T1. Time out pending workflows in the reaper

Files: server/pipeline/reap.go, server/pipeline/pending_timeout.go (new),
server/pipeline/reap_test.go, server/pipeline/helper_test.go,
server/config.go, cmd/server/flags.go, cmd/server/setup.go,
cmd/server/server.go, docs/docs/30-administration/10-configuration/10-server.md.

Interfaces:

```go
// server/pipeline/reap.go
func ReapOrphanedWorkflows(ctx context.Context, storage store.Store, now time.Time, grace, pendingTimeout time.Duration) error
func reapWorkflow(storage store.Store, workflow *model.Workflow, finished int64, pendingState model.StatusValue, errMsg string) bool

// server/pipeline/pending_timeout.go
var pendingWorkflowsTimedOut = promauto.NewCounter(prometheus.CounterOpts{
	Namespace: "woodpecker",
	Name:      "pending_workflows_timed_out_total",
	Help:      "Queued workflows ended error because no agent took them within pending-timeout.",
})

func runnableSince(p *model.Pipeline, workflows []*model.Workflow, task *model.Task) int64
func pendingTimeoutReason(task *model.Task, timeout time.Duration) string
func treeDepStatus(task *model.Task, workflows []*model.Workflow) (map[string]model.StatusValue, bool)
func finalizeDeadWorkflows(ctx context.Context, storage store.Store, workflows []*model.Workflow, waiting map[string]*model.Task) []*model.Workflow
func removeStaleTaskRows(ctx context.Context, storage store.Store, rows []*model.Task, loaded map[string]model.StatusValue, waiting map[string]*model.Task, running map[string]struct{})
```

- `reapWorkflow`: a started workflow or step ends `killed`, as today; one not
  started ends `pendingState`. A non-empty `errMsg` goes into `Error` and sets
  `Finished`. The existing call passes `model.StatusCanceled` and `""`.
- `treeDepStatus` maps each ID in `task.Dependencies` to its workflow's
  `State`, and returns `false` when one is missing or `Running()`.
- `runnableSince` returns `0` when `treeDepStatus` returns `false`, else the
  largest of `p.Created`, `p.Reviewed` and each dependency's `Finished`.
- `finalizeDeadWorkflows` applies *Dependents that can never run* to each
  `pending` workflow in `waiting` until a scan finalizes none. A failed write
  is logged and skipped. It returns the finalized workflows.
- `removeStaleTaskRows` applies *Stale task rows*. Terminal is
  `model.IsTerminalStatus(state)` or `model.StatusSkipped`, as in
  `isTerminalWorkflowState`. `ErrRecordNotExist` is ignored.

In `ReapOrphanedWorkflows`:

1. Next to `queued`, build `pending` (ID to task) from `queueInfo.Pending`,
   `waiting` from `queueInfo.Pending` and `queueInfo.WaitingOnDeps`, and
   `running` from `queueInfo.Running`. With `pendingTimeout` at `0`, steps 2,
   3 and 5 are skipped.
2. In the `queued` branch, unless `queueInfo.Paused`: a workflow whose task is
   in `pending`, whose `treeDepStatus` lets it run, and whose `runnableSince`
   is above `0` and before `now - pendingTimeout` goes through
   `reapWorkflow(..., model.StatusError, reason)`, then `CancelWorkflows`. Set
   `changed`, add 1 to the counter, and log.
3. After the workflow loop, call `finalizeDeadWorkflows`. A non-empty result
   sets `changed`. Before the loop, record each workflow's state in `loaded`.
4. In the tail, apply the `canceled` override only when no workflow in the
   tree is `error`.
5. After the pipeline loop, call `removeStaleTaskRows` with `persistedTasks`.

```go
PendingTimeout time.Duration // server/config.go, after OrphanReapGrace

server.Config.Server.PendingTimeout = c.Duration("pending-timeout") // cmd/server/setup.go

pipeline.ReapOrphanedWorkflows(ctx, _store, time.Now(), server.Config.Server.OrphanReapGrace, server.Config.Server.PendingTimeout) // cmd/server/server.go
```

The docs get `### PENDING_TIMEOUT` after `### ORPHAN_REAP_GRACE`: the default,
`0` disables, and it needs `ORPHAN_REAP_INTERVAL` above `0`.

### T1 tests

Written first, as `TestReapOrphanedWorkflows` rows (strict
`store_mocks.MockStore`, `now` as clock, `6h` timeout, counter read by
`testutil.ToFloat64`). Rows that time out or finalize:

1. A pending `type=linux` task, pipeline 7 hours old. Workflow and step end
   `error` with the reason in `Error` and `Finished` set. `CancelWorkflows`
   gets `["41"]` once. The pipeline ends `error`. The counter rises by 1.
2. Row 1 on a push event with `StatusAggregate` on and the
   `aggregateResilienceForge` fake, extended to keep the pipeline it gets.
   The aggregate is called once with pipeline status `error`. Today's tail
   gives `canceled`, which `convertStatus` posts as success.
3. Row 1 on a pull event plus a leased sibling in `Info.Running`. The pipeline
   stays open, and the aggregate rolls up `error`.
4. Row 1 plus a default dependent in `WaitingOnDeps` and a `runs_on: failure`
   dependent. The first ends `skipped` with a `canceled` step and its own
   `CancelWorkflows` call. The second is untouched.
5. Row 1 plus a `runs_on: failure` dependent of row 1's workflow and of a
   workflow that ended `success`. It ends `skipped`. While that second
   workflow is `running`, it stays queued.
6. A dead dependent in `Info.Pending` whose dependency failed 8 hours ago
   ends `skipped`, not `error`.
7. `WorkflowUpdate` fails. No `CancelWorkflows`, no counter change.
8. `CancelWorkflows` fails. The workflow still ends `error`.
9. A row in `Info.Pending` whose workflow is `success` gets
   `Done(ctx, "41", model.StatusSuccess)` and no cancel.
10. A queued row whose `WorkflowLoad` returns `ErrRecordNotExist` gets
    `Error`; its default dependent ends `skipped`, not run.
11. Row 1 plus dependent A of row 1 and dependent B of A. Both end `skipped`
    in the same pass.

Rows that stay queued, each one change from row 1: the task is in
`WaitingOnDeps`; the task is in `Running`; a dependency finished 1 hour ago;
the pipeline was reviewed 1 hour ago; the pipeline is 5 hours old;
`pendingTimeout` is `0`; the queue is paused.

`TestReapPendingTimeoutNextPass` calls `ReapOrphanedWorkflows` twice on one
set of mocks:

- Pass 1: the dependent's `WorkflowUpdate` fails. Pass 2: its dependency is
  already `error`; it ends `skipped`, with its `CancelWorkflows` call.
- Pass 1: `CancelWorkflows` returns the persistent delete error. Pass 2:
  `TaskList` still has row `41`, `Info` does not, and `WorkflowLoad(41)`
  returns it `error`. `TaskDelete("41")` is called once.

### T2. Live agent match

Files: server/model/agent.go, server/scheduler/filter.go,
server/pipeline/pending_timeout.go, their tests, and server/rpc/rpc_test.go.

Interfaces:

```go
func (a *Agent) PollLabels() (map[string]string, error)
func NewLabelFilter(labels map[string]string) FilterFn
func loadLiveAgentFilters(storage store.Store, now time.Time, window time.Duration) ([]scheduler.FilterFn, error)
func anyAgentTakes(filters []scheduler.FilterFn, task *model.Task) bool
```

- `PollLabels` builds the map of *Matching against live agents* and returns a
  new map.
- `loadLiveAgentFilters` calls `AgentList(&model.ListOptionsWithAll{All:
  true})` once per pass and keeps agents with `NoSchedule` false and
  `LastContact` within `window` (D5). On an error, no task times out.
- Tests: T1 rows gain an `AgentList` mock with no live match;
  `TestAgentPollLabels`; `TestNewLabelFilter`; reap rows where a busy
  live match stays, a `NoSchedule` match and a match last seen beyond the
  window time out, and a `hostname` task and an `AgentList` error stay.
- Parity test: drive `RPC.Next` with the labels the agent sends, as
  `TestRPCNextInjectsReadOnlyNetrc` does, and assert its filter and
  `NewLabelFilter(agent.PollLabels())` agree on a task set without `hostname`.

## Tasks

- [ ] Before deploy: list stored agents (admin `GET /api/agents`, 50 per
      page). Note any with `type=linux` in `custom_labels` or `filters`, and
      its `last_contact`. No live match confirms the 5 pipelines cannot run.
- [ ] T1: write the test rows and `TestReapPendingTimeoutNextPass`; see them
      fail.
- [ ] T1: add pending_timeout.go, change reap.go, add the flag, the wiring
      and `PENDING_TIMEOUT` in the server configuration docs.
- [ ] T2: tests first, then the four functions.
- [ ] `make lint` and `make test-server` pass.
- [ ] After deploy, within one reaper interval: the `type=linux` pipelines end
      `error`, their required check posts failure, and the counter rises.

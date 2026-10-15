# Time out pending workflows no agent takes (RIG-5475)

## Open Questions

Round 1 asks Q1, Q3 and Q4. Q2 depends on Q1. Q5 applies only if Q1 is C.

### Q1. What makes a queued workflow time out?

Both options carry the review fixes: the workflow ends `error`, only
`Info.Pending` tasks count, the clock starts when the dependencies finish, and
dependents that can never run are skipped in the same pass.

- **A. Age only, default `72h`.** The workflow times out once its task has been
  runnable for the timeout. Clears the 7 to 33 day incident. One plan task, no
  agent matching, no `hostname` gap, no stale agent rows. Cost: a task that can
  never run holds its check pending for 3 days.
- **C. Age and no live matching agent, default `6h`.** A backlog on a pool with
  live agents never trips it. But a pool at zero has no agent rows, so the
  check cannot tell "never" from "not yet", and for scale-from-zero pools C is
  age-only at `6h`. A pool outage over 6 hours (spot shortage, broken image,
  stalled autoscaler) then errors real work. Adds T2, Q5, and a `hostname` gap:
  pinned tasks never time out.

**Recommendation:** A at `72h`. It meets the ruling with less code, and no
outage shorter than 3 days errors real work. If 3 days proves too slow, T2 can
be added later behind the same flag.

### Q2. Default for `pending-timeout` (depends on Q1)

- **`0`, opt-in.** Upstream-compatible. The consumer deploy must set the
  variable, or nothing changes for us.
- **`72h`.** For A. About 24 times the worst observed backlog wait.
- **`6h`.** For C only. With A it errors backlog tasks.

**Recommendation:** `72h` if Q1 is A, `6h` if Q1 is C. On by default: the fork
exists to run our server. The plan assumes `72h`.

### Q3. Where does the reason show?

- **Workflow and step `Error`, state `error`.** Existing fields. The pipeline
  Errors tab lists `workflow.error` (`workflowsWithErrors` in
  web/src/lib/pipeline.ts). The bar under the step log shows `step.error` once
  `finished` is set (`PipelineLog.vue`). No web change.
- **A new `CancelInfo` field.** Model, API, web and i18n changes, and
  `CancelInfo` describes a killed or canceled pipeline.
- **An entry in `pipeline.Errors`.** That list holds config errors today.

**Recommendation:** workflow and step `Error`, state `error`.

### Q4. What does the sweep finalize?

- **The timed-out workflow and the dependents that can never run.** Running
  siblings and `runs_on: failure` dependents continue.
- **The whole pipeline through `Cancel`.** Also kills running siblings and the
  `runs_on: failure` workflows that report the failure. `Cancel` ends a
  never-started pipeline `canceled`, which posts success (Approach).

**Recommendation:** the timed-out workflow and its dead dependents.

### Q5. Which agents count as able to take a task? (C only)

- **Agents seen within `pending-timeout`.** `ReportHealth` stores
  `LastContact` every 10 s, and it survives a server restart. The autoscaler's
  `nonPoolFreeSlots` also skips "an agent whose last contact is stale".
- **Every agent that has ever reported.** An agent with a persisted config or
  an individual token never removes its row (`UnregisterAgent` in
  server/rpc/rpc.go). A dead matching row stops the timeout, and nothing shows
  why.

**Recommendation:** agents seen within `pending-timeout`.

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

The new check runs on those skipped workflows. There is no second scan, and the
reaper tail finishes the pipeline, posts forge status and publishes the event.
`orphan-reap-interval` set to `0` turns it off too.

### When a queued workflow times out

All must hold:

1. `pending-timeout` is above `0`, and the queue is not paused
   (`Info.Paused`). A pause is an operator choice, not a stuck task.
2. Its task is in `Info.Pending`. A task in `Info.WaitingOnDeps` is not a
   candidate: the autoscaler counts demand only from `queueInfo.Pending`
   (`calcAgents` in engine/autoscaler.go), so a dependent's pool can sit at
   zero while its dependency runs. A task in `Info.Running` is leased.
3. The task has been runnable for longer than `pending-timeout`. The clock is
   the latest of `pipeline.Created`, `pipeline.Reviewed` (set on approval), and
   `Finished` of each workflow in `task.Dependencies`, from the loaded tree. If
   a dependency is still pending or running, the task is skipped. These are
   stored columns and `WithTaskStore` reloads task rows on start, so a restart
   neither resets nor extends the clock. `task.Created` is not used: older rows
   hold `0`. A clock of `0` never times out.
4. Option C only: no live agent matches the task labels (T2).

The reaper reads only `ID`, `Labels`, `Dependencies` and `RunOn` from `Info`
tasks. The fifo changes only `DepStatus` and `AgentID`, under its own lock.

### Finalizing a timed-out workflow

1. `reapWorkflow` gets the reason. The workflow and each pending step end
   `error`, with the reason in `Error` and `Finished` set to now, so the step
   log bar shows it (`PipelineLog.vue` needs `finished`). A started step (a
   resubmitted lease) ends `killed`, as today. Example reason:
   `no agent took this workflow within 72h0m0s (pending-timeout); labels: [type=linux]`.
   Labels are sorted `key=value` pairs, without `woodpecker-ci.org/` labels,
   empty values, `repo` and `org-id`.
2. Then `Scheduler.CancelWorkflows(ctx, []string{id})`, one ID per call:
   `persistentQueue.ErrorAtOnce` deletes no row when one ID is missing. A
   failed store write leaves the workflow pending for the next pass. A failed
   cancel is logged: the task is already gone, and a leftover row belongs to a
   terminal workflow, which `persistentQueue.Poll` drops.
3. Dependents that can never run are finalized (next section).
4. The reaper tail finishes the pipeline when nothing is pending or running.
   `statusPriorityOrder` (server/pipeline/status.go) ranks `error` above
   running and pending, so a pull request aggregate turns red at once. The
   tail's `if changed && !pipelineEverStarted { status = model.StatusCanceled }`
   is not applied when any workflow in the tree is `error`, because
   `convertStatus` (server/forge/github/convert.go) posts `canceled` as
   success: `case model.StatusCanceled: ... return statusSuccess`.
5. One `log.Info` line per finalized workflow, with `reason=pending-timeout`
   or `reason=dependency-timed-out` and the labels. One counter,
   `woodpecker_pending_workflows_timed_out_total`.

If an agent takes the task between the `Info` snapshot and step 2, the cancel
sends it `ErrCancel`, and `checkWorkflowState` makes `RPC.Done` reject its
report. User `Cancel` has the same race.

### Dependents that can never run

The pass walks the dependents of a finalized workflow among `Info.Pending` and
`Info.WaitingOnDeps`. A dependent is dead when `Task.ShouldRun` is false for a
probe `model.Task{RunOn: t.RunOn, DepStatus: {dep: state}}`, where `state` is
`error` for the timed-out workflow and `skipped` for a dead dependent. A
default `runs_on` dependent is dead. A `runs_on: failure` dependent runs, and
the walk stops there.

A dead dependent is finalized with `Cancel`'s helpers:
`UpdateWorkflowToStatusSkipped`, and `UpdateStepToStatusSkipped(store, step, 0,
model.StatusCanceled)` for pending steps, then `CancelWorkflows` with its ID.
This is done in the same pass for two reasons:

- Otherwise the skip waits until a matching agent polls the dependent
  (`markSkipped` in `impl.Poll`), and the check stays pending all that time.
- `DepStatus` is never persisted. After a restart a dependent reloads with an
  empty `DepStatus`, `ShouldRun` returns true, and it runs although its
  dependency failed.

### Matching against live agents (option C only)

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
wraps the scheduler's own `createFilterFunc`, so the rules exist once. An agent
counts when its `LastContact` is within `pending-timeout` (Q5). `NoSchedule`
agents count: the autoscaler sets that flag to drain and clears it to reuse.

### Cases that stay queued

- **Blocked pipelines.** `Create` returns before `start` while the status is
  `StatusBlocked`, so no task exists.
- **Backlog and scale from zero.** They wait up to the timeout. With A, only a
  pool outage longer than 72 hours errors real work.
- Tasks waiting on dependencies and a paused queue (checks 1 to 3).

Out of scope: a queued task whose pipeline is already terminal. The reaper only
walks pending and running pipelines.

## Alternatives considered

- **Sweep inside `fifo.process`.** The queue has no store, no agent rows and no
  pipeline times, and the loop holds the fork's ordering rules.
- **A separate ticker.** A second scan of every active pipeline and a second
  copy of the reaper tail.
- **Reject at enqueue when no agent matches.** Breaks scale from zero.
- **Final state `canceled`.** Posts success on the required check.
- **Final state `killed`.** Also posts failure, but reads as a user stop, and
  it ranks below running, so the check stays pending while siblings run.
- **Candidates from `Info.WaitingOnDeps`, clock from pipeline creation.**
  Errors dependents whose pool is legitimately at zero.
- **Queue cancel before the store write.** A failed write leaves a pending
  workflow with no task. The next pass reaps it as `agent-gone`, and a
  never-started pipeline ends `canceled`, which posts success.
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
  `cli.DurationFlag`, default `72h` (Q2), `0` disables. It goes after
  `orphan-reap-grace` in cmd/server/flags.go.
- The sweep runs only where the orphan reaper runs: one replica.
- A new file starts with the Apache header and `Copyright 2026 Woodpecker
  Authors`, as in server/pipeline/reap.go.
- Table tests with `testify`. `TestReapOrphanedWorkflows` swaps
  `server.Config` globals, so its cases do not call `t.Parallel`.
- Existing `TestReapOrphanedWorkflows` rows keep their expectations.

## Plan

T1 is the whole plan if Q1 is A. T2 is added only if Q1 is C, after T1.

### T1. Time out pending workflows in the reaper

Files: server/pipeline/reap.go, server/pipeline/pending_timeout.go (new),
server/pipeline/reap_test.go, server/pipeline/helper_test.go,
server/config.go, cmd/server/flags.go, cmd/server/setup.go,
cmd/server/server.go, docs/docs/30-administration/10-configuration/10-server.md.

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
func finalizeDeadDependents(ctx context.Context, storage store.Store, workflows []*model.Workflow, dependents map[string][]*model.Task, parentID string, parentState model.StatusValue) []*model.Workflow
```

- `reapWorkflow`: a started workflow or step ends `killed`, as today. One not
  started ends `pendingState`. A non-empty `errMsg` goes into `Error`, and
  then `Finished` is set too. The existing call passes `model.StatusCanceled`
  and `""`.
- `runnableSince` returns `0` when a workflow named in `task.Dependencies` is
  missing from the tree or still `Running()`. Otherwise it returns the largest
  of `p.Created`, `p.Reviewed` and each dependency's `Finished`.
- `pendingTimeoutReason` returns the reason text of the Approach.
- `finalizeDeadDependents` applies *Dependents that can never run* to
  `dependents[parentID]`, and recurses with `model.StatusSkipped` into the
  dependents of each dead one. Each dead one is written first and its results
  copied into the tree, then cancelled in the queue. A failed write stops that
  branch. It returns the finalized workflows.

In `ReapOrphanedWorkflows`:

1. Next to `queued`, build `pending` (ID to task) from `queueInfo.Pending`
   and `dependents` (dependency ID to tasks) from `queueInfo.Pending` and
   `queueInfo.WaitingOnDeps`. Skip both when `pendingTimeout` is `0` or
   `queueInfo.Paused` is true.
2. In the `queued` branch, a workflow whose task is in `pending` and whose
   `runnableSince` is above `0` and before `now - pendingTimeout` goes through
   `reapWorkflow(..., model.StatusError, reason)`, then `CancelWorkflows`, then
   `finalizeDeadDependents(..., model.StatusError)`. Set `changed`, add 1 to
   the counter, and log.
3. In the tail, apply the `canceled` override only when no workflow in the
   tree is `error`.

```go
PendingTimeout time.Duration // server/config.go, after OrphanReapGrace

server.Config.Server.PendingTimeout = c.Duration("pending-timeout") // cmd/server/setup.go

pipeline.ReapOrphanedWorkflows(ctx, _store, time.Now(), server.Config.Server.OrphanReapGrace, server.Config.Server.PendingTimeout) // cmd/server/server.go
```

The docs get `### PENDING_TIMEOUT` after `### ORPHAN_REAP_GRACE`, in the same
shape: the default, `0` disables, and it needs `ORPHAN_REAP_INTERVAL` above
`0`.

### T1 tests

Written first, as rows in `TestReapOrphanedWorkflows` with the strict
`store_mocks.MockStore`, `now` as the clock, a `72h` timeout, and the counter
read by `testutil.ToFloat64`. Rows that time out:

1. A pending `type=linux` task, pipeline 73 hours old. Workflow and step end
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
   `CancelWorkflows` call. The second is untouched. The counter rises by 1.
5. `WorkflowUpdate` fails. No `CancelWorkflows`, no counter change.
6. `CancelWorkflows` fails. The workflow still ends `error`.

Rows that stay queued, each one change from row 1: the task is in
`WaitingOnDeps`; the task is in `Running`; a dependency finished 1 hour ago;
the pipeline was reviewed 1 hour ago; the pipeline is 71 hours old;
`pendingTimeout` is `0`; the queue is paused.

### T2. Live agent match (only if Q1 is C)

Files: server/model/agent.go, server/scheduler/filter.go,
server/pipeline/pending_timeout.go, their tests, and server/rpc/rpc_test.go.

```go
func (a *Agent) PollLabels() (map[string]string, error)
func NewLabelFilter(labels map[string]string) FilterFn
func loadLiveAgentFilters(storage store.Store, now time.Time, window time.Duration) ([]scheduler.FilterFn, error)
func anyAgentTakes(filters []scheduler.FilterFn, task *model.Task) bool
```

- `PollLabels` builds the map of *Matching against live agents* and returns a
  new map.
- `loadLiveAgentFilters` calls `AgentList(&model.ListOptionsWithAll{All:
  true})` once per pass and keeps agents with `LastContact` within `window`
  (Q5). On an error, no task times out in that pass.
- Tests: `TestAgentPollLabels`; `TestNewLabelFilter`; reap rows where a busy
  or `NoSchedule` live match stays, a match last seen beyond the window times
  out, a `hostname` task stays, and an `AgentList` error stays.
- Parity test: drive `RPC.Next` with the labels the agent sends, as
  `TestRPCNextInjectsReadOnlyNetrc` does, and assert its filter and
  `NewLabelFilter(agent.PollLabels())` agree on a task set without `hostname`.

## Tasks

- [ ] Before deploy: list stored agents with the admin `GET /api/agents`
      (50 per page, use `page=`). Note each agent with `type=linux` in
      `custom_labels` or `filters`, and its `last_contact`. No live match
      confirms the 5 pipelines cannot run.
- [ ] T1: add the test rows and the fake's pipeline capture; see rows 1–6
      fail.
- [ ] T1: add pending_timeout.go with the counter.
- [ ] T1: change `reapWorkflow`, `ReapOrphanedWorkflows` and the tail.
- [ ] T1: add the flag, the config field and the wiring.
- [ ] T1: add `PENDING_TIMEOUT` to the server configuration docs.
- [ ] T2, only if Q1 is C: tests first, then the four functions.
- [ ] `make lint` and `make test-server` pass.
- [ ] After deploy, within one reaper interval: the `type=linux` pipelines end
      `error`, their required check posts failure, and
      `woodpecker_pending_workflows_timed_out_total` rises.

# compass-agent moves to Effect 4

Tracker: RIG-5438

Repository paths in this record are in [RigelBuild/compass](https://github.com/RigelBuild/compass).

Amendment record of the compass-agent Effect adoption design
([`compass-agent-effect-adoption/design.md`](https://github.com/RigelBuild/compass/blob/main/docs/designs/repo/compass-agent-effect-adoption/design.md)).
That record's alternative (d) pinned stable Effect 3.x and said a later 3→4
major would be its own change. This is that change. The parent stays frozen.

Ledger-impact: DL-524.

## Open Questions

1. **Are the G1–G4 replacements acceptable?** (load-bearing) They are
   grounded in the installed `effect@4.0.5` declarations and a local spike, not
   ruled. **Recommendation:** approve them as written; approving this PR
   records that.

## Problem / Intent

Renovate opened compass #2163 (`effect` 3.22 → 4.0.2) and #2162
(`@effect/opentelemetry` → 4.0.2). Neither can land alone: #2163 fails
`compass-agent:typecheck` with 196 errors, and #2162 fails
`compass-agent:test` with `Cannot find module 'effect/Version'` because
`@effect/opentelemetry` 4 needs `effect` 4. Matt ruled (RIG-5438, option B)
to migrate now. This record maps every Effect 3 API that compass-agent uses
to its Effect 4 replacement, and fixes the four places where no direct
replacement exists.

## Rulings

Matt, RIG-5438 (2026-10-15): **B, migrate now.** `effect` and
`@effect/opentelemetry` move to 4.x together in one compass PR.

## Global Constraints

- **Versions:** `effect` `^4.0.5` and `@effect/opentelemetry` `4.0.5` (both
  npm `latest` on 2026-10-15). Both move in the root `package.json` catalog,
  in one PR.
- **Scope:** `packages/compass-agent` only, the same 14 Effect-importing
  files as today. No new Effect adoption beyond the parent's scope.
- **No behavior change.** Every transport invariant in the parent's Global
  Constraints holds. The existing `.test.ts` files are its executable form and
  stay green, edited only where an Effect API name changes.
- **The public type surface stays free of `effect`, `@effect/opentelemetry`
  and `@opentelemetry/*` types** (parent constraint,
  `src/transport/export-surface.test.ts`).
- **OTel peers:** `@effect/opentelemetry` 4.0.5 accepts the catalog's
  `@opentelemetry/*` versions (API `^1.9.1`, SDK `^2.0.0`, semantic
  conventions `^1.33.0`, logs and exporters `^0.221.0`). No OTel bump.
- **No casts.** Where a v4 overload infers `R = unknown`, fix the call shape.

## Approach

A mechanical port, done in one PR. Most of the API keeps its name. The
renames and moves are below; the four gaps follow.

### API map

Checked against the installed `effect@4.0.5` declarations.

| Effect 3 | Effect 4 | Where |
| -- | -- | -- |
| `Effect.either` + `Either.isRight` / `.left` | `Effect.result` + `Result.isSuccess` / `.failure` | `control-source.ts`, `publish-spine.ts` |
| `Effect.zipRight` | `Effect.andThen` | `frame-sink.ts` |
| `Effect.fork` | `Effect.forkChild` | `control-source.ts`, smoke test |
| `Effect.yieldNow()` | `Effect.yieldNow` (a value, not a call) | `publish-spine.ts` |
| `Effect.clock` + `clock.unsafeCurrentTimeNanos()` | `Clock` service, `currentTimeNanosUnsafe()` | `control-source.ts` |
| `Metric.increment(m)`, `Metric.incrementBy(m, n)`, `Metric.set(g, v)` | `Metric.update(m, 1)`, `Metric.update(m, n)`, `Metric.update(g, v)` | metrics, spine, sink, source |
| `Metric.tagged(m, k, v)` | `Metric.withAttributes(m, { [k]: v })` | `otel-metrics.ts` |
| `MetricBoundaries.exponential(...)` | `Metric.exponentialBoundaries(...)`, passed as `{ boundaries }` | `otel-metrics.ts` |
| `Counter.unsafeUpdate` | `Metric.update` run on the runtime | `session-blobs.ts` |
| `Fiber.RuntimeFiber<A>` | `Fiber.Fiber<A>` | `publish-spine.ts`, `control-source.ts` |
| `Queue.unsafeOffer`, `Queue.unsafeSize()` (an `Option`) | `Queue.offerUnsafe`, `Queue.sizeUnsafe()` (a `number`) | `publish-spine.ts` |
| `Cause.failureOption` | `Cause.findErrorOption` | `frame-sink.ts` |
| `Scope.extend(effect, scope)` | `Scope.provide(effect, scope)` | `frame-sink.ts` |
| `Effect.fork` | `Effect.forkChild` | smoke test only; production forks with `runtime.runFork`, unchanged |
| `Effect.yieldNow()` | `Effect.yieldNow` (a value, not a call) | `publish-spine.ts` |
| `Effect.clock` + `clock.unsafeCurrentTimeNanos()` | `yield* Clock.Clock`, then `currentTimeNanosUnsafe()` | `control-source.ts` |

`ManagedRuntime`, `Layer.merge`, `Layer.empty`, `FiberSet`, `Ref`,
`Queue.sliding`/`offer`/`take`, `Schedule.recurs` and `NodeSdk.layer` keep
their v3 names and shapes.

### The four gaps

**G1. `Logger.remove(Logger.defaultLogger)` is gone.** v3 removed the console
logger so that a handled lane failure is not reported twice. v4 replaces the
logger set with `Logger.layer(loggers)`. Use
`Logger.layer([Logger.tracerLogger])`: it drops console output and keeps log
records as span events. The test must prove both: no `console.*` call, and
the log shows up as an event on the exported span.

**G2. `Queue.takeUpTo` is gone, and `Queue.takeAll` now blocks while empty.**
`takeBatch` in `publish-spine.ts` must never block: the pump already waits on
the wake latch, and a blocking take would hold a priority frame behind an
empty trace lane. Read `Queue.sizeUnsafe(traceQ)`, then take
`min(size, room)` frames with `Queue.takeUnsafe`. This is safe for the same
reason as the parent's drop counter: the producer is synchronous and the pump
is the only consumer, so no take interleaves between the size read and the
takes. Tests cover an empty trace lane and a lane holding more than
`PUBLISH_BATCH_MAX` frames.

**G3. `Schedule.fromDelays` is gone.** The durable retry ladder
`[50, 200, 800, 2000]` becomes `Schedule.recurs(4)` with
`Schedule.modifyDelay` reading the delay by attempt index, exported as
`DURABLE_RETRY_SCHEDULE` from `frame-sink.ts`. The smoke test drives it with
`TestClock`: each retry fires at its delay, not 1 ms before, and the fifth
attempt is the last.

**G4. `TestContext.TestContext` is gone.** Tests provide
`TestClock.layer()` instead.

### Export-surface test

Effect 4 augments the global `Error` interface from `ErrorReporter.d.ts` and
`Runtime.d.ts`. The containment walk in `export-surface.test.ts` reaches
those augmentations through `Error` and reports four effect files, although
compass-agent exports no effect type. The walk skips declarations inside a
`declare global` block. The test still fails when a transport export names an
effect type; the PR shows that by a mutation check.

## Alternatives considered

- **Stay on Effect 3 and close the Renovate PRs.** Rejected by Matt's ruling.
  It also leaves `skill://effect-skills` steering agents to an old major.
- **Port module by module behind a compatibility shim.** Rejected: `effect`
  3 and 4 cannot both be installed for one package, and only 14 files are
  involved.
- **G2 with `Queue.takeBetween(q, 0, max)`.** Not chosen: its v4 declaration
  documents only `min >= 1` and says an empty queue "will wait or return done".
  The size-then-take read keeps the non-blocking behavior on a documented API,
  and the parent already relies on the same single-consumer reasoning.

## Plan

### E1: port compass-agent to Effect 4

Files: root `package.json`, `bun.lock`, `packages/compass-agent/package.json`,
the 14 Effect-importing files under `packages/compass-agent/src`, and
`packages/compass-agent/scripts/verify-abort-mutants.test.ts` (its region
anchor reads `result.left`, which becomes `result.failure`).

Interfaces:

- `export const DURABLE_RETRY_SCHEDULE: Schedule.Schedule<number, unknown, never, never>`
  in `frame-sink.ts`. The package entry does not re-export it.
- No change to any exported signature in `src/index.ts`.

Red→green:

- `compass-agent:typecheck`: 0 errors (196 on #2163 today).
- `compass-agent:test`: all pass. A local spike at compass `main` `33db6167`
  passed 864 of 864 with the map above.
- G1: `Logger.layer drops console output and retains tracer span events`.
- G2: new spine tests for an empty drain and for a drain above
  `PUBLISH_BATCH_MAX`.
- G3: the `TestClock` retry test pins delays and the attempt count.
- Export surface: a mutation that re-exports `DURABLE_RETRY_SCHEDULE` from
  `src/index.ts` turns the test red.

### E2: close the Renovate PRs

After E1 lands on `main`, close #2162 and #2163, or let Renovate close them,
and confirm `main` resolves `effect` 4.x.

## Tasks

- [ ] E1: port compass-agent to Effect 4 (compass-agent lane)
- [ ] E2: close #2162 and #2163 (compass-agent lane)
- [ ] Rewrite `skill://effect-skills` for Effect 4 (instructions lane;
  outside this record)

## Resolved decisions

1. **Effect 4 replaces Effect 3 in compass-agent** (DL-524).

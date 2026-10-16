# compass-agent moves to Effect 4

Tracker: RIG-5438

Repository paths in this record are in [RigelBuild/compass](https://github.com/RigelBuild/compass).

Amendment record of the compass-agent Effect adoption design
([`compass-agent-effect-adoption/design.md`](https://github.com/RigelBuild/compass/blob/main/docs/designs/repo/compass-agent-effect-adoption/design.md)).
That record's alternative (d) pinned stable Effect 3.x and said a later 3→4
major would be its own change. This is that change. The parent stays frozen.

Ledger-impact: DL-524, DL-529.

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

Matt, RIG-5478 (2026-10-16): **the G1–G4 replacements are approved as
written**, and **A, drain before close on the pinned-model refusal path**
(below).

## Global Constraints

- **Versions:** `effect` and `@effect/opentelemetry` at the same 4.0.x
  patch, in the root `package.json` catalog, in one PR. Use the newest patch
  that clears `bunfig.toml`'s `minimumReleaseAge` (5 days) when E1 is opened:
  4.0.5 (published 2026-10-15) clears on 2026-10-20. Do not add a
  `minimumReleaseAgeExcludes` entry for `effect`.
- **Scope:** `packages/compass-agent` only. The port touches the 14 files
  that import Effect today, plus `session-blobs.ts`, which gains an `effect`
  import (below). `@effect/platform` is removed from the catalog and from
  `packages/compass-agent/package.json`: no file imports it.
- **No behavior change, except the two named here:** `dispose` (below) and
  `Queue.offerUnsafe` (G2). Every other transport invariant
  in the parent's Global Constraints holds. `effect-smoke.test.ts` is the
  parent's record of Effect semantics, so its cases change where v4 semantics
  change, and the PR lists each changed assertion.
- **Every path that closes the transport drains first** (DL-529). In v4,
  `ManagedRuntime.make` runs every `runFork` fiber in a child scope, and
  `dispose` says "Closing fiberScope interrupts and awaits every managed
  fiber" (`effect/dist/ManagedRuntime.js`). The publish-spine and
  control-source pumps are `runtime.runFork` fibers. The normal shutdown in
  `cli.ts` already runs `storage.drain()` then `sink.drain()` before
  `transport.close()`. The pinned-model refusal in `cli.ts` closes with no
  drain, after `createAgentSession`, which on a resumed session appends an
  interrupted-turn abort record through the tee storage
  (`sessionManager.appendMessage(interruptedTurnAbort)` in the SDK's
  `sdk.ts`). The refusal path gains the same drain before close.
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

Every Effect 4 symbol in this table and the gaps resolves to an
`export declare const` in `effect@4.0.5`'s `dist/<Module>.d.ts`: `Effect.result`,
`andThen`, `forkChild`, `yieldNow`; `Result.isSuccess`; `Clock.Clock`;
`Metric.update`, `withAttributes`, `exponentialBoundaries`; `Queue.offerUnsafe`,
`sizeUnsafe`, `takeUnsafe`; `Cause.findErrorOption`; `Scope.provide`;
`Logger.layer`, `tracerLogger`; `Schedule.recurs`, `modifyDelay`; and `layer` in
`dist/testing/TestClock.d.ts`. `updateUnsafe` is a member of the `Metric`
interface: `(input: Input, context: Context.Context<never>) => void`.

| Effect 3 | Effect 4 | Where |
| -- | -- | -- |
| `Effect.either` + `Either.isRight` / `.left` | `Effect.result` + `Result.isSuccess` / `.failure` | `control-source.ts`, `publish-spine.ts` |
| `Effect.zipRight` | `Effect.andThen` | `frame-sink.ts` |
| `Effect.fork` | `Effect.forkChild` | smoke test only; production forks with `runtime.runFork` |
| `Effect.yieldNow()` | `Effect.yieldNow` (a value, not a call) | `publish-spine.ts` |
| `Effect.clock` + `clock.unsafeCurrentTimeNanos()` | `yield* Clock.Clock`, then `currentTimeNanosUnsafe()` | `control-source.ts` |
| `Metric.increment(m)`, `Metric.incrementBy(m, n)`, `Metric.set(g, v)` | `Metric.update(m, 1)`, `Metric.update(m, n)`, `Metric.update(g, v)` | metrics, spine, sink, source |
| `Metric.tagged(m, k, v)` | `Metric.withAttributes(m, { [k]: v })` | `otel-metrics.ts` |
| `MetricBoundaries.exponential(...)` | `Metric.exponentialBoundaries(...)`, passed as `{ boundaries }` | `otel-metrics.ts` |
| `metric.unsafeUpdate(1, [])` | `metric.updateUnsafe(1, Context.empty())`; it still reaches the shared default registry | `session-blobs.ts` |
| `Fiber.RuntimeFiber<A>` | `Fiber.Fiber<A>` | `publish-spine.ts`, `control-source.ts` |
| `Queue.unsafeOffer`, `Queue.unsafeSize()` (an `Option`) | `Queue.offerUnsafe`, `Queue.sizeUnsafe()` (a `number`) | `publish-spine.ts` |
| `Cause.failureOption` | `Cause.findErrorOption` | `frame-sink.ts` |
| `Scope.extend(effect, scope)` | `Scope.provide(effect, scope)` | `frame-sink.ts` |
| `TestClock` from `effect` | `TestClock` from `effect/testing` | smoke test |

`ManagedRuntime`, `Layer.merge`, `Layer.empty`, `FiberSet`, `Ref`,
`Queue.sliding`/`offer`/`take`, `Schedule.recurs` and `NodeSdk.layer` keep
their v3 names and shapes.

### The four gaps

**G1. `Logger.remove(Logger.defaultLogger)` is gone.** Use
`Logger.layer([Logger.tracerLogger])`. It replaces the logger set, so the
result equals v3's (the default set in both is the console logger plus the
tracer logger). v4 no longer logs a fiber that ends with an unhandled error,
so the parent's reason, not reporting a handled lane failure twice, no longer
applies. The layer now only keeps explicit `Effect.log*` calls off the
console. Tests prove no `console.*` call for an `Effect.log*` call and for a
failing `runtime.runFork`, and that the log is an event on the exported span.

**G2. `Queue.takeUpTo` is gone, and `Queue.takeAll` now blocks while empty.**
`dist/Queue.d.ts` documents `takeAll` as "Takes all currently available
messages, waiting until at least one message is available when the queue is
empty" and types it `Effect<Arr.NonEmptyArray<A>, E>`.
never block: the pump already waits on the wake latch. Read
`Queue.sizeUnsafe(traceQ)`, then take `min(size, room)`
frames with `Queue.takeUnsafe`. The producer is synchronous and the pump is
the only consumer, so every take finds a frame; a missing frame is a defect,
not a skip. Tests enqueue more than `PUBLISH_BATCH_MAX` trace frames with
`enqueueTrace` and assert batch sizes `[256, n]`, and drain an empty spine.

Separately, v4 `Queue.offerUnsafe` on a full sliding queue now evicts the
oldest message; v3's rejected the newest. The trace lane already uses the
effectful `offer`, so production is unchanged. The smoke test's v3 case
flips to the v4 behavior.

**G3. `Schedule.fromDelays` is gone.** The durable retry ladder
`[50, 200, 800, 2000]` becomes `Schedule.recurs(4)` with
`Schedule.modifyDelay` reading the delay by attempt index, exported as
`DURABLE_RETRY_SCHEDULE` from `frame-sink.ts`. An index past the array dies
instead of falling back to a zero delay. The smoke test drives it with
`TestClock`: each retry fires at its delay, not 1 ms before, and the fifth
attempt is the last.

**G4. `TestContext.TestContext` is gone.** Tests provide
`TestClock.layer()` from `effect/testing`.

### Export-surface test

Effect 4 augments the global `Error` interface from `ErrorReporter.d.ts` and
`Runtime.d.ts`. The containment walk in `export-surface.test.ts` reaches
those augmentations through `Error` and reports four effect files, although
compass-agent exports no effect type. The walk skips declarations inside a
`declare global` block only for those two files, and asserts the skipped set
equals that allowlist. Any other global augmentation is walked like any other
declaration, so one that names an effect type fails the leak check. The test
still fails when a transport export names an effect type; the PR shows both
by mutation checks.

## Alternatives considered

- **Stay on Effect 3 and close the Renovate PRs.** Rejected by Matt's ruling.
  It also leaves `skill://effect-skills` steering agents to an old major.
- **Port module by module behind a compatibility shim.** Rejected: `effect`
  3 and 4 cannot both be installed for one package, and only 14 files are
  involved.
- **G2 with `Queue.takeBetween(q, 0, max)`.** Rejected: v4 treats a
  non-positive bound as 0 and returns `[]` at once, even with a backlog, so
  the trace lane would never drain.
- **Refusal path: fork the pumps with `Effect.runForkWith(context)` outside
  the runtime's fiber scope.** Rejected by Matt (RIG-5478): a second fork
  path, and the pump is orphaned rather than flushed.

## Plan

### E1: port compass-agent to Effect 4

Files: root `package.json`, `bun.lock`, `packages/compass-agent/package.json`,
the 14 Effect-importing files under `packages/compass-agent/src`,
`session-blobs.ts`, `publish-spine.test.ts`, and
`packages/compass-agent/scripts/verify-abort-mutants.test.ts` (its region
anchor reads `result.left`, which becomes `result.failure`).

Interfaces:

- `export const DURABLE_RETRY_SCHEDULE: Schedule.Schedule<number, unknown, never, never>`
  in `frame-sink.ts`. The package entry does not re-export it.
- No change to any exported signature in `src/index.ts`.

Red→green:

- `compass-agent:typecheck`: 0 errors (196 on #2163 today).
- `compass-agent:test`: all pass. A local spike at compass `main` `33db6167`
  passed 864 of 864 with the map above, before the G1, G2 and dispose tests
  named here were added.
- G1: no `console.*` call for an `Effect.log*` call and for a failing
  `runtime.runFork`; the log appears as a span event.
- G2: a trace-lane drain above `PUBLISH_BATCH_MAX` gives `[256, n]`; a mutant
  that drops the `min` turns it red. An empty spine drains without publishing.
- G3: the `TestClock` retry test pins delays and the attempt count.
- Refusal drain: a resumed session with an interrupted turn and an
  unresolved pinned model commits the abort frame before `transport.close()`;
  a mutant that removes the drain turns it red.
- Export surface: a mutation that re-exports `DURABLE_RETRY_SCHEDULE` from
  `src/index.ts` turns the test red, and so does removing either file from
  the `declare global` allowlist.

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
2. **Every path that closes the transport drains first** (DL-529).

# compass-agent moves to Effect 4

Tracker: RIG-5438

Repository paths in this record are in [RigelBuild/compass](https://github.com/RigelBuild/compass).

Amendment record of the compass-agent Effect adoption design
([`compass-agent-effect-adoption/design.md`](https://github.com/RigelBuild/compass/blob/main/docs/designs/repo/compass-agent-effect-adoption/design.md)).
That record's alternative (d) pinned stable Effect 3.x and said a later 3→4
major would be its own change. This is that change. The parent stays frozen.

It also amends the transport OTel design
([`compass-agent-effect-otel/design.md`](https://github.com/RigelBuild/compass/blob/main/docs/designs/repo/compass-agent-effect-otel/design.md)).
That record's plan is already built on `main`: `otel-layer.ts`,
`otel-metrics.ts`, the spine and sink metrics, and `outbound-spans.test.ts`
exist, and the catalog pins `@effect/opentelemetry` 0.64.0. Its Effect
3.22.1 floor and its exact pin of `@effect/opentelemetry` 0.64.0 are
superseded by this record's Versions constraint. Its other decisions (spans,
metrics, exporter wiring) stand, with the API names mapped below.

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

Each Effect 4 name below is quoted from `effect@4.0.5`'s installed
declarations under `node_modules/effect/dist/` (the first overload where
there are several).

| Symbol | Declaration (`effect@4.0.5`) |
| -- | -- |
| `Effect.result` (`Effect.d.ts`) | `export declare const result: <A, E, R>(self: Effect<A, E, R>) => Effect<Result.Result<A, E>, never, R>;` |
| `Effect.andThen` (`Effect.d.ts`) | `<A, B, E2, R2>(f: (a: A) => Effect<B, E2, R2>): <E, R>(self: Effect<A, E, R>) => Effect<B, E \| E2, R \| R2>;` |
| `Effect.forkChild` (`Effect.d.ts`) | `export declare const forkChild: <Arg extends Effect<any, any, any> \| { readonly startImmediately?: boolean \| undefined; … }>` |
| `Effect.yieldNow` (`Effect.d.ts`) | `export declare const yieldNow: Effect<void>;` |
| `Result.isSuccess` (`Result.d.ts`) | `export declare const isSuccess: <A, E>(self: Result<A, E>) => self is Success<A, E>;` |
| `Clock.Clock` (`Clock.d.ts`) | `export declare const Clock: Context.Reference<Clock>;` with interface member `currentTimeNanosUnsafe(): bigint;` |
| `Metric.update` (`Metric.d.ts`) | `<Input>(input: Input): <State>(self: Metric<Input, State>) => Effect<void>;` |
| `Metric.withAttributes` (`Metric.d.ts`) | `(attributes: Metric.Attributes): <Input, State>(self: Metric<Input, State>) => Metric<Input, State>;` |
| `Metric.exponentialBoundaries` (`Metric.d.ts`) | `export declare const exponentialBoundaries: (options: { readonly start: number; … })` |
| `metric.updateUnsafe` (`Metric.d.ts`, interface member) | `readonly updateUnsafe: (input: Input, context: Context.Context<never>) => void;` |
| `Queue.offerUnsafe` (`Queue.d.ts`) | `export declare const offerUnsafe: <A, E>(self: Enqueue<A, E>, message: Types.NoInfer<A>) => boolean;` |
| `Queue.sizeUnsafe` (`Queue.d.ts`) | `export declare const sizeUnsafe: <A, E>(self: Dequeue<A, E>) => number;` |
| `Queue.takeUnsafe` (`Queue.d.ts`) | `export declare const takeUnsafe: <A, E>(self: Dequeue<A, E>) => Exit<A, E> \| undefined;` |
| `Cause.findErrorOption` (`Cause.d.ts`) | `export declare const findErrorOption: <E>(input: Cause<E>) => Option<E>;` |
| `Scope.provide` (`Scope.d.ts`) | `(value: Scope): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Scope>>;` |
| `Logger.layer` (`Logger.d.ts`) | `<const Loggers extends ReadonlyArray<…>>(loggers: Loggers, options?: { readonly mergeWithExisting?: boolean \| undefined; … })` |
| `Logger.tracerLogger` (`Logger.d.ts`) | `export declare const tracerLogger: Logger<unknown, void>;` |
| `Schedule.recurs` (`Schedule.d.ts`) | `export declare const recurs: (times: number) => Schedule<number>;` |
| `Schedule.modifyDelay` (`Schedule.d.ts`) | `<Output, Input, Error2 = never, Env2 = never>(f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>): …` |
| `TestClock.layer` (`testing/TestClock.d.ts`) | `export declare const layer: (options?: TestClock.Options) => Layer.Layer<TestClock>;` |

The v3 to v4 mapping:

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
console. The spike's smoke tests prove no `console.*` call for an
`Effect.log*` call and for a failing `runtime.runFork` that logs, and that
the log is an event on the exported span.

**G2. `Queue.takeUpTo` is gone, and `Queue.takeAll` waits while empty.**
`dist/Queue.d.ts` documents `takeAll` as "Takes all currently available
messages, waiting until at least one message is available when the queue is
empty" and "Returns a non-empty array", typed `Effect<Arr.NonEmptyArray<A>, E>`.
`takeBatch` in `publish-spine.ts` must never wait: the pump already waits on
the wake latch. Read `Queue.sizeUnsafe(traceQ)`, then take `min(size, room)`
frames with `Queue.takeUnsafe`. The producer is synchronous and the pump is
the only consumer, so every take finds a frame; a missing frame is
`Effect.die`, not a skip. The spike enqueues `PUBLISH_BATCH_MAX + 3` frames
with `enqueueTrace` and asserts batch sizes `[256, 3]`, and drains an empty
spine.

Separately, v4 `Queue.offerUnsafe` on a full sliding queue now evicts the
oldest message; v3's rejected the newest. The trace lane already uses the
effectful `offer`, so production is unchanged. The smoke test's v3 case
flips to the v4 behavior.

**G3. `Schedule.fromDelays` is gone.** The durable retry ladder
`[50, 200, 800, 2000]` becomes `Schedule.recurs(4)` with
`Schedule.modifyDelay` reading the delay by attempt index through
`durableRetryDelay(attempt)`, exported with `DURABLE_RETRY_SCHEDULE` from
`frame-sink.ts`. An index past the array is `Effect.die`, not a zero delay.
The smoke test drives the schedule with `TestClock`: each retry fires at its
delay, not 1 ms before, and the fifth attempt is the last.

**G4. `TestContext.TestContext` is gone.** Tests provide
`TestClock.layer()` from `effect/testing`.

### Export-surface test

Effect 4 augments the global `Error` interface from `ErrorReporter.d.ts` and
`Runtime.d.ts`. The containment walk in `export-surface.test.ts` reaches
those augmentations through `Error` and reports four effect files, although
compass-agent exports no effect type. The walk skips only the global `Error`
interface declarations in those two files. It asserts each skipped
declaration's full member text, base members included:
`ErrorReporter.d.ts` extends `Reportable` (`[ignore]?: boolean`,
`[severity]?: Severity`, `[attributes]?: ReadonlyRecord<string, unknown>`)
and adds nothing; `Runtime.d.ts` declares only `[errorExitCode]?: number` and
`[errorReported]?: boolean`. A new member, a changed member type, or a
changed base fails the test. Any other global augmentation is walked like any
other declaration. The test still fails when a transport export names an
effect type; the spike shows each case by mutation checks.

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
  and `export function durableRetryDelay(attempt: number): Effect.Effect<Duration.Duration>`
  in `frame-sink.ts`. The package entry re-exports neither.
- No change to any exported signature in `src/index.ts`.

Red→green:

- `compass-agent:typecheck`: 0 errors (196 on #2163 today).
- `compass-agent:test`: all pass. A local spike at compass `main` `33db6167`
  with every change in this record passes 868 of 868.
- G1: no `console.*` call for an `Effect.log*` call and for a failing
  `runtime.runFork` that logs; the log appears as a span event. A mutant with
  a console logger turns it red.
- G2: a trace-lane drain of `PUBLISH_BATCH_MAX + 3` frames gives `[256, 3]`;
  a mutant that drops the `min` turns it red. An empty spine drains without
  publishing.
- G3: the `TestClock` retry test pins delays and the attempt count, and
  `durableRetryDelay(5)` dies; a mutant that returns a zero delay turns it red.
- Refusal drain: a resumed session with an interrupted turn and an
  unresolved pinned model commits the abort frame before `transport.close()`;
  a mutant that removes the drain turns it red.
- Export surface: a mutation that re-exports `DURABLE_RETRY_SCHEDULE` from
  `src/index.ts` turns the test red, and so does an effect-typed member added
  to, or replacing a member of, either skipped `Error` declaration or
  `Reportable`.

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

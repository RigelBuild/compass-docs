# Compass: `noUncheckedIndexedAccess` in the shared base (RIG-3137)

## Open Questions

### Q1: Where does the flag live? (load-bearing; blocks T4 to T6)

This is a **major** bump, not a minor one. The meissa package README
(`packages/tsconfig/README.md`) says: "A change that can make consuming CI fail
(a stricter option or rule) is a major version."

- **A. In `@rigelbuild/tsconfig` `base.json`, released as `2.0.0`.** compass
  and docs bump their pins. meissa drops its root delta. Every consumer and
  every new repo gets the flag by default.
- **B. In compass's root `tsconfig.base.json` only**, as meissa does. There is
  no release. A project that extends the package directly still gets the
  weaker base.

**Recommendation: A.** The issue's problem is that a new project that extends
the base silently gets the weaker setting. B fixes that in compass only.
meissa's first root `tsconfig.base.json` set the flag, and RIG-5267 moved it
into a root delta when it published the package. After T1 to T3, all three
consumers are clean (§ Measured). A deletes two local overrides. B adds a
third.

Decision needed (RIG-6029): A or B. The plan follows A. Under B, drop T4 and
T6, and T5 adds the flag to compass's root base instead of bumping the pin.

## Problem / Intent

NUIA is set by a delta in meissa's root `tsconfig.base.json` and in 24 compass
`tools/*` leaves. It is not in the shared base. compass's root base is only
`{"extends": "@rigelbuild/tsconfig/base.json"}`. So `apps/ui`,
`packages/compass-agent`, `packages/compass-client`, `apps/eng-docs` and four
`tools/*` leaves run without it, and so does any new project. Fix the latent
errors by narrowing, make NUIA the default, and delete the per-leaf copies.

## Approach

### Measured

Measured at compass `main` 9b4b8bbe and meissa `main` de57c71a, with
`bunx tsc --noEmit -p <proj>/tsconfig.json --noUncheckedIndexedAccess`. The
table shows errors added over each baseline.

| Project | Added | In tests | Source sites |
| --- | --- | --- | --- |
| `apps/ui` | 252 | 223 | 29 in 10 files |
| `packages/compass-agent` | 228 | 213 | 15 in 5 files |
| `apps/eng-docs` | 12 | 3 | 9 in `scripts/gather.ts` |
| `tools/toolchain/devenv-cli` | 1 | 1 | 0 |
| `tools/toolchain`, `tools/stamp-gate`, `tools/operator-cli-check`, `packages/compass-client` | 0 | — | — |
| docs repo `tsconfig.json` | 0 | — | — |

The issue's counts (385 errors, 14 leaves) are stale. Most TS2339 errors are
cascades: in `apps/ui/src/session-events.test.ts`, `const item = items[0]`
stops the next `item.kind` check from narrowing. One guard clears the chain.
The docs repo shows the same 9 pre-existing diagnostics either way, and its CI
runs no type check.

### Chosen approach

Decision: DL-638.

**Fix each project behind a leaf flag, then move the flag into the base.** Each
fix slice adds `"noUncheckedIndexedAccess": true` to its project's
`tsconfig.json` and fixes that project's errors in the same PR. The slice is
red before its fixes, and a cleaned project cannot regress while the others
land. Then meissa releases the base, and each consumer bumps and deletes its
local copies.

**eng-docs extends only `astro/tsconfigs/strict`**, so no base reaches it. T1
gives it `["../../tsconfig.base.json", "astro/tsconfigs/strict"]`, the order
the docs repo already uses, with Astro last so its `target` and `module` win.
The base's other strict flags add no errors there.

**No new `!`.** compass Biome has `style/noNonNullAssertion` only at warning
level. A probe linted with compass's `biome.json` exited 0. The repo has 0
unsuppressed hits, and each of the 3 existing `!` has a `biome-ignore` with a
reason. T1 promotes the rule to `error`, so a new `!` fails `root:lint` unless
a visible suppression is added.

**No new `as`.** `nursery/noUnsafeTypeAssertion` flags `as unknown as T` and
allows `as const`. compass has 542 existing hits, so promoting it is a
separate burn-down. Each slice reports its count, which must not grow.

**One `nth` test helper per package (new).** Bun's `toBeDefined(): void` does
not narrow, so each indexed fixture read needs a guard. About 440 errors are
test reads such as `const req = transport.requests[0]` (23 of them in
`packages/compass-agent/src/forge.test.ts`). One helper replaces about a
hundred copies of the same throw. Each package keeps its own 6-line copy:
one shared function does not justify a cross-package test import.

### Alternatives considered

- **Flip first, suppress later:** that needs about 490 `@ts-expect-error` or
  `!`, which the issue forbids.
- **One PR:** about 490 fixes in four projects is too much for one review.
- **No leaf flags:** nothing guards a cleaned project, and T5 goes red on any
  regression.

## Plan

## Global Constraints

1. **Narrowing only.** No new `!`, unsafe `as` (`as const` is allowed),
   `@ts-expect-error` or `@ts-ignore`. Use an `=== undefined` guard on the
   function's existing failure path (return, skip or throw), destructuring
   plus a guard, a non-empty tuple `[T, ...T[]]` for a shape that is never
   empty, or `?.`/`??` where the code already treats absence as normal.
2. **No behavior change.** Never hide a required value behind a default such
   as `?? ""`.
3. **Tests narrow through `nth` or a throw guard**, never `toBeDefined()`.
4. **Leaf flag per fix slice.** T5 removes every leaf copy.
5. **Gate per slice:** `moon run <project>:ci root:lint`. Red first: with the
   flag on and no fixes, the type check fails.
6. **PR-body evidence:** the NUIA error count (before, then 0); the count of
   `lint/nursery/noUnsafeTypeAssertion` lines from
   `bunx biome lint --only=nursery/noUnsafeTypeAssertion --reporter=concise --max-diagnostics=none <dir>`;
   and `git grep -c 'biome-ignore lint/style/noNonNullAssertion'`. Neither
   count may grow.
7. **Pins:** TypeScript `^6.0.3` and Biome 2.5.15. Do not upgrade.
8. **Public repos:** name no private repository in code, comments or PR bodies.
9. **Order:** T1 to T3 are independent. T4 waits for all three, because
   Renovate opens the compass bump PR at release (`minimumReleaseAge: null` for
   `@rigelbuild/tsconfig` in `tools/renovate/config.json5`). T5 and T6 follow
   T4's release.

### T1: compass small slice (Biome rule, devenv-cli, eng-docs)

This slice clears 13 errors: the `match[1]` TS2345 in
`tools/toolchain/devenv-cli/core.test.ts`, plus 9 in
`apps/eng-docs/scripts/gather.ts` and 3 in `scripts/gather.test.ts`. Red
first: `moon run compass-eng-docs:check` must fail with the flag on and no
fixes. If it passes, `astro check` skips `scripts/`. Stop and report.

Interfaces:

- compass `biome.json` `linter.rules.style`: add `"noNonNullAssertion": "error"`.
  A scratch `!` must fail `root:lint`. Remove it before commit.
- `tools/toolchain/devenv-cli/tsconfig.json` and `apps/eng-docs/tsconfig.json`:
  add the leaf flag. eng-docs also gets
  `"extends": ["../../tsconfig.base.json", "astro/tsconfigs/strict"]`.
- `apps/eng-docs/moon.yml` `tasks.check.inputs`: add `'/tsconfig.base.json'`,
  as every `typecheck` task already has.
- Gate: `moon run devenv-cli:ci compass-eng-docs:ci root:lint`.

### T2: compass-agent

This slice clears 228 errors. The source sites are `parseTraceparent` in
`src/trace-bridge.ts` (9), `src/agent.ts` (3), and one each in
`src/transport/{control-source,frame-sink,publish-spine}.ts`. The tests are
mostly `FakeTransport.requests[0]` reads in `forge`, `mapping`, `cli`,
`lifecycle`, `board` and `agent` `.test.ts`.

Interfaces:

- New `packages/compass-agent/src/test-support.ts`:

  ```ts
  /** Index a fixture array; throws, failing the test, when the slot is empty. */
  export function nth<T>(items: readonly T[], index: number): T;
  // throws new Error(`expected an item at index ${index}, got ${items.length}`)
  ```

- `packages/compass-agent/tsconfig.json`: add the leaf flag.
- No exported API change. `parseTraceparent(header: string): SpanContext | undefined`
  keeps its signature.
- Gate: `moon run compass-agent:ci root:lint`.

### T3: apps/ui

This slice clears 252 errors. Source sites: `src/board-nav.ts` (7),
`src/markdown/highlight-cache.ts` (5), `src/components/Bridge.tsx` (4),
`src/comms.ts`, `src/keyboard/fuzzy.ts` and `src/live/comms-state.ts` (3 each),
and one each in `MarkdownText.tsx`, `keymap.ts`, `stream.ts` and `store.ts`.
Test hotspots: `session-events.test.ts` (54), `ChannelView.ask.test.tsx` (23),
`ChannelView.test.tsx` (21) and `store.live.test.ts` (15).

Interfaces:

- `apps/ui/src/test-support.ts`: add `nth`, the same as in T2.
- `apps/ui/tsconfig.json`: add the leaf flag.
- Gate: `moon run compass-ui:ci root:lint` (this includes `build` and
  `visual-gate`).

### T4: meissa base flag and 2.0.0 release (after T1 to T3)

Interfaces:

- `packages/tsconfig/base.json` `compilerOptions`: add
  `"noUncheckedIndexedAccess": true`.
- Root `tsconfig.base.json` becomes `{"extends": "@rigelbuild/tsconfig/base.json"}`.
- `shared-configs.test.ts`, in `describe("shared configuration packages")`:
  add a test named `"tsc rejects an unchecked index under the shared base"`.
  Copy `packages/tsconfig/{package.json,base.json}` into a temp fixture's
  `node_modules/@rigelbuild/tsconfig/`. Use this `tsconfig.json` and fixture
  file:

  ```json
  {"extends": "@rigelbuild/tsconfig/base.json", "include": ["fixture.ts"]}
  ```

  ```ts
  const xs: number[] = [];
  export const n: number = xs[0];
  ```

  The workspace `node_modules/.bin/tsc --noEmit -p <fixture>` must exit
  non-zero with `TS2322`. Mutation: with the flag removed from the copied
  `base.json`, it exits 0.
- Commit:
  `feat(tsconfig)!: enable noUncheckedIndexedAccess in the shared base (RIG-3137)`,
  with a `BREAKING CHANGE:` footer. release-please then cuts `2.0.0`.
- Gate: `moon run :ci --force`.

### T5: compass pin bump and leaf cleanup (after T4)

Interfaces:

- Root `package.json` `workspaces.catalog["@rigelbuild/tsconfig"]`: change
  `"1.0.0"` to `"2.0.0"`, then update `bun.lock`. Close the matching Renovate
  PR as superseded.
- Delete the flag from all 28 leaves: 24 `tools/*`, `tools/toolchain/devenv-cli`,
  `apps/eng-docs`, `packages/compass-agent` and `apps/ui`. No compass
  `tsconfig*.json` outside `node_modules` names it after this task.
- Proof: `bunx tsc -p <proj>/tsconfig.json --showConfig` lists the flag for
  `apps/ui`, `apps/eng-docs`, `packages/compass-client` and `tools/stamp-gate`.
- Gate: the full `moon run :ci` sweep. Every `typecheck` input list includes
  `/bun.lock`.

### T6: docs pin bump (after T4)

Interfaces:

- `package.json` `devDependencies["@rigelbuild/tsconfig"]`: change `"1.0.0"` to
  `"2.0.0"`, then update `bun.lock`.
- Proof: `bunx tsc -p tsconfig.json --showConfig` lists the flag.
  `bunx tsc --noEmit -p tsconfig.json` still reports the same 9 diagnostics.
- Gate: docs CI is green.

## Tasks

- [ ] T1: compass: `noNonNullAssertion` set to `error`; devenv-cli and eng-docs
      fixed behind leaf flags; eng-docs extends the root base
- [ ] T2: compass-agent: 228 errors narrowed, `nth` helper, leaf flag
- [ ] T3: apps/ui: 252 errors narrowed, `nth` helper, leaf flag
- [ ] T4: meissa: flag in the base, root delta dropped, consumer test, 2.0.0
      release (after T1 to T3; Q1 = A)
- [ ] T5: compass: pin bumped to 2.0.0, 28 leaf copies deleted (after T4)
- [ ] T6: docs: pin bumped to 2.0.0 (after T4)

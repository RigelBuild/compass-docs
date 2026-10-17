# Share repo tools from one public repo (RIG-4351)

## Problem / Intent

Compass and another consumer each keep their own copy of the same repository
tools, and the copies drift. A fix can land in one copy and not the other.
> Redacted 2026-10-17: private consumer identity and CI configuration details removed from the public record.

Intent: move tools used by both consumers into one new public repo, and have
each consumer pin it so each tool has one copy. This record folds in RIG-4184
("share the design-ledger tools from one source"). The ledger tools are its
first slice.

## Inventory

An inventory compared Compass's public tooling with that of another consumer.
Consumer-side findings are omitted here.
> Redacted 2026-10-17: private consumer file inventory, measured diffs, CI and Renovate configuration, and pin details removed from the public record.

| Compass tool or config | Compass-side scope | Decision |
| --- | --- | --- |
| `tools/design-ledger-gate/` | Design-ledger checks | Move (T4) |
| `tools/dl-reconcile/` | Design-ledger reconciliation | Move (T5) |
| `tools/dl-claim/` | Design-ledger claims | Move (T5) |
| `tools/sea-ref-gate/` and a second reference gate under `tools/` | Reference checks | Move as `ref-gate` (T3) |
| `tools/renovate-preflight/` | Renovate preflight | Move (T6) |
| `.moon/tasks/tag-bun.yml` | Bun moon task template | Stay local |
| Root checks in `moon.yml` | Lint, format, and markdown checks | Stay local |
| `tools/renovate/config.json5` and `tools/renovate/refresh-*.ts` | Renovate configuration and upgrade scripts | Later record |

## Approach

### One public repo, one package per tool

Use the public repo `RigelBuild/meissa` (see Decisions). The tooling lane
creates its Nix side: pinned nixpkgs, shared rumdl and biome, and a daily relock.
This record adds the TS tools in a bun workspace, with one package per tool
under `packages/<tool>/`, published as `@rigelbuild/<tool>` with a bin of the
same name. Consumers pin exact versions and remove their local copies in the
same PR. No shim or re-export remains.

The port base is Compass's public copy. Additional shared behavior is written
as new public code and tested with synthetic fixtures.
> Redacted 2026-10-17: private-only implementation differences removed from the public record.

### Config, not literals

Shared tools accept per-consumer configuration rather than hardcoding ledger,
reference-gate, or counter values.
> Redacted 2026-10-17: private ledger inventory and counter-partition details removed from the public record.

The CLIs keep their environment inputs (`REPO`, `PR_NUMBER`, `GH_TOKEN`,
`DL_CLAIM_TOKEN`, `RENOVATE_TOKEN`). Every tool also reads `GATE_ROOT`, default
the git toplevel, as the consumer root. A tool under `node_modules` cannot find
the ledger relative to its own file. The counter URL comes only from
`counter.url`; no env var overrides it.

Exit codes are normalized to 0 pass, 1 violations, 2 usage or internal error.
This is a change, not a carry-over: `dl-claim` and `dl-reconcile` exit 1 for
every error today. CI only checks for non-zero, so no workflow changes.

CI jobs that invoke a package bin need to install it first. Those jobs use a
frozen lockfile so each install is checked against the selected dependency set.
> Redacted 2026-10-17: private CI workflow and secret-handling details removed from the public record.

### Pinning (OQ1: npm)

| Option | How a consumer pins | For | Against |
| --- | --- | --- | --- |
| npm package (chosen for TS tools) | Exact version in the bun catalog; `bun.lock` keeps the integrity hash | Compass already takes tools as bun dependencies. One package per tool. | Needs a publish lane in the shared repo and a one-time bootstrap publish per package |
| bun git dependency | `github:RigelBuild/meissa#<sha>` in the root `package.json` | No registry and no publish lane | One package for the whole repo (bun installs a git repo root, not a subdirectory). |
| Rev-pin JSON | A `{repo, ref, rev}` file plus a fetch step before each run | No separate registry | Each consumer writes its own fetch step. The tools' npm dependencies need a separate install. No typed imports. Local runs need the fetch too. |
| Nix flake input | Flake input, locked by the consumer's lock file | Content-addressed and nix-native | Each bun tool would need a nix package build, and moon and `tsc` cannot typecheck against a store path. |

> Redacted 2026-10-17: private consumer pin mechanism and pin inventory details removed from the public record.

TS tools ship as npm packages, so a tool bump is an ordinary catalog PR with
release notes. Per OQ5, first-party pins skip the release-age cooldown in
every toolchain.

Publishing uses npm trusted publishing (OIDC from the shared repo's `main`
release workflow), so no long-lived publish token exists. The `@rigelbuild`
npm scope already exists (compass resolves `@rigelbuild/solid-virtual` from
npm). npm can set a trusted publisher only on a package that already exists,
so each new package needs one bootstrap publish and one trusted-publisher entry.
These steps have no IaC path, so they go to Matt as one human-action issue.

### Nix tooling

The related Nix-tooling record covers the shared builder question. This record
moves no Nix code. The shared repo's Nix exports remain separate tooling work.
> Redacted 2026-10-17: private builder comparison details removed from the public record.

### What may move (the public boundary)

A tool qualifies only if all three conditions hold:

1. It runs in Compass today, or it is a generic check that any public repo could
   run unchanged.
2. It holds no consumer-specific literal; those values come from configuration.
3. Its tests use synthetic fixtures only.
> Redacted 2026-10-17: private consumer names, paths, surfaces, counters, hosts, and record citations removed from the public record.

Enforcement:

- The shared repo runs `ref-gate` on itself as a required check. Consumer-specific
  patterns live only in the gate's carved-out config.
- Port PRs start from public code. New shared behavior is implemented independently
  against public requirements and tested with synthetic fixtures.
- Matt is CODEOWNER and approves every PR, as in compass.
> Redacted 2026-10-17: private-name gate configuration and private-only feature details removed from the public record.

### Drift prevention after migration

No local copy is left to drift. Consumers pin exact package versions, and fixes
reach each consumer through its package update. Any skew is a version difference,
not a fork.
> Redacted 2026-10-17: private consumer pin-update and Renovate timing details removed from the public record.

### Alternatives considered

- Keep the tools in compass and have a consumer pin compass: rejected by the ask.
  It ties the consumer to compass's `main` and mixes product releases with tool
  releases.
- Keep vendored copies and add a CI check that they match the pin: rejected. It
  keeps two copies to edit, and the check only reports drift after it happens.
- Git submodule: rejected. jj, the house VCS, does not manage submodules.

## Global Constraints

- The shared repo is public and follows the boundary in "What may move".
- Licence: `MIT OR Apache-2.0` (OQ6). This relicenses tools that are
  AGPL-3.0-only in compass, so T2 first checks that no ported file has an
  outside contribution. A file that has one stays out until its author agrees.
- Runtime and checks: bun, TypeScript `strict` plus `noUncheckedIndexedAccess`,
  biome, `bun test`, rumdl for markdown.
- Each tool is the package `@rigelbuild/<tool>` under `packages/<tool>/`, with
  bin `<tool>` pointing at `./index.ts` (shebang `#!/usr/bin/env bun`).
- CLIs read `GATE_ROOT` (default git toplevel) and exit 0 / 1 / 2 as defined
  in "Config, not literals".
- Consumers pin an exact npm version, never a range.
  Bumps arrive only by Renovate PR.
- First-party pins skip the release-age cooldown wherever one applies (OQ5):
  `@rigelbuild/*` npm packages in `bunfig.toml` (exact names, one entry each)
  and in Renovate, and `RigelBuild/*` git-refs pins in Renovate. Go modules and
  nix inputs have no package-manager cooldown, and compass has no first-party
  Go dependency today.
- A consumer's switch PR deletes its local copy in the same PR. No vendored
  copy, wrapper, or re-export stays behind.
- No consumer literal in shared code, tests, comments, or docs.

## Plan

Order: T1 (meissa exists), T2, T3, then T4 and T6 in parallel, then T5, then
T7, T8, T9. T10 is done.
T3 comes first among the tools because it guards every later meissa PR.
T5 follows T4 because it imports `LedgerConfig` from the T4 package. RIG-4184's
scope is T4, T5, and the ledger part of T7 and T8.

### T1 — Meissa exists

Not built here. The tooling lane creates meissa through the org's GitHub IaC,
with a seeded `main`, a ruleset, and a place in the Trunk queue, then adds its
Nix exports and daily relock. This record's T2 starts once that lands.

Interfaces: consumes meissa's `main`, ruleset, and CI.

### T2 — Bun workspace and release lane

Lands in: meissa, plus one org GitHub IaC change after its CI first runs
(meissa's ruleset gains the required checks). A bun workspace over
`packages/*`, moon, a licence file under each package (after the
outside-contribution check), a GitHub Actions CI job that runs typecheck,
lint, and test per package, and
the release lane: release-please per package, then
`npm publish --provenance` through trusted publishing, after the bootstrap
publish of each package. It reuses the rumdl and biome meissa already exports.
The tooling lane owns meissa's devenv, flake, and relock rules, and they
export only rumdl and biome. So T2 adds bun, node, and moon to meissa's dev
shell and CI, from nixpkgs at meissa's pin, as an addition the tooling lane
reviews. T2 adds only the npm and release-please Renovate rules. Any secret
the release lane needs on meissa is a separate org GitHub IaC change in T2;
the tooling lane provisions only the Renovate App credentials.

Interfaces: each `packages/<tool>/package.json` has
`"name": "@rigelbuild/<tool>"` and `"bin": { "<tool>": "./index.ts" }`.

### T3 — `ref-gate`

Lands in: the shared repo. Merge Compass's `sea-ref-gate` and a second
reference gate into one config-driven gate. Turn it on as the shared repo's own
required check in the same PR.

Interfaces:

```ts
export interface RefGateConfig {
  prefilter: { ere: string; ignoreCase: boolean }; // POSIX ERE handed to git grep
  patterns: readonly { source: string; flags: string }[]; // JS RegExp, applied per hit
  ignore: readonly string[]; // compound names stripped before matching, e.g. a gate's own name
  carveOutPaths: readonly string[];
  carveOutPrefixes: readonly string[];
  allowlist: Readonly<Record<string, string>>; // path -> reason
  remediationDoc?: string;
}
export function loadRefGateConfig(path: string): RefGateConfig; // throws on unknown keys
export function findViolations(config: RefGateConfig, grepHits: readonly string[]): Reference[];
export async function runOnce(deps: Deps, config: RefGateConfig): Promise<number>;
```

The coarse git-grep search is its own POSIX ERE, not derived from the JS
patterns. A JS-only construct such as `\b` in a git-grep ERE can match nothing,
and the gate then passes when it should fail.

CLI: `ref-gate --config <path>`.

### T4 — `design-ledger-gate`

Lands in: the shared repo. Port compass's gate. Add a list of ledgers (each
with its own surface), malformed-row reporting, and the three extra legs behind
config (OQ3: yes). Tests: compass's tests plus synthetic multi-ledger fixtures.
Each extra leg gets a fixture that must fail (a malformed row, a stale
citation, a missing errata target, a broken record link) and one that must
pass.

Interfaces:

```ts
export interface LedgerEntry {
  path: string; // e.g. "docs/designs/DECISIONS.md"
  surface: string; // counter surface for IDs in this ledger
  governedRoots: readonly string[]; // record dirs this ledger governs
}
export interface LedgerConfig {
  ledgers: readonly LedgerEntry[]; // compass: one entry
  historicalChain?: readonly string[]; // record paths that must be Historical
  exemptBranches?: readonly { prefix: string; author: string }[]; // same-repo bot PRs only
  legs?: { citations?: boolean; errata?: boolean; recordLinks?: boolean }; // each default false
  counter: { url: string; partition: string };
}
export function loadLedgerConfig(path: string): LedgerConfig; // throws on unknown keys
export async function runOnce(deps: Deps, config: LedgerConfig): Promise<number>;
```

CLI: `design-ledger-gate --config docs/designs/ledger.config.json`.

### T5 — `dl-claim` and `dl-reconcile`

Lands in: the shared repo. Both depend on `@rigelbuild/design-ledger-gate` for
`LedgerConfig` and `loadLedgerConfig`, so the loader has one copy. Reconcile
keeps compass's guards (raw-row cross-count, empty-frontier refusal, `--check`)
and adds the stale and duplicate claim report. Messages that name the counter
take its URL from config.

Interfaces:

```ts
// dl-claim
export interface ClaimRequest { repo: string; surface: string; ref: string; lane: string; count: number }
export function buildClaimBody(config: LedgerConfig, args: ClaimArgs): ClaimRequest;
// dl-reconcile
export interface LandedDecision { id: string; surface: string; ref: string }
export interface ReconcileRequest { repo: string; landed: LandedDecision[] }
export function assertReconcilableLedgers(
  config: LedgerConfig,
  ledgers: ReadonlyMap<string, string>, // ledger path -> text
): ReconcileRequest;
```

CLIs: `dl-claim --config <path> --ref <RIG-n|none> --lane <branch> [--count 1..10] [--surface <s>]`
and `dl-reconcile --config <path> [--check]`, both reading `DL_CLAIM_TOKEN`.
`--surface` is required when the config lists more than one ledger. `repo` is
always `counter.partition`. Consumes the T4 release.

### T6 — `renovate-preflight`

Lands in: the shared repo. Move compass's copy unchanged except package
metadata.

Interfaces: CLI `renovate-preflight`, env `REPO` and `RENOVATE_TOKEN`, exit
codes as today; `classify(probe: ProbeResult): PreflightResult` stays exported.

### T7 — Compass cutover

Lands in: compass. Add the five packages at exact versions. Add
`docs/designs/ledger.config.json`: one ledger (`docs/designs/DECISIONS.md`,
surface `designs`, the seven current buckets `ui`, `agent`, `server`, `meta`,
`infra`, `observability`, `repo`), an empty historical chain, `renovate/` exempt for `app/rigelbuild-renovate`
and `trunk-merge/` for `app/trunk-io` (same-repo PRs only), all legs off, partition `compass`, url
`https://dl.rigel.build`.

Add two code-free moon projects:

- `tools/design-ledger/`: `check` and `ci` tasks call the `design-ledger-gate`
  and `dl-reconcile --check` bins. `tools/ci-matrix/index.ts` injects
  `ALWAYS_RUN_ON_PR` by moon project id, and it injects nothing, with no error,
  when the project is missing. So keep the id `design-ledger-gate`, or update
  `ALWAYS_RUN_ON_PR` and its test in the same PR.
- `tools/ref-gates/`: `moon.yml` plus public reference-gate configs. Each config
  carves out `tools/ref-gates/`. The configs use allowlists only for public
  references and keep the gate's own directory name in their ignore lists.

Point the moon tasks, `.github/workflows/dl-reconcile.yml`, the Renovate
preflight step, `.moon/workspace.yml`, `docs/designs/CONTRIBUTING.md` §7, and
`docs/concepts/self-host-and-managed.md` (which names the old ref-gate task) at
the new bins and projects. The two secret-holding jobs gain a
`bun install --frozen-lockfile` step (OQ4). Exempt first-party pins from the
cooldown (OQ5). In `bunfig.toml`, add each new `@rigelbuild/*` package by
exact name to `minimumReleaseAgeExcludes`. In Renovate, add those names to the
catalog soak-exemption rule, which `config.test.ts` requires to match the
catalog part of the bunfig list. Add a rule exempting the
`@rigelbuild/solid-*` pins in `apps/ui/package.json`, which still soak today.
Confirm every `RigelBuild/*` git-refs rule already sets
`minimumReleaseAge: null`. Delete
`tools/design-ledger-gate/`, `tools/dl-claim/`, `tools/dl-reconcile/`,
`tools/sea-ref-gate/`, the unused local reference gate, and
`tools/renovate-preflight/`.

Acceptance:

- A seeded corpus, as its own git repo. For each gate leg the corpus holds one
  seeded fault. The PR body lists, per fault, the expected `file:line` and the
  expected exit code (1). Both the old and new tools must report exactly that
  `file:line` and exit 1. Only the old ledger gate reads `GATE_ROOT`. Run the
  old ref gates with cwd set to the corpus, and compare old reconcile through
  its exported `assertReconcilableLedger` on the corpus ledger.
- The same corpus with the faults removed: both tools exit 0 and report no
  violations.
- Exempt prefixes apply only to the ledger gate's touch-coupling leg, which
  needs PR context. Seed a record touched with no ledger edit and no
  `Ledger-impact:` line. Drive both ledger gates through `runOnce` with that
  injected changed set, a `headBranch`, an `author`, and `crossRepository`. A
  normal branch exits 1 on both. `renovate/` and `trunk-merge/` from their bot
  and this repo exit 0 on both; the same prefix from another author or a fork
  exits 1 on both. The tool name in output is
  the stated intended change.
- On a docs-only PR, the ci-matrix output still contains the ledger gate target.

Record each result in the PR body.

Interfaces: consumes the T3–T6 releases; produces the config files above.

### T8 — Another consumer cutover

Lands in: another consumer. It adopts shared packages, supplies its own
configuration, points CI at the package bins, and removes local copies.
> Redacted 2026-10-17: private consumer file, CI, and counter-configuration details removed from the public record.

Interfaces: consumes the T3–T6 releases.

### T9 — Compass turns on the extra ledger legs

Lands in: Compass. Run the citation, errata, and record-link legs over the
corpus, fix every finding, and turn the legs on in the same PR.

Interfaces: consumes T4; edits `legs` in `docs/designs/ledger.config.json`.

### T10 — Shared Nix tooling inventory

The related Nix-tooling record addresses the builder question. This record's
T10 closes when that record merges.
> Redacted 2026-10-17: private Nix file comparison and inventory details removed from the public record.

### Out of scope

Later records cover the shared Renovate preset and upgrade scripts. The moon task
template and root checks stay local. Wiring the touch-coupling leg into Compass
CI is separate work. The public DL counter service (`dl.rigel.build`) does not move.

## Tasks

- [ ] T1 — Meissa exists (tooling lane).
- [ ] T2 — Add the bun workspace and release lane to meissa.
- [ ] T3 — Ship `ref-gate` and make it the shared repo's required check.
- [ ] T4 — Port `design-ledger-gate` onto a list of ledgers.
- [ ] T5 — Port `dl-claim` and `dl-reconcile` onto `LedgerConfig`.
- [ ] T6 — Move `renovate-preflight`.
- [ ] T8 — Cut another consumer over and delete its local copies.
  > Redacted 2026-10-17: private consumer local-copy and CI cutover details removed from the public record.
- [ ] T9 — Turn on compass's extra ledger legs.
- [ ] T10 — Write the shared Nix tooling inventory record.

## Decisions (Matt, 2026-10-04 RIG-4440; repo name and Nix 2026-10-05)

- **OQ1 — pin mechanism:** npm packages for the TS tools. The separate Nix
  tooling record resolves the builder question; no Nix moves here.
- **OQ2 — names:** npm scope `@rigelbuild/<tool>`. The repo is
  `RigelBuild/meissa`, the public shared infrastructure repo (RIG-4469).
- **OQ3 — additional ledger-gate behavior:** implemented as new public code with
  synthetic fixtures.
  > Redacted 2026-10-17: private-only implementation-specific feature details removed from the public record.
- **OQ4 — install in secret-holding jobs:** a full
  `bun install --frozen-lockfile`.
- **OQ5 — cooldown:** every first-party pin skips the release-age cooldown, in
  every toolchain (TS, Go, Nix).
- **OQ6 — licence:** relicense to `MIT OR Apache-2.0`.

# Comment-preserving config.yml writes

Linear: RIG-3728. Design fork settled in RIG-3999, option A: `yaml` package
`parseDocument` plus surgical `setIn` / `deleteIn`.

## Problem / Intent

Every settings save (`Settings.set`, `setModelRole`, `setProjectModelRole`) rewrites
`config.yml` from a plain object through `stringifyYamlConfig`, so user comments are
structurally absent before the write happens. A `setupVersion` migration against a
git-tracked, symlinked config lands a comment-stripping diff. Writes must keep every
comment of every key the save did not change, with no change to the file-lock,
source-generation, symlink, quarantine or reader semantics that already exist.

## Approach

Parse the exact source text already captured under the write lock
(`YamlContentGeneration.source`) with `yaml`'s `parseDocument`, reconcile the document
toward the object the current code already computes, and serialize with
`Document.toString`. Readers are untouched: `Bun.YAML.parse` stays the only parser on
every load path (`#loadYamlIfPresent`, `#loadOverlayYaml`, `ConfigFile.#parseContent`).
The `yaml` package is a write-side serializer only.

- **Reconcile; never re-express mutations.** `#saveNow` and `#saveProjectNow` keep
  building `current` / `projectSettings` exactly as today (`setByPath`, per-role merge,
  stale-generation skips, quarantine recovery, `#migrateRawSettings` already applied by
  `#loadYamlIfPresent`). The new step takes `(source, target)` and issues the minimal
  `setIn` / `deleteIn` ops so that the document parses to `target`. It recurses into
  maps and sequences and touches only differing leaves. A whole-map `setIn` is never
  issued: measured, `setIn(["modelRoles"], map)` drops every per-role inline comment,
  while per-leaf `setIn` keeps them because `YAMLMap.add` updates `prev.value.value` in
  place when both sides are scalars.
- **Target is normalized through the existing serializer.**
  `target = Bun.YAML.parse(stringifyYamlConfig(next))`. This pins today's on-disk
  semantics by construction (undefined-valued keys dropped, legacy keys deleted) for one
  extra in-memory round trip per debounced save.
- **No-op short-circuit.** When `Bun.YAML.parse(source)` deep-equals `target`, the
  original bytes are returned and nothing is written. This is what makes a second
  migration byte-identical; `toString` alone is not byte-stable (measured: `[a, b]`
  becomes `[ a, b ]`, 4-space indent becomes 2).
- **Round-trip guard.** The output is re-parsed with `Bun.YAML.parse` and must
  deep-equal `target`. `yaml` never validates its own output; Bun does, so the reader's
  semantics decide (for example a `%YAML 1.1` file where `yaml` reads `yes` as `true`
  and Bun reads the string `"yes"`: the reconcile re-sets the scalar quoted and Bun
  reads the same value as before).
- **Unpreservable sources fail closed (RIG-4215, option A).** A source that Bun
  loaded but `yaml` cannot edit safely — `doc.errors` non-empty (duplicate keys: Bun is
  last-wins, `parseDocument` reports `DUPLICATE_KEY`, and with `uniqueKeys: false` the
  CST edits the first pair while `toJS` keeps the last), any `Alias` node (Bun resolves
  `<<` merge keys, YAML 1.2 `yaml` does not), a non-map root, or a round-trip mismatch —
  makes the save reject with an error naming the file and the condition. The file is
  untouched and the pending change is retained for retry by the existing `#saveNow`
  catch path. There is no destructive full-regeneration fallback.
- **No new disk read.** The source is the text already read under `withFileLock` from
  `writePath`. `#writeYamlAtomically`'s temp + fsync + `replaceFileAtomically` path is
  unchanged. Paths with no loaded source (new file, quarantined file recovered from
  memory, legacy migration) keep the full-regenerate path.

What is guaranteed: comments, key order, and the value/style of every untouched node.
What is not: byte-for-byte whitespace of untouched nodes on a write that changes
something else (flow-collection padding, `indentSeq`, placement of empty `{}` / `[]`).
Indent width is detected from the source so the common case does not drift.

### Alternatives considered

- **RIG-3728 direction 2: harness-owned state in a separate file.** Rejected in
  RIG-3999: `setupVersion` is one of many keys the harness writes (`composer.shape`,
  model roles, every `/settings` edit); the split would need a second layer and a
  merge order for every one.
- **RIG-3999 option B: switch readers to `yaml`.** Rejected: changes parse semantics
  (duplicate keys, 1.1 booleans under a directive, merge keys) for every config, overlay
  and `ConfigFile` consumer.
- **Text patching.** Rejected: cannot safely handle nested maps, block scalars or
  quoted keys; the CST already exists.
- **Issue `setIn` from `#modified` paths instead of reconciling.** Rejected: duplicates
  the stale-skip and role-merge logic and misses migration-driven deletions
  (`lastChangelogVersion`, `compaction.strategy`), which existing tests require on the
  next save.
- **Destructive fallback with a warning on unpreservable sources.** Rejected in
  RIG-4215: it would remove comments from the git-tracked file this change protects.

## Global Constraints

- `yaml` dependency: `^2.9.1` (registry latest at design time; already resolved in
  `bun.lock` as a transitive of `lint-staged`). Add to the root `catalog` and to
  `packages/utils` `dependencies`; nowhere else.
- Loaded lazily (`await import("yaml")`) inside the writer so no startup path pays for
  it; `@oh-my-pi/pi-utils`' index re-exports `yaml-config.ts`.
- Readers never change: `Bun.YAML.parse` remains the parser on every load path; no
  `yaml` import outside `packages/utils/src/yaml-config.ts`.
- `stringifyYamlConfig` keeps its name, signature and trailing-space strip. It stays the
  new-file serializer and the normalizer. The reconciled output is **not** passed through
  the `/: +$/gm` strip (it would corrupt block scalars whose lines end in `: `);
  `yaml` does not emit Bun's trailing-space artifact.
- `toString` options: `{ lineWidth: 0, indent: <detected, default 2>,
  flowCollectionPadding: false, doubleQuotedMinMultiLineLength: Infinity }`. Every
  changed string containing a newline is double-quoted, including strings inside
  newly inserted maps and sequences; untouched block scalars keep their style.
- Paths are key arrays, never dot-split: legacy flat keys such as
  `"dev.autoqa.consent"` are single map keys.
- Invariant for every write: `Bun.YAML.parse(bytes)` deep-equals
  `Bun.YAML.parse(stringifyYamlConfig(next))`.
- Preserved unchanged: `withFileLock`, `#resolveYamlWritePath` symlink walk,
  `#quarantineInvalidYamlLocked`, `yamlGenerationsMatch` stale-skip logic, per-role merge
  in `#saveNow`, `#projectFileSettings` bookkeeping, `#migrateFromLegacy`,
  `ConfigFile` / keybindings JSON→YAML migrations.
- No new public API on `Settings`. One new export in `@oh-my-pi/pi-utils`
  (`yaml-config.ts`), same module as `stringifyYamlConfig`.
- Tests: red first, then green (`rule://red-green-testing`); assert on parsed objects and
  the specific comment lines, plus one byte-identity assertion for the no-op case.
- CHANGELOG entry under `packages/coding-agent` (user-visible behavior).

## Plan

### Task 1 — `updateYamlConfigSource` in `packages/utils/src/yaml-config.ts`

Add the reconcile serializer beside `stringifyYamlConfig`.

Interfaces:

```ts
// packages/utils/src/yaml-config.ts
export function stringifyYamlConfig(value: unknown): string; // unchanged

export type YamlConfigUpdate =
	| { kind: "unchanged" } // source already parses to `next`; write nothing
	| { kind: "updated"; content: string }
	| { kind: "unpreservable"; reason: string }; // Bun-valid, but yaml cannot edit it safely

/**
 * Re-serialize `source` so it parses to the same object as
 * `stringifyYamlConfig(next)`, keeping comments, key order and scalar styles of
 * every node that did not change.
 */
export async function updateYamlConfigSource(source: string, next: unknown): Promise<YamlConfigUpdate>;
```

Algorithm:

1. `target = Bun.YAML.parse(stringifyYamlConfig(next))`; `base = Bun.YAML.parse(source) ?? {}`.
   `base` not a plain object → `unpreservable("root is not a mapping")`.
   `Bun.deepEquals(base, target)` → `unchanged`.
2. `const { parseDocument, visit, isMap, isSeq, isScalar, Scalar, LineCounter } =
   await import("yaml")`; pass `{ prettyErrors: false, lineCounter: new LineCounter() }`
   to `parseDocument(source, options)`. On `doc.errors`, return `unpreservable`
   with only `error.code` and `lineCounter.linePos(error.pos[0]).line`, never the
   error message, key text, source excerpt or value: config keys and values can be
   sensitive, and errors reach logs and the UI. Any `Alias` found by `visit` →
   `unpreservable("anchors/aliases")`. If `doc.contents` is null or a scalar whose
   value is null, replace it with `doc.createNode({})`; move any scalar comments to
   `doc.commentBefore` before replacement. Keep document-level comments. Any other
   non-map root → `unpreservable`.
3. `reconcile(doc, [], doc.contents, target)`:
   - map: for each pair whose key is not a string → `unpreservable`; whose key is absent
     from `target` → `doc.deleteIn([...path, key])`. For each `[key, value]` of
     `target`: `existing = map.get(key, true)`; both maps → recurse; both sequences →
     recurse; `Bun.deepEquals(existing?.toJSON(), value)` → skip; else set the value.
   - sequence (positional): index `i < min(len)`: both maps → recurse; both sequences
     → recurse; equal → skip; else set the item. Extra source items → `doc.deleteIn`
     from the end; extra target items → set at their index.
   - When changing an existing scalar to a scalar, `doc.setIn(path, value)` updates
     it in place and keeps its comment; set its type to `Scalar.QUOTE_DOUBLE` if the
     new string contains `\n`. For any inserted or replacement map, sequence, or
     scalar, create the node with `doc.createNode(value)`, visit all nested scalars
     and set multiline strings to `Scalar.QUOTE_DOUBLE`, then `doc.setIn(path, node)`.
     Do not assign `.type` to a raw JS string returned by `getIn`.
4. `indent` = width of the first `/^( +)[^\s#]/m` match in `source`, default 2.
   `out = doc.toString({ lineWidth: 0, indent, flowCollectionPadding: false,
   doubleQuotedMinMultiLineLength: Infinity })`. Re-parse with Bun;
   `!Bun.deepEquals(Bun.YAML.parse(out), target)` → `unpreservable("round-trip
   mismatch")`. Return `updated(out)`.

Tests (`packages/utils/test/yaml-config.test.ts`, new; red first):

- keeps a file-top comment, a comment above a key, an inline comment after a value, a
  comment inside a list, and a comment above a nested key when one unrelated leaf
  changes;
- updates a scalar in place and keeps that pair's own inline comment;
- adds a nested key under an existing commented map without touching siblings;
- deletes a key absent from `next` and a flat legacy key (`"dev.autoqa.consent"`);
- replaces a map-valued key by a scalar and the reverse (`setIn` at the parent, no throw);
- per-role: changing `modelRoles.default` keeps the comment on `modelRoles.advisor`;
  removing one role keeps the others' comments;
- sequence: changing one item keeps the comments on the others; shortening drops the
  tail; lengthening appends; changing an item inside a nested sequence keeps comments
  on its unchanged sibling items;
- a changed write to a source whose first line is a top-level key or comment and
  whose nested keys use 4-space indent retains that indent width;
- `unchanged` when `next` equals the parsed source even though the source uses 4-space
  indent and `[a, b]` flow style;
- `unpreservable` on duplicate top-level keys (reason gives code and line, never
  key or either seeded secret value) and on an alias;
- comment-only and empty sources, including `---` with comments and a null scalar
  with an inline comment, gain keys and keep the comments;
- multiline strings changed in place, added as a key, and nested inside an added map
  round-trip without a match for the trailing-space strip;
- an `undefined`-valued key in `next` is absent from the output.

Dependency: `yaml` added to `packages/utils/package.json` and the root catalog.

### Task 2 — Route `#saveNow` / `#saveProjectNow` through the source text

Interfaces (private, `packages/coding-agent/src/config/settings.ts`):

```ts
// before
async #writeYamlAtomically(filePath: string, settings: RawSettings): Promise<void>
// after
async #writeYamlAtomically(filePath: string, settings: RawSettings, baseSource?: string): Promise<void>
```

Body, before the temp file is opened:

```ts
let content: string;
if (baseSource === undefined) {
	content = stringifyYamlConfig(settings);
} else {
	const update = await updateYamlConfigSource(baseSource, settings);
	if (update.kind === "unchanged") return;
	if (update.kind === "unpreservable") {
		throw new Error(
			`Settings config cannot be updated in place: ${filePath}: ${update.reason}; ` +
				"fix the file or move it aside (the pending change is kept for retry)",
		);
	}
	content = update.content;
}
```

Temp file (`wx`, 0o600), fsync, `replaceFileAtomically`: unchanged.

Call sites:

- `#saveNow`: `await this.#writeYamlAtomically(writePath, this.#global, yamlSourceForWrite(loaded))`.
- `#saveProjectNow`: same with `projectSettings`.
- `#migrateFromLegacy`: unchanged (no `baseSource`).

Helper (module-private, beside `yamlGenerationsMatch`):

```ts
function yamlSourceForWrite(loaded: LockedYamlLoadResult): string | undefined
// loaded.generation.source when loaded.settings !== null && loaded.generation.kind ===
// "content"; undefined otherwise (missing file, quarantined file recovered from memory).
```

Tests (`packages/coding-agent/test/settings-manager.test.ts`; red first). Fixture
`COMMENTED_CONFIG` (hand-written string, pre-migration):

```yaml
# file-top comment
setupVersion: 1 # inline after value

# above key
compaction:
  strategy: handoff
  remoteEnabled: false

modelRoles:
  # above nested key
  default: anthropic/claude-opus-4 # pinned on purpose
  advisor: moonshot/kimi-k2

custom:
  tags:
    # inside a list
    - alpha # first item
    - beta

dev:
  autoqa:
    consent: unset
```

- "setupVersion migration keeps every comment and lands the four key changes": seed
  the fixture; `Settings.init`; `set("composer.shape", "band")`;
  `markSetupWizardComplete(settings, 2)` (sets `setupVersion` and flushes). Assert all
  seven comment lines are present verbatim; parsed file has `setupVersion: 2`,
  `dev.autoqaConsent: "unset"` with no `dev.autoqa`, `compaction.methodOrder:
  ["handoff", "soft"]` with no `strategy` / `remoteEnabled`, `composer.shape: "band"`;
  `custom.tags` and `modelRoles` unchanged.
- "a second migration is a byte-identical no-op": continue from the previous state;
  fresh `Settings.init`; `markSetupWizardComplete(settings, 2)`; file bytes equal the
  post-first-write bytes.
- "keeps per-role comments when one global model role changes": `setModelRole("default",
  …)` on the fixture; both role comments survive.
- "keeps project config comments when a project role is set": same shape on
  `.omp/config.yml` via `setProjectModelRole`.
- "rejects a duplicate-key config without touching it and retains the pending change":
  seed a file with duplicate `searxng.token` keys containing distinct fake secrets;
  `set(...)`; `flush()` rejects with the error code and line but neither secret nor
  credential key; bytes unchanged; no `.broken-` backup; `get` still returns the new value.

Atomicity: unchanged mechanism (temp file + fsync + rename), content computed before
the temp file opens; existing write-failure tests cover it. Existing tests that must
stay green without edits: quarantine (`.broken-`), dangling-symlink chain,
concurrent-external-edit merges, stale-skip, "writes mapping headers without trailing
whitespace and preserves multiline values", "moves legacy lastChangelogVersion …".

### Task 3 — CHANGELOG

- `packages/coding-agent/CHANGELOG.md` under `[Unreleased]` / `Changed`: "Settings saves
  now preserve comments and key order in `config.yml`, and the values and styles of
  untouched nodes. Whitespace can normalize when another value changes. A config
  `yaml` cannot edit safely (duplicate keys, anchors) rejects the save with an
  actionable error instead of being rewritten."

## Tasks

- [ ] T1 `updateYamlConfigSource` + `YamlConfigUpdate`, unit tests red→green; `yaml`
      dep added (catalog + `packages/utils`).
- [ ] T2 `#writeYamlAtomically(…, baseSource?)`, `yamlSourceForWrite`, both save paths
      wired; settings-manager tests red→green; existing write-path tests untouched and
      green.
- [ ] T3 CHANGELOG line.

## Resolved decisions

### RIG-3999 — write path (DL-519)

Matt chose option A: write through `yaml` `parseDocument` with surgical `setIn` /
`deleteIn`. Readers keep their current parser.

### RIG-4215 — unpreservable source (DL-520)

Matt chose option A: fail closed. A config Bun loads but `yaml` cannot edit safely
(duplicate keys, anchors/aliases, round-trip mismatch) rejects the save with the file
path and condition. The file stays untouched; the existing catch path retains the
pending change for retry. A user with duplicate keys must repair the file before
`setupVersion` can persist.

## Open Questions

### OQ2 (non-load-bearing) — formatting drift on untouched nodes

A write that changes something can renormalize whitespace of untouched nodes
(`indentSeq`, flow padding, empty `{}` placement). Comments and values are unaffected;
the no-op path returns the original bytes. Deferred: detect `indentSeq` / padding
from the source if a real file shows an unwanted diff.

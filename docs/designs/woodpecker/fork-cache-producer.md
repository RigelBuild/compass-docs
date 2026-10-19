# Stage fork releases for the cache signer (RIG-5698)

This record lives under woodpecker, the fork lane's surface, and covers all
four forks: woodpecker, oh-my-pi, jj-vine and nix2container.

## Open Questions

The questions are independent. The design assumes each recommendation.

1. **Where the producer code lives (Matt).**
   - (a) A copy in each fork. A fix is four PRs that each review code.
   - (b) A reusable workflow in one fork. The signer matches
     `job_workflow_ref`, which carries the called ref, against a `callee`, so
     every SHA bump also changes the trust policy.
   - (c) A new public repo, `RigelBuild/nix-cache-producer`, with composite
     actions pinned by SHA. These run in the caller's job, so
     `job_workflow_ref` stays the fork's workflow and the drafted trust
     entries need no `callee`. A fix is one producer PR plus four SHA-bump
     PRs. Its minter makes a ninth holder of the automation App key.
   - **Recommendation: (c),** with a fork-owned pin check (§ Where it runs).
     Under (a), T1 is dropped and T2–T5 are copied into each fork.
2. **Upload path for large NARs (Matt; the signer owner, RIG-5407).** The
   `rigel.build` zone is on Cloudflare Pro: a proxied body over 100 MB gets
   413
   ([Cloudflare](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)),
   and the origin must answer within about 100 seconds
   ([Cloudflare](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)).
   The omp NAR is about 251 MB.
   The signer sits behind a Cloudflare Tunnel, and a tunnel hostname must be
   proxied, so a DNS-only host needs a new public LoadBalancer, a certificate
   in the pod, and no WAF in front of the upload routes.
   - (A) The whole signer host is DNS-only, on that LoadBalancer.
   - (B) Chunked PUTs of 64 MiB parts, assembled in the signer's spool file.
     `narHash` is still checked over the whole NAR.
   - (C) The attestation call returns presigned R2 PUT URLs. It removes the
     size, deadline and slot limits, but reopens RIG-5699's rejected
     temporary-credential option.
   - (D) A second DNS-only host for the staging routes only, with A's costs.
   - **Recommendation: (B).** It keeps the tunnel and WAF, and the signer
     owner agrees. Until it lands, no fork with a NAR over 100 MB is enabled.
3. **A non-reproducible rerun blocks a release (the signer owner; Matt if the
   gate rule changes).** A rerun that rebuilds differently stores a second
   attestation for the system, and the publisher rejects the release forever.
   - (A) The publisher ignores attestations whose staging never completed.
   - (B) Recovery is a new `-rigel.N+1` release.
   - (C) The producer withdraws its uncompleted attestation by `DELETE`.
   - (D) A rerun uploads the first run's saved closure. Heavy for omp.
   - **Recommendation: (A)**, with (B) until it lands.
4. **Substituting from Rigel's public cache (Matt).** A release rebuilds
   unchanged paths that Rigel already published. A rebuild that is not
   bit-identical conflicts with the published narHash, and the gate
   quarantines the path and fails every bump containing it.
   - (A) Also substitute from Rigel's public cache, with its key. Unchanged
     paths come back as the bytes the signer signed.
   - (B) Use cache.nixos.org only, and have T5 build each fork twice and
     compare narHashes before enable.
   - **Recommendation: (A).** The producer trusts nothing beyond
     cache.nixos.org and the signer's own output.

## Decisions

Matt ruled on RIG-5699 (2026-10-18). D1 and D2 record the ruling.

- **D1** (DL-583) — A fork stages its closure through the signer's
  OIDC-authenticated upload endpoint. It holds no signing key, no bucket
  credential and no other long-lived cache secret.
- **D2** (DL-584) — The digest test is split. The producer tests golden
  vectors copied from the signer. A signer-side gate test on a fork-shaped
  fixture catches drift.

## Problem / Intent

The cache signer publishes a fork release only after the fork has attested it
and staged its full closure (parent RIG-4790). Nothing produces either today:
each fork's `release-tag.yaml` mints a `vX.Y.Z-rigel.N` tag on a push to
`rigel-release` and stops. The producer builds the manifest roots per system,
attests their runtime closure, and stages it unsigned through the signer. The
signer publishes when the consumer's bump PR moves the fork's pin.

## Approach

### Where it runs

The signer accepts a staging token only for `event_name` `push`, `ref`
`refs/heads/rigel-release`, and `workflow_ref` and `job_workflow_ref` naming
the fork's `release-tag.yaml` on that branch. So the producer runs in that
workflow, after `mint`, which is unchanged:

1. `resolve` needs `mint` and runs only on `push`. A fork-owned first step
   reads the workflow at `github.sha`, requires one producer SHA across the
   producer `uses:`, and requires it on the producer's `main`. The action then
   outputs the one `vX.Y.Z-rigel.N` remote tag at `github.sha`, or nothing.
   Two such tags fail.
2. `stage` needs `resolve`, runs only on its tag, and has one matrix leg per
   system, with `fail-fast: false` and `timeout-minutes: 180`.

`resolve` reads the remote because no mint script writes an output, and
"already exists; nothing to mint" never checks the tag's target. A push that
keeps the version has no tag at `github.sha`, so nothing is staged. Every fork
merges into `rigel-release` only by merge commit or squash, so the tag the
mint scripts place lands on `github.sha`, which the signer requires.

`stage` has exactly `contents: read` and `id-token: write`. Neither job has an
`environment`, which keeps the App key out and fixes the token's `sub`. The
signer stores `sub` with each attestation and answers 409 to a repeat under
another `sub`, so adding an environment later breaks reruns. Standard
GitHub-hosted runners are free for public repositories
([GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

| Fork | x86_64-linux (`ubuntu-24.04`) | aarch64-linux (`ubuntu-24.04-arm`) | aarch64-darwin (`macos-15`) |
| --- | --- | --- | --- |
| woodpecker | `woodpecker-agent` | `woodpecker-server`, `woodpecker-agent` | `woodpecker-agent` |
| oh-my-pi | `omp` | — | `omp` |
| jj-vine | `jj-vine` | — | `jj-vine` |
| nix2container | `nix2container-bin`, `skopeo-nix2container` | `nix2container-bin`, `skopeo-nix2container` | — |

Each name is the root `packages.<system>.<name>`: nine legs, one attestation
each. The expected outPaths, evaluated at the revs consumers lock on
2026-10-19, are T5's acceptance fixture:

| Fork rev | Root | outPath |
| --- | --- | --- |
| woodpecker `dfc97d50662e08a37798ff80d77434c761065694` | `aarch64-linux.woodpecker-server` | `/nix/store/advdr1xdz9g795f11r2gjs0h442jpq82-woodpecker-server-3.17.0-rigel.14` |
| | `aarch64-linux.woodpecker-agent` | `/nix/store/cjfprja0a1yjhhnkmisvqsj1rqn9ihf5-woodpecker-agent-3.17.0-rigel.14` |
| | `x86_64-linux.woodpecker-agent` | `/nix/store/aij1xq4s5jq1c93rcd861khd4rgl3ckz-woodpecker-agent-3.17.0-rigel.14` |
| | `aarch64-darwin.woodpecker-agent` | `/nix/store/3w33nnmxx9dccli9nz1cg0i68pnpvjp2-woodpecker-agent-3.17.0-rigel.14` |
| oh-my-pi `4e506a0cf0639874ca75464f70c26e58acdeb237` | `x86_64-linux.omp` | `/nix/store/nvwzlbncf4rnas0vbd5v598r6h6vqs7n-omp-18.9.2-rigel.1` |
| | `aarch64-darwin.omp` | `/nix/store/qnvb58k2zzd282a8afrygp1ldm5j1s7w-omp-18.9.2-rigel.1` |
| jj-vine `6a8b21b5ddb0f84e4a83a9993b9d3446fb500456` | `x86_64-linux.jj-vine` | `/nix/store/8m6jdb2qh14g280f7rrjwmmr87a6hq2z-jj-vine-0.5.4-rigel.1` |
| | `aarch64-darwin.jj-vine` | `/nix/store/xmhb78w1m5wzgyfdl4m639rvr4jspkw5-jj-vine-0.5.4-rigel.1` |
| nix2container `7663114b3c271f6119478fb7cfe79c42347d29ae` | `x86_64-linux.nix2container-bin` | `/nix/store/f1blj11ghlkf32mczynhbl21jamcxs77-nix2container-1.0.0` |
| | `x86_64-linux.skopeo-nix2container` | `/nix/store/8pq413af13q376xkjib2kkf1vl26zgmd-skopeo-1.21.0` |
| | `aarch64-linux.nix2container-bin` | `/nix/store/xp3qffdck2gz17c91q3i098dyr280xbw-nix2container-1.0.0` |
| | `aarch64-linux.skopeo-nix2container` | `/nix/store/rjjr630yy6xvqis8lay3p2jwry82bm7s-skopeo-1.21.0` |

### Build and capture

- **Source.** `github:<repo>/<sha>`, the fetcher type consumers lock. A
  checkout can change the source path and `sourceInfo`, and so the outPaths.
- **Nix settings.** The installer's `extra_nix_config` sets
  `accept-flake-config = false` and the substituters of Open Question 4, and
  the leg asserts them with `nix config show`. No third-party cache's bytes
  are republished.
- **Build.** `nix build --no-link --json`, after checking
  `builtins.currentSystem`. A root's `outPath` is its `out` output.
- **Closure.** `nix path-info --recursive --json --json-format 2` over the
  roots (Nix 2.33 and later). The producer joins basenames with `storeDir`,
  converts SRI to `sha256:<nix32>`, and keeps self-references. The result is
  exactly the paths the signer walks from the roots.
- **NAR.** `nix-store --dump` streams into the body, with `Content-Length`
  set to `narSize`. A 600 MiB upload measured about 28 MiB peak RSS.

### Signer calls

Only `POST /v1/attestations` exists today. Everything else below is
**proposed, owned by the signer (RIG-5407)**. The signer owner publishes the
contract: route schemas and statuses, idempotency, token checks, NAR
streaming limits and deadlines, and signer-side acceptance tests. § Rollout
waits for it to be deployed.

Each call carries a fresh OIDC token. Before the first call, the leg decodes
its token and checks `repository`, `sha`, `workflow_ref`, `job_workflow_ref`,
`event_name` and `ref` against its release context, naming any mismatch.

| Step | Call | Notes |
| --- | --- | --- |
| 1 | `POST /v1/attestations` | The attestation with its local `digest`. The returned digest must equal it. |
| 2 | `PUT /v1/staging/<digest>/nar/<nix32>.nar` | Once per distinct key, two in flight per leg. The signer writes the narinfos itself. |
| 3 | `POST /v1/staging/<digest>/complete` | Empty body. |

| Answer | Action |
| --- | --- |
| 200, 201 | Success. |
| 429, any 5xx, or a transport error | Retry in process: wait `Retry-After` if given, else back off from 1 s, doubling to 60 s. |
| Any other 4xx | Fail the leg. |

Every call is idempotent, so a retry, which reuses the leg's build and
digest, is safer than a rerun. Retries stop after 30 minutes per call and 90
per leg. A PUT's deadline is the signer's read deadline (2 minutes plus 1
second per MiB, capped at 30 minutes) plus 60 seconds. Two PUTs per leg,
because legs share the signer's four body slots, and a busy answer mid-body
can arrive as a reset. Also assumed: the PUT route extends its write deadline
with its read deadline, and checks the token only at the headers.

Recovery is "Re-run failed jobs", within 30 days; never rerun a completed
leg. A release with no attestation posts no status on the consumer's bump PR,
so the signer owner is asked to post a failure status in that case.

### Canonical digest

The digest is the lowercase hex SHA-256 of one UTF-8 JSON text. The interface
between producer and signer is the golden vectors.

- **Normalize.** Each `narHash` becomes `sha256:<nix32>`, with the alphabet
  `0123456789abcdfghijklmnpqrsvwxyz`. A missing `references` becomes `[]`.
  Sort each `references` list, the `closure` by `storePath`, and the `roots`
  by `attr`, all by UTF-16 code units (JavaScript's default string order).
- **Exclude** `digest`.
- **Key order.** Top level: `closure, event, observedTip, ref, releaseRef,
  releaseSha, repo, roots, system, tag, tagTarget, workflow`. Closure entry:
  `narHash, narSize, references, storePath`. Root: `attr, outPath`.
- **Encode** with `JSON.stringify` and no whitespace. `"` and `\` are escaped,
  `\b \f \n \r \t` use short forms, other characters below U+0020 become
  lowercase `\u00xx`, and everything else is raw, including `<`, `>`, `&`,
  U+2028 and U+2029. Invalid UTF-8 becomes U+FFFD.

| Vector | Digest |
| --- | --- |
| main | `56e8daaddc90e26fc78ff78eed931d21efee4be787beaea5ff395d328ce76a61` |
| empty | `8224f1853e23597c289636641f6c51cb08893e128ae7e79013ab1272aac6b584` |
| unicode and control escapes | `8e8c175aa796d4a5d28334e6383db9c34e5dcee6f1e783731910c797604a37a3` |
| UTF-16 order | `bfeff84fa061297c07306505a701bddc0d0a159ca178e287a31deef3939292f9` |
| fork (woodpecker aarch64-linux) | pending |

The four listed digests reproduce, with these rules, from the signer's tests
today. They live in `test/vectors/attestation-digest.json`. The fork vector is
pending: it comes from the signer-side fixture test (D2), and T5 copies it
once that test is on the signer's `main`. It tests the encoding, not the
binding. To change the encoding, the signer owner posts new vectors, the
producer releases, and forks move pins.

### Code and runtime

Bun TypeScript with no runtime dependencies, run from source, as three
composite actions: `resolve`, `stage` and `check`. Bun is the house script
language, oh-my-pi runs it, and `JSON.stringify` gives the canonical escaping.
Go would need a hand-written encoder, and the signer's is not public.

### Tests

Each fork's `check` job runs the `check` action on every PR to
`rigel-release`. It recomputes the vectors and checks the job shape. This
catches mistakes; the fork-owned pin step is the trust control. Each `stage`
leg also recomputes the vectors before its first call.

The producer's `bun test` covers each module, with the signer client against
a `Bun.serve` fake. The dry run builds, captures and digests, checks every NAR
against path-info, fails if a root has an output besides `out`, and never
mints a token. A `workflow_dispatch` workflow runs it on the real runners.

### Rollout

Fork PRs open now as drafts on `rigel-release` and stay draft until:

- the signer's staging contract (§ Signer calls) is deployed (RIG-5407),
  with its staging host and audience posted;
- the policy file lists the fork (RIG-5274);
- the signer's capacity proof has passed;
- for jj-vine and nix2container, the consuming flake uses the fork's outputs;
- Open Question 2 is settled, if the fork has a NAR over 100 MB.

Merging is the enable step. The PR also bumps the version, so its merge cuts
the first staged release. Earlier releases, such as woodpecker's
`v3.17.0-rigel.14`, are never staged: a dispatch token fails the `push`
claim.

Order: jj-vine (small, Linux and macOS), nix2container, woodpecker, oh-my-pi
(waits on Open Question 2). If T5 finds a jj-vine NAR over 100 MB,
nix2container goes first.

### Rejected

- **Tag-push trigger.** Wrong `event_name` and `ref`.
- **A separate producer workflow.** The trust policy names
  `release-tag.yaml`.
- **Mint scripts writing outputs.** Four changes, and "already exists" still
  skips the target.
- **A pin check inside the action.** Pinned code would vouch for itself.

## Global Constraints

- `RigelBuild/nix-cache-producer`, branch `main`: strict TypeScript, no
  `any`, no runtime dependencies.
- Nix:
  `cachix/install-nix-action@448cde739abec1eaf0646249e3d25bb8d9bc7702 # v31.11.2`
  (Nix 2.35.3; 2.33+ required). Bun:
  `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`,
  `bun-version: 1.4.2`.
- Every `uses:` in `release-tag.yaml` is a 40-hex SHA with a `# vX.Y.Z`
  trailer, as the woodpecker and jj-vine contract tests require.
- Permissions, `environment` and runners as in § Where it runs.
- Signer URL, audience, cache URL and cache key are inputs with no defaults.
- Public repos name no private path, source or PR.

## Plan

T1 creates the repo. T2–T4 are independent modules. T5 wires the actions,
runs the dry runs and cuts `v0.1.0`. T6–T9 follow T5. Tests come first.

### T1. Producer repo

One IaC PR, owned by the fork lane: the public repo with Actions on, a `main`
ruleset requiring review and the `test` check, a `refs/tags/v*` tag ruleset,
and the release minter on `main`. The IaC test pinning the App key's holders
goes from eight to nine. After apply, push the README-only root commit.

### T2. Canonical digest

Files: `package.json`, `tsconfig.json`, `.github/workflows/test.yaml` (job
`test`), `src/attestation.ts`, `src/nix32.ts`, `src/digest.ts`,
`test/vectors/attestation-digest.json`, `test/digest.test.ts`,
`test/nix32.test.ts`.

Interfaces:

```ts
// src/attestation.ts
export interface RootClaim { attr: string; outPath: string }
export interface PathInfo {
  storePath: string;
  narHash: string;      // sha256:<nix32> once normalized
  narSize: number;
  references: string[]; // full store paths
}
export interface Attestation {
  repo: string; tag: string; releaseRef: string; observedTip: string;
  tagTarget: string; releaseSha: string; workflow: string; event: string;
  ref: string; system: string; roots: RootClaim[]; closure: PathInfo[];
  digest?: string;
}

// src/nix32.ts
export function toNix32(bytes: Uint8Array): string;
// Accepts SRI, sha256:<hex> and sha256:<nix32>; throws on anything else.
export function normalizeNarHash(narHash: string): string;

// src/digest.ts
export function canonicalJson(attestation: Attestation): string;
export function canonicalDigest(attestation: Attestation): string; // lowercase hex
export function checkVectors(): void; // throws, naming the first failing vector
```

```json
{
  "copiedFrom": "the signer's digest tests, 2026-10-18",
  "vectors": [{ "name": "main", "attestation": {}, "digest": "56e8…6a61" }]
}
```

Tests: the four signer vectors, and the fork vector once copied (T5); SRI,
hex and nix32 spellings normalize alike; input order and a present `digest`
do not change the digest.

### T3. Build and capture

Files: `src/nix.ts`, `test/nix.test.ts`, `test/fixtures/path-info-v2.json`,
`test/fixtures/flake/flake.nix`.

Interfaces:

```ts
// src/nix.ts
export async function currentSystem(): Promise<string>;
// Fails unless `nix config show` has the expected settings.
export async function checkNixConfig(substituters: string[]): Promise<void>;
// nix build --no-link --json; each attr with its out output.
export async function buildRoots(flakeRef: string, attrs: string[]): Promise<RootClaim[]>;
// Every output name of each attr, for the dry run's out-only check.
export async function rootOutputs(flakeRef: string, attrs: string[]): Promise<Record<string, string[]>>;
// Throws unless version is 2; joins basenames with storeDir; normalizes narHash.
export function parsePathInfoV2(json: unknown): PathInfo[];
export async function closureOf(outPaths: string[]): Promise<PathInfo[]>;
export function narKey(info: PathInfo): string; // "nar/<nix32>.nar"
// nix-store --dump; done rejects on a non-zero exit.
export interface NarStream { body: ReadableStream<Uint8Array>; done: Promise<void> }
export function dumpNar(storePath: string): NarStream;
```

Tests: `parsePathInfoV2` on a recorded fixture keeps self-references, joins
`storeDir`, converts SRI, and rejects version 1. In CI, a two-derivation
fixture flake with no nixpkgs is built and captured, and each NAR's SHA-256 and
size match path-info.

### T4. Signer client

Files: `src/oidc.ts`, `src/signer.ts`, `test/fake-signer.ts`,
`test/signer.test.ts`.

Interfaces:

```ts
// src/oidc.ts: one token per call from ACTIONS_ID_TOKEN_REQUEST_URL and _TOKEN.
export async function mintToken(audience: string): Promise<string>;
// The payload's string claims; the signer checks the signature.
export function tokenClaims(token: string): Record<string, string>;

// src/signer.ts
export interface SignerConfig {
  url: string;
  audience: string;
  token: (audience: string) => Promise<string>;
  perCallMs: number; // 30 min
  perLegMs: number;  // 90 min, shared by every call in the leg
}
// Retry-After when given, else 1 s doubling to 60 s.
export function backoffMs(attempt: number, retryAfter: string | null): number;
// min(120 s + 1 s per MiB of narSize, 30 min) + 60 s.
export function putDeadlineMs(narSize: number): number;
// Returns the signer's digest; throws if it differs from attestation.digest.
export async function postAttestation(cfg: SignerConfig, attestation: Attestation): Promise<string>;
// open() starts a fresh dump per attempt; the PUT fails if done rejects.
export async function putNar(cfg: SignerConfig, digest: string, info: PathInfo,
  open: () => NarStream): Promise<void>;
// Distinct keys, `concurrency` (default 2) in flight; the first failure aborts the rest.
export async function uploadAll(cfg: SignerConfig, digest: string, closure: PathInfo[],
  open: (info: PathInfo) => NarStream, concurrency?: number): Promise<void>;
export async function complete(cfg: SignerConfig, digest: string): Promise<void>;
```

Each request sets `AbortSignal.timeout` and `timeout: false`, because Bun's
`timeout` is an idle timer, not a deadline. When the signer's contract lands,
the fake is updated to it before T6.

Tests, against a `Bun.serve` fake: 201, then 200 on a repeat; 503 with
`Retry-After: 1`, then 201; 500 and a dropped connection, then 201; 400 and
404 fail with no retry; the per-call and per-leg budgets end retries; at most
two PUTs in flight; a new token per request; `Content-Length` equals
`narSize`; the deadline at 0, 1 MiB and 2 GiB.

### T5. Actions, dry run and first release

Files: `src/release.ts`, `src/workflow-check.ts`, `src/main.ts`, their tests,
`resolve/action.yml`, `stage/action.yml`, `check/action.yml`,
`.github/workflows/dry-run.yaml`, `.github/workflows/release-tag.yaml`,
`scripts/release-tag.ts`, `VERSION`.

Interfaces:

```ts
// src/release.ts
export interface ReleaseContext {
  repo: string; sha: string; tag: string; workflow: string; event: string; ref: string;
}
// Throws unless event is push, ref is refs/heads/rigel-release, and workflow is
// <repo>/.github/workflows/release-tag.yaml@refs/heads/rigel-release.
export function releaseContext(env: Record<string, string | undefined>, tag: string): ReleaseContext;
// Throws naming the first of repository, sha, workflow_ref, job_workflow_ref,
// event_name, ref that differs from ctx.
export function checkClaims(claims: Record<string, string>, ctx: ReleaseContext): void;
// observedTip, tagTarget and releaseSha are ctx.sha; releaseRef is ctx.ref; sets digest.
export function buildAttestation(ctx: ReleaseContext, system: string,
  roots: RootClaim[], closure: PathInfo[]): Attestation;
// git ls-remote --tags output; one vX.Y.Z-rigel.N tag at sha, or null; two throw.
export function tagAt(lsRemote: string, sha: string): string | null;

// src/workflow-check.ts: one message per broken rule; empty means pass.
export function checkReleaseWorkflow(yaml: string): string[];
```

```text
bun src/main.ts resolve
bun src/main.ts stage --system S --roots 'A B' --tag T --signer-url U --audience A \
  --cache-url C --cache-key K
bun src/main.ts stage --dry-run --repo R --sha SHA --system S --roots 'A B'
bun src/main.ts check --workflow .github/workflows/release-tag.yaml
```

`resolve` writes `tag=` to `GITHUB_OUTPUT`. The `stage` action installs Bun
and Nix, then runs one leg. `dry-run.yaml` writes the digest, root outPaths
and largest NARs to the job summary. `release-tag.yaml` mints `v<VERSION>` on
a push to `main` that changes `VERSION`.

A fork's new jobs (woodpecker's aarch64-linux leg shown):

```yaml
  resolve:
    needs: mint
    if: github.event_name == 'push'
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    outputs:
      tag: ${{ steps.resolve.outputs.tag }}
    steps:
      - name: Require producer pin on main
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh api "repos/$GITHUB_REPOSITORY/contents/.github/workflows/release-tag.yaml?ref=$GITHUB_SHA" \
            -H 'Accept: application/vnd.github.raw' > release-tag.yaml
          pin="$(grep -oE 'nix-cache-producer/[a-z]+@[0-9a-f]{40}' release-tag.yaml | cut -d@ -f2 | sort -u)"
          [ -n "$pin" ] && [ "$(printf '%s\n' "$pin" | wc -l)" -eq 1 ] || { echo '::error::expected one producer SHA' >&2; exit 1; }
          status="$(gh api "repos/RigelBuild/nix-cache-producer/compare/main...$pin" --jq .status)"
          case "$status" in identical|behind) ;; *) echo "::error::producer pin $pin is not on main ($status)" >&2; exit 1 ;; esac
      - id: resolve
        uses: RigelBuild/nix-cache-producer/resolve@<T5 sha> # v0.1.0

  stage:
    needs: resolve
    if: needs.resolve.outputs.tag != ''
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 180
    permissions:
      contents: read
      id-token: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - system: aarch64-linux
            runner: ubuntu-24.04-arm
            roots: packages.aarch64-linux.woodpecker-server packages.aarch64-linux.woodpecker-agent
    steps:
      - uses: RigelBuild/nix-cache-producer/stage@<T5 sha> # v0.1.0
        with:
          system: ${{ matrix.system }}
          roots: ${{ matrix.roots }}
          tag: ${{ needs.resolve.outputs.tag }}
          signer-url: <posted staging host>
          audience: <posted audience>
          cache-url: <Rigel public cache URL>
          cache-key: <Rigel public cache key>
```

Done when:

- the signer-side fork fixture test is on the signer's `main`, and the fork
  vector is copied from there;
- `bun test` passes in the producer's CI;
- the nine dry runs pass at the fixture revs in § Where it runs, and every
  root outPath equals the fixture;
- each fork's largest NAR is posted on RIG-5698;
- `v0.1.0` is minted.

### T6–T9. Fork PRs

One draft PR per fork on `rigel-release`: T6 jj-vine, T7 nix2container, T8
woodpecker, T9 oh-my-pi. Each PR adds `resolve` and `stage` with the fork's
rows, and adds the `check` action to the `check` job. It keeps the fork's
script tests green. In oh-my-pi, it also adds `release-tag.yaml` to the
`pull_request` paths, so `check` runs on a workflow change, and pins the two
`actions/checkout@v4` steps. Done when the fork's CI passes and the draft
links RIG-5698.

## Tasks

- [ ] Post the two signer assumptions, the missing-attestation status ask,
      and Open Questions 2 and 3 to the signer owner on RIG-5407.
- [ ] Signer owner: publish the staging contract and its acceptance tests;
      align T4's fake with it.
- [ ] File Open Questions 1 and 4 for Matt.
- [ ] T1: IaC PR, apply, root commit.
- [ ] T2: vector tests first; see them fail; then nix32 and the digest.
- [ ] T3: fixture tests first; then `src/nix.ts`.
- [ ] T4: fake-signer tests first; then the client.
- [ ] T5: CLI, actions and workflows; fork vector; nine dry runs against the
      outPath fixture; largest NARs on RIG-5698; mint `v0.1.0`.
- [ ] T6–T9: four draft PRs pinned to `v0.1.0`.
- [ ] Per fork, once § Rollout holds: set the posted values, bump the version,
      promote and merge. The release's legs pass, and its consumer bump PR
      passes the signer gate.

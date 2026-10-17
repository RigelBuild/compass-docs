# Reconcile the shared Nix toolchain builder (RIG-4540)

## Problem / Intent

The shared-tools record asks whether the public Nix builder should be shared.
This record keeps the public builder change separate from consumer-specific
configuration.
> Redacted 2026-10-17: private consumer builder comparison, file inventory, pins, and build-output measurements removed from the public record.

## Inventory

### Files that look shared but stay local

The Compass files below remain local because they serve Compass-specific builds
and environments.

| Compass path | Why it stays local |
| --- | --- |
| `tools/toolchain/gate-tools.nix`, `tools/toolchain/go-analysis.nix` | Compass parity-gate plumbing. |
| `tools/toolchain/chromium-e2e-env.nix`, `gtk-e2e-env.nix`, `gtk-closure.nix`, `secretspec-env.nix`, `skopeo-nix2container-env.nix`, `microvm-vmm-env.nix` | Compass test and image environments. |
| `tools/renovate/agent-image-fod-vehicle.nix`, `tools/renovate/ui-fod-vehicle.nix` | Compass FOD hash vehicles. |
| `devenv.nix`, `agent-image/devenv.nix`, `flake.nix`, `agent-image/entrypoint.nix`, `apps/ui/dist.nix`, `guest-image/default.nix`, `guest-image/assembly-tests.nix` | Compass shells, images, and builds. |

> Redacted 2026-10-17: private consumer file inventory and builder-call-site details removed from the public record.

## Approach

Each consumer keeps its own copy of the builder. Two changes do it:

- **R1, Compass:** the builder's four `stdenv.isLinux` tests become
  `stdenv.hostPlatform.isLinux`. The change does not alter derivation outputs.
- **R2, another consumer:** adopt the public builder with consumer-specific
  configuration.
> Redacted 2026-10-17: private consumer implementation diff, CI image, Renovate and pin configuration, and measured parity details removed from the public record.

The public change lands first, so the consumer can adopt the updated builder.

### Accepted risk: two copies

There is no shared source and no drift check, so the copies can drift again.
Downloaded release pins do not prevent changes to builder logic from drifting.
The public change is measured against equal inputs to keep its derivation
outputs stable.
> Redacted 2026-10-17: private consumer drift measurements and implementation-level builder comparison removed from the public record.

## Not reconciled

- **Pin versions.** Each consumer maintains its own version pins.
- **Local-path comments.** These remain specific to each repository.
- **The toolchain hash-refresh script.** This TypeScript utility is outside the
  Nix builder change; moving shared upgrade scripts is handled separately.
> Redacted 2026-10-17: private consumer pin versions, update cadence, local path references, and private script diff details removed from the public record.

## Alternatives considered

- **Ship the builder as a shared flake output.** Declined by Matt (RIG-4548):
  a shared release lane would add maintenance without enough benefit for the
  narrow public change.
- **Share the pins too.** Rejected: each consumer owns its pin updates, and
  versions can differ.
- **Keep both copies and add a drift check.** Rejected by the parent record.
- **Adopt another consumer's builder in Compass.** Rejected because it would
  couple the public derivation to consumer-specific assumptions.
> Redacted 2026-10-17: private file comparison, exact drift measurements, private paths, and pin coupling details removed from the public record.

## Global Constraints

- Compass is public. Consumer-side changes are described by role only, with no
  private path, host, or repo name.
- R1 changes no Compass derivation. Check it with the equal-input `drvPath`
  method from the Inventory on all three systems.
- R2 does not alter the public pin files.
- No new shared code, flake input, Renovate rule, or ledger row. The PR
  carries `Ledger-impact: none`.

## Plan

Order: R1, then R2. R2 uses the public builder after R1.

### R1 — Compass: one `isLinux` spelling

Lands in: compass. `tools/toolchain/toolchain-tools.nix` only.

Change: the four `lib.optionals stdenv.isLinux` tests (two in `bun`, two in
`node`) become `lib.optionals stdenv.hostPlatform.isLinux`. The header's
second line becomes "and the CI toolchain import this one module", which R2
copies too. No other line changes.

Acceptance:

- With the public root-lock nixpkgs and pins, `bun`, `node`, and `moon` have
  unchanged derivation outputs on `x86_64-linux`, `aarch64-linux`, and
  `aarch64-darwin`.
- `bun tools/toolchain/parity.ts` passes.
- The file has no `stdenv.isLinux` left.

### R2 — Another consumer adopts Compass's builder

Lands in: another consumer. Described here by role only.
> Redacted 2026-10-17: private consumer file paths, CI and dev-shell callers, implementation instructions, and acceptance details removed from the public record.

Change: adopt the public builder while retaining consumer-specific configuration.

### Out of scope

Pin versions and the hash-refresh script (see Not reconciled); consumer-specific
toolchain derivatives; the Go toolchain; Compass's env helpers and FOD vehicles.
> Redacted 2026-10-17: consumer-specific toolchain configuration and build details removed from the public record.

## Tasks

- [ ] R1 — Use `stdenv.hostPlatform.isLinux` in compass's builder.
- [ ] R2 — Adopt the public builder in another consumer.

## Resolved decisions

1. **Ship the Nix output or reconcile by hand.** Ruled by Matt on 2026-10-05
   (RIG-4548, option 1B): reconcile by hand and list what stays local.
2. **Pin cadence for a shared flake.** Moot on 2026-10-05: no shared flake
   ships. Pin cadence remains consumer-specific.
3. **Node attr name.** `node`, through R2: the public name is adopted, so
   the public derivation's attribute name stays the same.

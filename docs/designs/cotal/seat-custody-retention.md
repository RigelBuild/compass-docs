# Seat custody retention after leader exit

## Problem / Intent

A custodied seat's child is a session and process-group leader. When that leader exits, nothing
proves the seat's processes gone, but the cleanup paths act as if something did:

- `settleTerminal` in `packages/seat/src/custodian.ts` unlinks `record.json` once the child exits.
  After that, `reapSeat` in `packages/seat/src/reap.ts` returns `absent`, and `requireRuntimeReap`
  refuses it. If the record survived, `reapSeat` skips the group: `groupKilled` is false once the
  leader is gone.
- After a group kill, the `reapSeat` member loop SIGKILLs every pid that a `/proc` census finds.
  That census runs after the leader has exited, so a found pid may already belong to another
  process.
- `reapOrphanSeat` in `implementations/manager/src/manager.ts` returns without a reap when no
  reference reaches it, and the cleanup runs anyway.
- The agent's uid can write `record.json` in every mode, so no pid, start token or boot id in the
  record is authentic.

RIG-4320 ruled option 1: custody evidence lives until the terminal reap. RIG-4422 chose
fail-closed retention, with three rules:

- no numeric process-group signal without kernel-backed proof;
- no custody or credential deletion while descendants are not proved gone, except after a
  durable, authenticated operator release (see Operator release);
- a static name may stay blocked until an operator releases it.

This record turns those rules into interfaces, failure behavior and regression cells.

## Approach

Matt's rulings fix the policy. RIG-4546 chose a contained per-seat cgroup v2 domain for automatic
proof, a privileged manager release verb, static-only scope, no automatic foreign-boot release,
and a kernel-pinned handle for ordinary stop. RIG-4687 Option A captures that handle in the native
PTY spawn, before node-pty's exit thread can reap the child. RIG-4740 chose A on all five rows:
manager-only stop authority, revocation and eviction before proof, `refused` with a
retained-custody reason, a retained count in status, and one T1–T6 stack that includes release
and delegated CI proof. The release coordinate is the stable `ownerInstanceId`. Single-uid seats
fail closed, because an agent that shares the manager's uid can leave the delegated base.

### Layer 1: the custodian keeps the record (`packages/seat`)

- `settleTerminal` stops unlinking `launch.recordPath`. It still disposes the terminal, closes the
  server, unlinks the socket and exits. On all three settle paths (`markExited`, the
  `armUnattended` timer and the `armUnobservedHandoff` timer), `record.json` outlives the
  custodian. A seat directory is removed only after a `reaped` result or a durable release.
- `settleTerminal` drops its `proc.kill("SIGKILL")`. Every caller reaches it with `alive` false, so
  that send targets an exited leader by bare pid (node-pty's `UnixTerminal.kill` is
  `process.kill(this.pid, signal || 'SIGHUP')`).
- **The custodian pins its child before it exposes the seat socket.** The patched native PTY spawn
  returns a handle for the child with its pid, before node-pty's exit thread can reap it. Pinning
  completes before the startup-confirm timer is armed and before `listening.listen` binds
  `launch.socket`. A send through the handle after the child exits reports it gone and reaches no
  other process. The handle covers the child only; descendants are layer 3's concern. It lives in
  custodian memory, never in `record.json` or the seat protocol.
- **A pid read after `pty.spawn` is not evidence.** node-pty's `PtyFork` (`src/unix/pty.cc`) calls
  `forkpty`, then `SetupExitCallback`, whose thread blocks in `waitpid(pid, &stat_loc, 0)`. A child
  that exits at once can be reaped, and its pid reused, before `pty.spawn` returns. `pidfd_open(2)`
  names the child only if "the zombie process was not reaped elsewhere in the program". A parent
  and liveness check does not repair this: with `CLONE_PARENT` a seat process can create a process
  whose parent is the custodian, and that process can take the freed pid. [INFERENCE: T1 confirms]
  The pinned `node-pty@1.2.0-beta.12` source has the same order.
- **Identities are read before the spawn.** `processStartToken(process.pid)` and `bootToken()` move
  before `pty.spawn`, so a missing custodian identity fails with no child. `childStart` is read
  after acquisition and kept only if the handle still reports the child live after the read.
- **Every child signal and liveness read goes through the handle.** `stopChild("graceful")` sends
  SIGTERM, then SIGKILL after `GRACE_MS` if the child is still alive. `stopChild("hard")` sends
  SIGKILL. The startup-confirm timeout, the `armUnattended` stop and every startup failure use the
  same handle. No path calls node-pty's `proc.kill` or `proc.destroy` (whose close handler calls
  `this.kill('SIGHUP')`). `childGone()` reads the handle's exit state instead of
  `/proc/<pid>/stat`, so `markExited`, `hello`, `wait-exit` and `health` never report a process at
  a reused pid as the child. No liveness result authorizes a signal.
- **A startup failure after acquisition stops the child.** From acquisition until `ready`, every
  failure sends SIGKILL through the handle before `runCustodian` rejects. This covers a throw in
  `runCustodian`, a throw in the listen callback, and the listen `error` event (today
  `listening.once("error", reject)` sends nothing). A failed log write never skips the send. The
  custodian exits through the `runCustodian` catch, and `launchSeat` throws
  `custodian exited before ready: <cause>`.
- **A missing handle fails closed.** If pinning fails, or its evidence proves neither that the
  handle names the spawned child nor that the child is gone, the custodian sends no signal, binds
  no socket, writes no record, logs the cause and exits through the same catch. [INFERENCE: T1
  verifies] The custodian's exit closes the PTY master and the kernel hangs up the child's
  terminal; that hangup is not a send to a pid.
- **A fast exit is not an acquisition failure.** A handle captured at spawn stays valid after the
  child exits and reports it gone. The custodian marks the child exited and sends nothing. The
  "natural exit" and "unadopted" cells keep launching children that exit at once.
- **The custodian creates no directory.** `runCustodian` drops its
  `mkdirSync(dirname(launch.socket), …)`, and `writeRecord` drops its parent `mkdirSync` in every
  mode. Only `launchSeat` creates the seat directory, so a custodian whose directory was removed
  fails at its first use of it and takes the startup failure path.
- **The launch fence admits a custodian before it spawns.** Each seat has a fence file,
  `<root>/.launch-<id>`, outside the seat directory so that it outlives the release rename.
  `launchSeat` creates it with `wx`, owned by the manager uid with mode `0644`. It then takes the
  fence's exclusive `flock`, reads it, and refuses with no path created if it reads `sealed`. It
  holds that lock while it creates the seat directory (and, under layer 3, the seat cgroup), and
  closes it in a `finally` on every exit from that setup, so a failed `mkdir` or cgroup create never
  leaves the lock held; a normal exit closes it just before it spawns the custodian. A release that
  seals first therefore leaves nothing for the launcher to create. The custodian's first filesystem
  operation opens the fence read-only without `O_CREAT` (libuv adds `O_CLOEXEC`, so the child never
  inherits the lock), takes an exclusive `flock` and reads the fence through that fd. If the open
  fails, the lock is not taken within `CONFIRM_TIMEOUT_MS`, or the fence reads `sealed`, the
  custodian exits with no child, no socket and no record. Otherwise it holds the lock until `ready`,
  or until its startup-failure SIGKILL is sent; the kernel drops the lock if it exits. A rename
  after the open cannot hide a seal, because the read goes through the fd. An agent-uid process that
  holds the lock only makes release refuse, which leaves the seat retained and the release
  retryable.
- **A launcher timeout is not a disappearance proof.** `launchSeat` stops waiting after ten
  seconds and throws while its detached custodian may still be starting. The durable in-flight
  state is the reserved reference on the slot row, written before the spawn (Layer 2), plus the
  fence and the seat directory. The manager needs no handle to the late custodian: its terminal
  reaps the row reference, which returns `retained` or `absent` without containment, and both stay
  fail-closed. Release seals the fence (Operator release), so no custodian of that launch can
  spawn afterwards.
- **The stop reply covers only the first send.** `case "stop"` replies `{ ok: true, op: "stop" }`
  after the SIGTERM of a graceful stop or the SIGKILL of a hard stop; a failed send other than
  "child gone" replies `{ ok: false, error }`. A failed delayed SIGKILL is logged to
  `custodian.log`, and the child stays alive. `SeatHandle.stop` discards stop errors through
  `later`'s `.catch(() => undefined)`, so the manager sees only a child that does not exit. That is
  safe because no stop releases custody: every stop of a static lifecycle ends in the terminal,
  whose reap returns `retained` without containment (status reason `unprovable`) or kills the seat
  cgroup with it. On the `armUnattended` path, the fired timer re-arms only on the next controller
  disconnect, so a failed delayed SIGKILL leaves the custodian resident with a live child. This is
  accepted; the same terminal status covers it.
- `cgroup.kill` belongs to the external reap only. It is immediate SIGKILL and may kill a custodian.
- `record.json` keeps `RECORD_VERSION` 1, and `readRecord` stays strict.

### Layer 2: the reap trusts nothing in the record (`packages/seat`)

`reapSeat` gains a third outcome, `retained`. Without layer 3 it sends no signal and never returns
`reaped`. Two facts force this:

- **A forged record can aim any numeric send.** An agent can write a live same-uid pid and its
  start token, which anyone can read from `/proc/<pid>/stat`. So the identity-checked
  `kill(-childPid)` and `kill(custodianPid)` that run today are removed.
- **A census cannot prove a process tree gone.** A descendant that calls `setsid()` leaves the
  recorded process group and session, so an empty census of pgrp or session `N` proves nothing. A
  census appears only as advisory text labelled as not proof.

Without a contained cgroup the reap may ask the custodian to stop through `socketPath(root, id)`,
derived from the seat id and never read from `record.json`. A real custodian binds that socket
only after it holds its pinned handle, so the custodian sends the signal, never the reap. With no
custodian answering, the reap sends nothing. Either way the result is `retained`.

The seat cgroup path is derived too, so the reap checks it before it reads `record.json`. A
custodian that dies before `writeRecord`, or an agent that deletes the record, can leave a
populated cgroup with no record. When the derived cgroup exists and is contained, it decides the
outcome whether the record is present, missing or unreadable.

| Record | Layer 3 | Action | Outcome |
| --- | --- | --- | --- |
| missing | off, not contained, or no seat cgroup | none | `absent` (unchanged) |
| unreadable | off, not contained, or no seat cgroup | none | `retained` / `unprovable` |
| present | off, not contained, or no seat cgroup | no numeric signal; optional stop request | `retained` / `unprovable` |
| any | seat cgroup exists and is contained | write `cgroup.kill`, wait, `rmdir` | `populated 0` and `rmdir` succeeds → `reaped`; else `retained` / `members-remain` |

The missing-identity, missing-boot-id and foreign-boot throws in `reapSeat` become `retained` /
`unprovable`, because no new evidence can arrive for them.

```ts
// packages/seat/src/reap.ts (re-exported from packages/seat/src/index.ts)
export type SeatRetainReason = "unprovable" | "members-remain";
export type SeatReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: SeatRetainReason; stop: "requested" | "no-custodian" | "timeout"; detail: string };
export interface SeatReapOpts { graceMs?: number; cgroup?: SeatCgroup }
export async function reapSeat(root: string, id: string, opts?: SeatReapOpts): Promise<SeatReapEvidence>;

// implementations/manager/src/runtime/index.ts
export type RuntimeUnprovenReason = "absent" | "no-reference" | "unprovable" | "members-remain";
export type RuntimeReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; detail: string }
  | { outcome: "retained"; reason: "unprovable" | "members-remain"; detail: string };
export class RuntimeReapUnproven extends Error {
  readonly reference: RuntimeReference | undefined;
  readonly reason: RuntimeUnprovenReason;
  constructor(runtimeKind: string, reference: RuntimeReference | undefined, reason: RuntimeUnprovenReason, detail?: string);
}
```

`reaped` no longer carries `custodian`, `child` or `group`, which described numeric sends.
`requireRuntimeReap` keeps its signature and throws `RuntimeReapUnproven` for both `absent` and
`retained`.

### Layer 2: the manager keeps the lifecycle standing

**The slot row is the only reference authority.**

- `recordSlotCustody` becomes fatal. It throws when the row is missing, at another lifecycle UID,
  not `active`, or when its CAS fails; restart and resume do not spawn after a throw. The initial
  spawn already persists its reservation through the awaited `activateStaticLifecycle`.
- **A predecessor is proved before its reference is replaced.** Restart (`recoverManagedSession`)
  and resume (`launchPreparedResume`) read `slot.row.runtime` first. When it is set and differs
  from the new reservation, `requireRuntimeReap` must return for it before `recordSlotCustody`
  writes the new reference. A `RuntimeReapUnproven` aborts the restart or resume before spawn; the
  row keeps the predecessor reference, and the existing failure path retires the lifecycle, whose
  terminal retains it. Without containment every in-place restart and resume therefore ends
  retained (RIG-4804 item 1).
- Inside the `driveStaticRetirement` executor, the reap target is `slot.row.runtime`. A differing
  caller reference (for example the old handle reference that `freeSlot` copies into the
  `retiring` hold after a failed restart) is logged and never reaped and never thrown as a plain
  `Error`: by the two rules above it was already proved.
- With a custodial runtime and no row reference, `reapOrphanSeat` throws
  `RuntimeReapUnproven(kind, undefined, "no-reference")`. The rollback `deprovision` in the auth
  preflight passes `userOwner` and runs before any seat exists, so it is out of scope.
- **`spawnCustodied` names the seat it got.** When the runtime spawned under `got` instead of
  `reserved`, it records `got` on the slot row (fatal CAS), then throws without reaping inline.
  The spawn's rollback reaches the terminal, which reaps `got` from the row. If that CAS fails,
  the terminal reaps `reserved`, gets `absent`, and retains the alias; `lastError` names `got`.
- **A rowless lifecycle gets a terminal slot.** In `driveStaticRetirement`, when no slot row exists
  (a pre-Unit-B spawn), the manager first writes one with `writeStaticSlotIntent` (this
  `lifecycleUid`, `actor`, `ownerInstanceId`, and `runtime` from the caller), then runs
  `runStaticTerminal` as for any slot. A retained outcome then has the ordinary release
  coordinate. If the alias now holds a slot at another lifecycle UID, the stale teardown sends
  nothing and deletes nothing; `writeStaticSlotIntent` writes a new slot only over a `retired` row
  or none, and a legacy footprint it leaves stays for an operator.

**Revocation and eviction run before proof (RIG-4740 row 2).** `runStaticTerminal` already runs the
B1 ledger revoke and `evictAndAudit` before `cleanupStaticSlotOnce`. The `cleanup` closure in
`driveStaticRetirement` changes order: `retireSource` (issuance retirement for `cred.<uid>`), then
`reapOrphanSeat`, then the creds file, the secret store entry and `deprovisionBroker`. On
`RuntimeReapUnproven` the manager:

- leaves the slot `terminalizing` and `cleanupComplete` unset, so the gate and head stay
  `frozen`/`retiring` and the alias stays refused by `writeStaticSlotIntent`;
- has already revoked the ledger rows, retired the issuances, evicted broker connections and
  written the lifecycle audit;
- keeps the creds file, the secret store entry, the broker durables, the ACL row and the seat
  directory;
- never puts "restart this manager" in a remedy or NEXT.

Residual: a retained process that keeps running can reconnect only as far as the broker enforces
the revoked ledger rows and the deny-new gate; this design adds no broker control.

**Status is visible on every path (RIG-4740 rows 3 and 4).** Today only
`reconcileStaticLifecycles` fills `staticReconcileItems`, and a live despawn's failure reaches only
the `lastError` of its `retiring` hold, which `staticReconciliationStatus` never reads.

- The `driveStaticRetirement` catch calls `recordRetainedTerminal` for every `RuntimeReapUnproven`,
  on live despawn and reconcile alike. It upserts the item at `staticReconcileKey(owner, alias,
  lifecycleUid)` with `phase: "terminalizing"`, `retainedReason` set to the error's reason,
  `lastError` set to its message and `remedy: RETAINED_CUSTODY_REMEDY`.
- For `members-remain` with budget left, the item takes the existing retry rule:
  `retry-scheduled` while a sweep is in flight, else `scheduleStaticReconcileRetry`. A live despawn
  creates its item with `attempts: 1`, so the retry timer drives later attempts through
  `attemptStaticReconcile`. At budget exhaustion, and for every other reason at once, the
  disposition is `refused` with no `nextRetryAt`.
- The `attemptStaticReconcile` catch returns early for `RuntimeReapUnproven`, so its
  `refused-foreign` and `retry-exhausted` branches never overwrite the retained item. A later
  successful terminal clears `retainedReason` as part of `recovered`.
- `staticReconciliation.retainedCustody` counts items with `retainedReason` set and a disposition
  other than `recovered`. A restarted manager rebuilds the count from its boot sweep of
  `terminalizing` rows.

```ts
// implementations/manager/src/manager-service-contract.ts
// failures[] item gains (schema and ManagerStaticReconciliationFailure):
//   retainedReason?: "absent" | "no-reference" | "unprovable" | "members-remain"
// staticReconciliation gains (required; the manager always emits it):
//   retainedCustody: number   // { type: "integer", minimum: 0 }
// implementations/manager/src/manager.ts
const RETAINED_CUSTODY_REMEDY =
  "the seat is not proved gone; confirm its processes are gone, then call release-seat with this alias and lifecycleUid";
private recordRetainedTerminal(row: Pick<StaticManagedSlotRow, "owner" | "alias" | "actor" | "lifecycleUid">, e: RuntimeReapUnproven): void;
```

`implementations/cli/src/commands/status.ts` prints `retainedReason=<reason>` on the failure line
and a `static retained custody <n>` fact, treating both as optional for older managers.

**Exit signals do not release custody.** `SeatClient.waitExit`, `helloInfo.status === "exited"` and
a handle's `status() === "exited"` mean only that the leader exited. A `wait-exit` timeout in
`awaitHandleExit` still pushes `unverifiedStops` for preservation and frees nothing.

**Adoption trusts nothing in the record.** No production code adopts (`adoptRuntimeHandle` has no
caller; RIG-4431). `CustodialPtyRuntime.adopt` derives the socket from
`socketPath(root, reference.id)`, refuses a record whose `id` differs from `reference.id`, and its
result never feeds a reap, release or status outcome. The manager still cannot authenticate the
listener against the seat's own agent, which shares the custodian's uid and can replace
`seat.sock`. That residual is scoped to the seat's own session (RIG-4804 item 4).

### Operator release

A release is an operator's attestation. It is not a proof, and it never sends a signal.

1. **The operator is the verified caller.** The request carries no operator field. The recorded
   operator is `ctx.subject.caller` (`owner`, `actor`, `uid`), the tuple `callerOf` keys on. The
   verb is admitted through `adminGated` under `manager.admin`, like `purge`. `epAdminReach` names
   the residual: in a static mesh, "a LEAKED static admin instrument keeps its reach until the
   credential's bounded TTL".
2. **It pins one incarnation of one owner.** The input is `{ alias, lifecycleUid, reason }` with
   `additionalProperties: false`. The slot must be `terminalizing` at that `lifecycleUid`, and its
   `ownerInstanceId` must equal this manager's stable `managerInstanceId` (an absent
   `ownerInstanceId` counts as this manager's, as in reconcile). A restarted manager keeps that id,
   so it can release what its predecessor process retained.
3. **It seals the launch before it writes the intent.**
   1. Run the read-only checks. Read the release record for this lifecycle. If present, compare
      the stable fields (principal, alias, lifecycle UID, operator, reason, `ownerInstanceId`) and
      reuse its timestamp; reject a different intent before anything changes.
   2. Seal the launch with `sealSeatLaunch`. It opens or creates the fence and takes its lock,
      retrying for up to `CONFIRM_TIMEOUT_MS`; a lock still held refuses with
      `launch-in-progress`. Under the lock, a layer 3 seat cgroup must read `populated 0` and is
      then removed with `rmdir`; `populated 1` or `EBUSY` refuses with `populated`. Then it writes
      `sealed` to the fence and syncs it. A refusal writes no intent and deletes no custody, so
      the seat stays retained and the release can be retried.
   3. If no release record exists, create it atomically. A concurrent create loser rereads and
      compares before deleting anything.
   4. Remove the seat directory: rename it to `<root>/.released-<id>`, then remove the tombstone.
      `ENOENT` on the rename is success. The sealed fence stays, so `launchSeat` cannot reuse the
      id and a late custodian still reads `sealed`.
   5. Re-drive the terminal with `surfaceFailure`.

   After the seal, no custodian of this launch can spawn, and no launcher can join the seat
   cgroup because it no longer exists. So the intent is written only when nothing can repopulate
   the seat. In the terminal, a release record for this lifecycle satisfies the process step: it
   removes a still-present seat directory and never reaps. A crash after the record resumes from
   it; a crash before the record leaves a sealed, retained seat that a retry releases.
4. **The release record is separate from the lifecycle audit.** `evictAndAudit` writes the `v: 1`
   audit, which `sameAudit` compares field by field. The release record lives at
   `recordStatusKey(RECORD_KINDS.lifecycle, [owner, actor, lifecycleUid])`, the unused `.status`
   half of the same split kind (writers `minting-manager-commit`, caller-readable like the audit).
   `lifecycleExecutorPermissions` in `packages/core/src/provision.ts` adds that key to
   `recordKeys`, so the executor that runs the verb can create and read it.

### Layer 3: contained kernel-backed proof

Without layer 3, a stopped seat remains retained. **Chosen: a per-seat cgroup v2 domain.** It is
proof only if the agent cannot leave it.

- **Path.** `<base>/seat-<id>`. `base` is the manager's delegated cgroup: the `0::<path>` line of
  `/proc/self/cgroup`, under `/sys/fs/cgroup`. The path is derived, never read from `record.json`.
- **Entry.** `launchSeat` creates the seat cgroup before it spawns the custodian and refuses if it
  already exists. After the spawn it writes the custodian's pid into the seat cgroup's
  `cgroup.procs`. The custodian takes the fence lock (Layer 1), then forks nothing until
  `/proc/self/cgroup` names the seat cgroup; if that is not true by `CONFIRM_TIMEOUT_MS` from its
  start, it exits with no child. A failed move makes `launchSeat` throw.
- **Launch/reap fence.** A reap or a release that finds the cgroup empty and removes it before the
  custodian joins leaves the move to fail with `ENOENT`, so the custodian exits with no child. If
  the custodian joined first, the cgroup is populated and `rmdir` fails. No process can start
  outside the cgroup after a reap or release accepted its empty state. Release removes the cgroup
  before it writes its intent, so a join in that window refuses the release instead of leaving an
  intent that can never finish.
- **Containment.** Cgroup v2 migration requires write access to the common ancestor's
  `cgroup.procs` (kernel `admin-guide/cgroup-v2`). `seatCgroupContained` must prove the agent cannot
  write that file at the base or any ancestor, using its actual uid, groups, ACLs and capabilities,
  and must run a controlled migration attempt under the agent's credentials. If the attempt
  succeeds or any grant cannot be verified, the result is `retained`. A shared manager/agent uid
  can write the base, so single-uid seats always fail this check and stay retained until release.
- **Proof and kill.** Write `1` to `cgroup.kill` (Linux 5.14). Wait up to `graceMs` (default
  `GRACE_MS`) for `populated 0` in `cgroup.events`, then require a successful `rmdir`. Tasks left
  at the bound, or a failed `rmdir`, give `retained` / `members-remain`. A `setsid` escapee stays
  in the cgroup, so it is covered.
- **Survives restart.** The path is derived, so a successor manager can measure and kill.
- **Costs.** cgroup v2, a delegated base (`Delegate=yes` on the manager unit), and a distinct agent
  uid. Without a delegated base, layer 3 is off; it never falls back to a numeric signal.
- **Measured here only.** Kernel `7.2.6`, `/sys/fs/cgroup` is `cgroup2fs`, inside a systemd user
  scope. [INFERENCE: T5 verifies] A seat cgroup can sit under `base` with empty
  `subtree_control`, and a write to `cgroup.kill` signals across uids on file permission alone.

The rejected alternative, a pidfd group handle (`PIDFD_SIGNAL_PROCESS_GROUP`, Linux 6.9), still
needs a pid the agent cannot forge, misses `setsid` escapees, and dies with the manager.

## Plan

### Global Constraints

- **Scope.** Static lifecycles (`!this.userMode && !a.userOwner` in `driveDeprovision`) under the
  custodial pty runtime. Linux only.
- **Signals.** No signal targets a pid or group number from `record.json`. The reap may write
  `cgroup.kill` on a contained seat cgroup and sends nothing else. The custodian signals its child
  only through the handle captured in the native PTY spawn, never through `proc.kill` or
  `proc.destroy`. A custodian without that handle never exposes its socket.
- **Proof.** `reaped` comes only from layer 3 when `seatCgroupContained` holds. A census, an exit
  signal or a liveness read is never proof.
- **Deletion.** No seat directory, creds file, secret store entry, durable or ACL row is deleted
  before `reaped` or a durable release record exists. Ledger revoke, issuance retirement and
  broker eviction run before proof.
- **Launch fence.** Only `launchSeat` creates a seat directory, and only while it holds the
  unsealed fence lock. A custodian spawns only while it holds the unsealed fence lock. Release
  seals the fence, and removes an empty seat cgroup, before it writes its intent.
- **References.** A reference reaches the slot row before its spawn, or the spawn does not happen.
  A row reference is replaced only after its seat is proved gone.
- **Schemas.** `record.json` stays at version 1. The closed slot-row schema in
  `packages/core/src/lifecycle-state.ts` is unchanged. The status output schema gains
  `retainedReason` and `retainedCustody` only.
- **Release identity.** The operator comes from the verified caller; ownership is
  `ownerInstanceId`.
- **Remedies.** No remedy or NEXT for a retained seat says "restart this manager".
- **Landing.** T1–T6 land as one stack (RIG-4740 row 5). Every task ships a `.changeset/*.md`
  (`"@cotal-ai/seat": patch`, `"@cotal-ai/manager": patch` or `"@cotal-ai/core": patch`, one
  prose paragraph). This record needs none.
- **Evidence.** Every implementation PR names the file and function behind each claim about
  current behavior.

### T1: the custodian keeps the record and pins its child (`@cotal-ai/seat`)

**Interfaces.** In T1, `StopMode`, the `stop` op, `SeatClient.stop`, `SeatHandle.stop` and
`SeatRecord` keep their shapes. `CustodianLaunch` gains `fence` (the fence path); T5 and T6 extend
it further. `protocol.ts` keeps `GRACE_MS` and `CONFIRM_TIMEOUT_MS`.

```ts
// packages/seat/src/record.ts
export function fencePath(root: string, id: string): string; // `${root}/.launch-${id}`

// packages/seat/src/peercred.ts; packages/seat/native/peercred.c gains flock, pidfd_send_signal and poll
export function tryLockFd(fd: number): boolean;                                        // flock(LOCK_EX | LOCK_NB); false on EWOULDBLOCK
export function pidfdSignal(pidfd: number, sig: "SIGTERM" | "SIGKILL"): "sent" | "gone"; // ESRCH is "gone"
export function pidfdExited(pidfd: number): boolean;                                   // poll(POLLIN, 0)

// packages/seat/src/pty.ts
export interface ChildHandle { readonly pid: number; signal(sig: "SIGTERM" | "SIGKILL"): "sent" | "gone"; exited(): boolean }
export interface PinnedPty {
  readonly pid: number; readonly handle: ChildHandle;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void; resize(cols: number, rows: number): void;
}
export function ptyNativePath(arch?: string): string; // build/Release/linux-<arch>/pty.node
export function spawnPinned(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd?: string; env: Record<string, string> }): PinnedPty; // throws when fork returned no pidfd
```

`PinnedPty` has no `kill` or `destroy`, so no custodian path can reach node-pty's pid-based sends.

**Edits.**

- In `settleTerminal`, delete the `unlinkSync(launch.recordPath)` and exited-leader
  `proc.kill("SIGKILL")` blocks.
- In `runCustodian`, delete `mkdirSync(dirname(launch.socket), …)`. Admit through the fence
  (Layer 1) before the socket unlink and the spawn. Read `processStartToken(process.pid)` and
  `bootToken()` before the spawn; read `childStart` after acquisition under the Layer 1 rule.
- In `launchSeat`, create the fence with `wx`, then hold its lock and check it is unsealed while
  creating the seat directory; close the lock fd in a `finally`, before the custodian spawn.
  Pass `fence` in the launch payload.
- Replace `import * as pty from "@lydell/node-pty"` in `custodian.ts` with `spawnPinned`, and drop
  `@lydell/node-pty` from `packages/seat/package.json`. Never open a handle by pid. Apply the
  Layer 1 fail-closed rule on failure.
- Route `stopChild`, the startup-confirm timeout, the `armUnattended` stop and every startup
  failure (including the listen `error` event) through the handle. Make `childGone()` read the
  handle's exit state.
- In `writeRecord`, drop the parent `mkdirSync`.
- Reply to `stop` with the first send's result; log a failed escalation to `custodian.log`.

**Existing tests.**

- `packages/seat/smoke/lifecycle.smoke.ts`: the natural-exit cell asserts the record is present.
  "graceful stop: waitForExit resolves", "hard stop: child is gone after waitForExit" and "O1 its
  child goes with it" (`orphan.smoke.ts`) stay green through the handle.
- The spawn-action smoke teardown stops each remaining seat through `SeatClient` (`stop("hard")`,
  `waitExit`, `close`), then removes the seat directories, because without layer 3 `reapSeat` never
  returns `reaped`. Update the find texts in
  `implementations/manager/smoke/mutations/spawn-action-seat-reap.json` in the same commit; both
  mutations must still turn their cells red.
- `bin/smoke/reap-seat-custodians.mjs` is CI-only tooling and out of scope.

**New cells** (mutations in `packages/seat/smoke/mutations/lifecycle.json`).

- **Unattended settle keeps the record.** Restoring the unlink turns both record-present cells red.
- **Graceful stop escalates.** The child ignores SIGTERM; after a graceful stop, `waitForExit`
  resolves and the child is gone. Removing the escalation timer turns it red.
- **An unpinned child is never signalled.** A test-only seam that a production launch cannot set
  forces acquisition to fail. The child writes its pid to a file, ignores SIGHUP and writes a
  marker on SIGTERM. `launchSeat` throws with the logged cause, neither `seat.sock` nor
  `record.json` exists, and the child is alive with no marker; the test then kills it. Adding a
  `proc.kill("SIGKILL")` fallback turns it red.
- **Startup failures after pinning stop the child.** One cell forces the listen `error` event;
  another fails after bind, before `writeRecord`. The child ignores SIGHUP and SIGTERM; `launchSeat`
  throws, no record exists, and the child is gone. Removing either SIGKILL path turns its cell red.
- **A removed directory stops a late custodian.** The seam holds the custodian before its first
  filesystem operation; the test removes the seat directory, keeps the unsealed fence and releases
  the hold. No record exists, the directory is not recreated and the child is gone. Restoring the
  `mkdirSync` in `runCustodian` turns it red.
- **A reused pid is never signalled.** Inside `unshare --user --map-root-user --pid --fork
  --mount-proc`, a C fixture child creates a `CLONE_PARENT` sibling and exits at once. After
  node-pty reaps it, the sibling writes the child's pid to `ns_last_pid` and creates a second
  `CLONE_PARENT` process at that pid. The seam holds the custodian until that process exists, then
  forces a startup failure. The process at the reused pid stays alive. Opening the handle by pid
  after the hold, with parent and liveness checks, turns it red. Measured here only: a write of 41
  to `ns_last_pid` gave the next process pid 42 (kernel `7.2.6`). [INFERENCE: T1 verifies] CI
  runners allow unprivileged user namespaces.

**Native spawn.** The pinned `@lydell/node-pty` `1.2.0-beta.12` exposes only `spawn(): IPty`
with `pid` and `kill`, and its platform packages carry only a prebuilt `pty.node`.
`build-native.mjs` builds only `peercred.c`, and the CI native jobs ship only `peercred.node`. T1
adds the capability as a source patch at the pinned revision:

- **Source.** Vendor the Linux files of upstream `node-pty@1.2.0-beta.12`, which `@lydell`
  repackages (its `lib/index.js` and `lib/unixTerminal.js` match upstream byte for byte), into
  `packages/seat/native/node-pty/`: `src/unix/pty.cc`,
  `lib/{unixTerminal,terminal,eventEmitter2,utils}.js` and `LICENSE`. `UPSTREAM.json` records the
  tarball URL, its integrity
  (`sha512-uExTCG/4VmSJa4+TjxFwPXv8BfacmfFEBL6JpxCMDghcwqzvD0yTcGmZ1fKOK6HY33tp0CelLblqTECJizc+Yw==`)
  and each file's upstream sha256. The committed files carry `pidfd.patch`. `build-native.mjs`
  reverse-applies the patch to a copy and refuses to build unless every file matches its upstream
  sha256. The vendored `lib/` ships through `files`.
- **Patch.** In `PtyFork`, the parent calls `syscall(SYS_pidfd_open, pid, 0)` right after
  `forkpty` returns and before `SetupExitCallback(napiEnv, cb, pid)` starts the `waitpid` thread,
  so the unreaped child still owns the pid. The returned object gains `pidfd`; a failed open omits
  it. In `lib/unixTerminal.js`, the native lookup loads `build/Release/linux-<process.arch>/pty.node`
  from the seat package root (the layout `nativeHelperPath` uses), and the constructor keeps
  `term.pidfd`. The raw syscall keeps glibc's `pidfd_open` wrapper out of the symbol floor. It
  needs Linux 5.3; on an older kernel acquisition fails and the custodian fails closed.
- **Build.** `build-native.mjs` also compiles `pty.cc` with `c++ -shared -fPIC -O2
  -fstack-protector-strong -std=gnu++17 -DNAPI_CPP_EXCEPTIONS -DNODE_GYP_MODULE_NAME=pty`, the
  Node headers it already uses and `node-addon-api` (a seat devDependency pinned at `7.1.1`,
  headers only), linking `-lutil`, into `build/Release/linux-<arch>/pty.node`. It checks the ELF
  machine as it does for `peercred.node`. [INFERENCE: T1 verifies] These flags match upstream's
  `binding.gyp` with `node_addon_api_except`.
- **Floor (RIG-4832 question 2, B).** Both native jobs build on their existing runners
  (`ubuntu-latest`, `ubuntu-24.04-arm`), not in a `manylinux` image. This raises the floor above
  the `@lydell` prebuild's `GLIBC_2.28`, `GLIBCXX_3.4.22` and `CXXABI_1.3.9`: `forkpty` alone binds
  at `GLIBC_2.34`. [INFERENCE: T1 verifies] T1 measures the highest `GLIBC_`, `GLIBCXX_` and
  `CXXABI_` versions `readelf -V` reports for `pty.node` on each arch. It pins them as a ceiling the
  native job fails above, and states the minimum glibc in the seat package README and changeset.
- **CI and pack.** The `seat-native-linux-x64` and `seat-native-linux-arm64` jobs in `ci.yml` and
  `changesets.yml` upload the whole `build/Release/linux-<arch>/` directory. `SEAT_NATIVE_X64` and
  `SEAT_NATIVE_ARM64` name that directory, and `seat-assemble-natives.mjs` copies both `.node`
  files. `SHIPPED_LINUX_NATIVES` in `assert-shipped-natives.mjs` covers both files for each arch,
  and `ci-seat-pack.sh` lists and checks both.
- **Load smoke.** From the packed tarball, installed without a toolchain, on x64
  (`bin/smoke/seat-installed-dist.smoke.ts`) and on arm64 (the `seat-linux-arm64` job):
  `spawnPinned` starts `sh -c 'read x'`; the `Pid` line of `/proc/self/fdinfo/<pidfd>` equals the
  child pid; `signal("SIGKILL")` returns `sent`; after the exit, `exited()` is true and a second
  send returns `gone`. Resolving `@lydell/node-pty` from the installed seat fails.
- **Mutations.** In `packages/seat/smoke/mutations/packaging.json`: shipping the `@lydell`
  prebuilt `pty.node` in place of the built one turns the load smoke red; restoring
  `@lydell/node-pty` in the seat dependencies turns the resolve check red. In
  `bin/smoke/mutations/seat-native-ci.json`: dropping `pty.node` from either native job's upload
  turns `bin/smoke/seat-native-ci.smoke.ts` red.

### T2: the reap sends no numeric signal (`@cotal-ai/seat`)

**Edits.** In `reapSeat`, delete both `signal(…)` sends and the member loop. Request a stop only
through `socketPath(root, id)`. Follow the Layer 2 table; without `opts.cgroup` the result is
`retained` or `absent`.

**Existing cells.** The reap-live cells assert `retained` with `stop: "requested"`; "the custody
record is forgotten" becomes "the custody record is kept"; the mismatched start identity cell
asserts `retained`.

**New cells.**

- **Forged same-uid record.** The test spawns a sleeper with `detached: true`, so it is its own
  process-group leader, and asserts its pgid equals its pid. It writes that pid and start token as
  the recorded child and custodian, then reaps. The outcome is `retained` and the sleeper is alive.
  Mutation: restoring `kill(-childPid)` must kill the sleeper and turn the cell red.
- **setsid escapee.** A child starts a `setsid` grandchild, records its pid and exits. The outcome
  is `retained` and the grandchild is alive; the test then kills it. Mutation: returning `reaped`
  on an empty pgrp or session census turns it red.
- **Foreign boot.** The outcome is `retained` instead of a throw.

### T3: the manager stands fail-closed (`@cotal-ai/manager`)

**Interfaces.**

- `RuntimeReapUnproven`, `RuntimeUnprovenReason` and `RuntimeReapEvidence` as in Approach;
  `CustodialPtyRuntime.reap` maps one to one.
- `private async reapOrphanSeat(a: { name: string; runtime?: RuntimeReference }, rowRuntime:
  RuntimeReference | undefined): Promise<void>`: reaps `rowRuntime` only; logs a differing
  `a.runtime`; throws `no-reference` when `rowRuntime` is absent under a custodial runtime.
- `private async recordSlotCustody(a, runtime): Promise<void>` throws instead of logging.
- `private async provePredecessor(a: { name: string; id: string; lifecycleUid: string }, next:
  RuntimeReference): Promise<void>`: reads the row and calls `requireRuntimeReap` on a differing
  `slot.row.runtime`. Restart and resume call it before `recordSlotCustody`.
- `spawnCustodied(name, spec, cwd, reserved, slot: { id: string; lifecycleUid: string })` records
  `got` on a mismatch, then throws.
- `recordRetainedTerminal`, `RETAINED_CUSTODY_REMEDY` and the status fields as in Approach.
- `driveStaticRetirement`: the rowless slot write, the stale-UID no-op, and the reordered `cleanup`.

**Cells** (fake custodial runtime unless named).

- **Retained terminal.** The runtime returns `retained` / `unprovable` on live despawn. The slot
  stays `terminalizing`; ledger rows are revoked, issuances retired and the eviction audit
  written; the creds file, durables and ACL row remain; `writeStaticSlotIntent` throws
  `failed-precondition`; `status` shows `refused`, `retainedReason: "unprovable"`, the release
  remedy, no `nextRetryAt` and `retainedCustody: 1`.
- **Members remain.** The runtime reports `members-remain`, then `reaped`. A retry is armed,
  cleanup runs once after the proof, and the item becomes `recovered` without `retainedReason`.
  Removing the retry turns it red. A separate cell exhausts the budget: `refused` with the release
  remedy, never `retry-exhausted`.
- **Predecessor kept.** A restart whose predecessor reap returns `retained` spawns nothing, the row
  still names the predecessor, and status is retained. Recording the new reference before the
  proof turns it red.
- **Reservation is fatal.** A forced `recordSlotCustody` CAS failure means `runtime.spawn` is never
  called. Restoring the catch-and-log turns it red.
- **Failed restart.** A restart whose replacement spawn fails after the new reference is recorded
  reaches the terminal with the old handle reference; the row reference is reaped, and the status
  is retained, never a plain `Error`.
- **Spawned under another reference.** The row names `got` after the failure, and the terminal
  reaps `got`.
- **Rowless lifecycle.** No slot row: the terminal writes one, retains, and status names the alias
  and `lifecycleUid`.
- **No reference.** A row with no `runtime` gives `refused` / `no-reference`; the creds file
  remains.
- **Failed escalation** (real custodial pty, no layer 3). A test seam makes the delayed SIGKILL
  send fail for a child that ignores SIGTERM. After despawn, status shows `retainedReason:
  "unprovable"`, the slot stays `terminalizing`, the alias is refused, and the creds file and
  seat directory remain. Mapping `retained` to `reaped` in `CustodialPtyRuntime.reap` turns it red.
- **Late readiness** (real custodial pty, `orphan-seat-spawn-window.smoke.ts`). The seam holds the
  custodian before `writeRecord` past the ten-second launcher bound. The spawn fails, the row
  names the reserved reference, and status is retained. After the custodian becomes ready, the
  next reconcile is still retained. Mapping `absent` to `reaped` in `CustodialPtyRuntime.reap`
  turns it red.
- **Refusal surface.** In `reap-absent-refusal.smoke.ts`, delete section (d), which counts source
  text. Add: a `retained` / `unprovable` outcome makes `requireRuntimeReap` throw
  `RuntimeReapUnproven` with that reason and the reference.
- **Consumer view.** `implementations/cli/smoke/component-health.smoke.ts` serves a retained
  failure and asserts the rendered `disposition=refused retainedReason=unprovable remedy=…` line and
  the retained count fact.
- **Fixture.** Update the find text in `orphan-seat-reap.mutations.json` in the same commit.

### T4: operator release (`@cotal-ai/seat`, `@cotal-ai/manager`, `@cotal-ai/core`)

```ts
// packages/seat/src/reap.ts
export type SeatReleaseCheck = { ok: true; advisory: string } | { ok: false; reason: "populated" | "launch-in-progress"; detail: string };
export function checkSeatRelease(root: string, id: string, opts?: { cgroup?: SeatCgroup }): SeatReleaseCheck; // read-only
export async function sealSeatLaunch(root: string, id: string, opts?: { cgroup?: SeatCgroup }): Promise<SeatReleaseCheck>; // fence lock, empty cgroup rmdir, "sealed"
export function removeSeatCustody(root: string, id: string): void; // rename to .released-<id>, then remove; ENOENT is success; keeps the fence

// implementations/manager/src/static-lifecycle.ts
export interface StaticLifecycleReleaseSpec {
  v: 1; principal: string; alias: string; lifecycleUid: string;
  operator: { owner: string; actor: string; uid: string }; // from ctx.subject.caller, never args
  reason: string; ownerInstanceId: string; managerProcessUid: string; timestamp: string;
}
// stored at recordStatusKey(RECORD_KINDS.lifecycle, [owner, actor, lifecycleUid]); compare excludes managerProcessUid and timestamp
export async function writeStaticRelease(t: LifecycleStateTransport, spec: StaticLifecycleReleaseSpec): Promise<void>;
export async function readStaticRelease(t: LifecycleStateTransport, owner: string, actor: string, lifecycleUid: string): Promise<StaticLifecycleReleaseSpec | undefined>;

// packages/core/src/provision.ts lifecycleExecutorPermissions: recordKeys gains
//   recordStatusKey(RECORD_KINDS.lifecycle, [pin.owner, pin.actor, pin.lifecycleUid])

// implementations/manager/src/manager-service-contract.ts
// { name: "release-seat", capability: "manager.admin", input: RELEASE_SEAT_INPUT_SCHEMA, … handler: "releaseSeat" }
// RELEASE_SEAT_INPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["alias", "lifecycleUid", "reason"], … }

// implementations/manager/src/manager.ts
// releaseSeat: (ctx) => this.serveGated(ctx, () => adminGated(ctx, async () => unwrap(await this.opReleaseSeat(args(ctx), ctx.subject.caller))))
private async opReleaseSeat(args: Record<string, unknown>, caller: EpCaller): Promise<ControlReply>;
```

**Cells.**

- **Authorization.** A caller without `admin` gets `permission-denied`; no record is written.
- **Operator from the payload.** An `operator` field fails the input schema; the recorded operator
  equals the caller tuple.
- **Wrong incarnation or owner.** A `lifecycleUid` mismatch, or a row whose `ownerInstanceId`
  names another manager, is refused.
- **Successor release.** A manager restarted on the same workspace (same `ownerInstanceId`, new
  process UID) releases a lifecycle its predecessor process retained.
- **Executor grant.** Against a real broker, the lifecycle executor creates and reads the release
  record; removing the key from `recordKeys` turns it red.
- **Store failure.** A failed release write leaves the seat directory and footprint.
- **Crash and retry.** A crash after the record, or after removal, finishes on retry; a retry with
  the same operator and reason reuses the intent; a different reason or operator is rejected
  without deletion; a concurrent create loser compares before removing.
- **Late custodian.** The seam holds a custodian before its first filesystem operation; the test
  releases the seat, then releases the hold after the rename. No child marker, `seat.sock`,
  `record.json`, `<root>/<id>` or `.released-<id>` exists. Making the custodian ignore a `sealed`
  fence turns it red (the child writes its marker).
- **Late launcher.** The seam holds `launchSeat` after it creates the fence and before it takes
  the lock; the test completes the release, then releases the hold. The launcher refuses, and
  neither `<root>/<id>` nor a seat cgroup exists. Making `launchSeat` skip the seal check turns it
  red (the seat directory reappears).
- **Failed launcher setup.** The seam makes the seat `mkdir` throw while `launchSeat` holds the
  lock. The launch fails, and a release in the same live manager takes the lock and completes.
  Dropping the `finally` close turns it red (the release refuses with `launch-in-progress`).
- **Launch in progress.** The seam holds a custodian after admission. The release refuses with
  `launch-in-progress` and writes no record. Making `sealSeatLaunch` skip the lock turns it red.
- **Rowless lifecycle.** The slot written by T3 releases like any other.
- **Refusal.** Under layer 3, a populated cgroup is refused.

### T5: contained proof, seat side (`@cotal-ai/seat`)

```ts
// packages/seat/src/cgroup.ts
export interface SeatCgroup { readonly path: string; readonly agentUid: number }
export function seatCgroupPath(base: string, id: string): string;            // `${base}/seat-${id}`
export function createSeatCgroup(base: string, id: string, agentUid: number): SeatCgroup; // EEXIST throws
export function moveIntoSeatCgroup(cg: SeatCgroup, pid: number): void;       // launcher; ENOENT throws
export function inSeatCgroup(cg: SeatCgroup): boolean;                        // custodian; reads /proc/self/cgroup
export function seatCgroupContained(cg: SeatCgroup): boolean;                // uid, groups, ACLs, capabilities, migration probe
export function seatCgroupPopulated(cg: SeatCgroup): boolean;                // cgroup.events
export function killSeatCgroup(cg: SeatCgroup): void;                        // "1" > cgroup.kill
export function removeSeatCgroup(cg: SeatCgroup): void;                      // rmdir; EBUSY throws
```

`LaunchSeatOpts` gains `cgroupBase?: string`; `CustodianLaunch` gains `cgroup?: string`, and the
custodian waits on `inSeatCgroup` before `pty.spawn`. `reapSeat` checks `opts.cgroup.path` before
it reads `record.json`.

**Cells.**

- A `setsid` escapee is killed and proved gone; a new runtime instance proves the cgroup through
  the derived path; `rmdir` refuses while populated.
- **Migration attempt.** A child writes its pid into `base/cgroup.procs`. Under a distinct uid the
  write fails, including with a group-writable ancestor, and the reap is `reaped` only after the
  kill. With a shared uid, or unprovable grants, `seatCgroupContained` is false and the reap is
  `retained`.
- **Record-less seat.** A contained child ignores SIGTERM and SIGHUP; the test deletes
  `record.json` and reaps. The outcome is `reaped`, the child is gone and the cgroup is removed.
- **Launch/reap fence.** The seam holds the custodian before the move; the test reaps (empty
  cgroup, `reaped`), then releases the hold. The move fails, the custodian exits, and no child
  exists.
- **Release/join race.** The seam holds a launcher before the move and holds the release between
  its `populated 0` read and its `rmdir`. The test releases the launcher, then the release. The
  release refuses with `populated`, no release record exists, and the terminal stays `retained`.

**Mutations.** Reading `populated 1` as empty turns the populated cell red; skipping
`seatCgroupContained` turns the shared-uid cell red; reading `record.json` before the cgroup turns
the record-less cell red; spawning the child without `inSeatCgroup` turns the fence cell red;
writing the release record before the cgroup `rmdir` turns the release/join cell red.

### T6: contained proof, manager side and delegated CI (`@cotal-ai/manager`, `@cotal-ai/seat`)

- `CustodialPtyRuntime` takes `{ root?: string; cgroupBase?: string; agentUid?: number }`.
  `agentUid` comes from `COTAL_SEAT_AGENT_UID` and defaults to the manager's uid. The manager
  resolves `cgroupBase` at start and logs one line when it is unavailable. `reap` passes the
  derived cgroup on every call.
- When `agentUid` differs from the manager's uid, the manager must run with euid 0. `launchSeat`
  creates the seat directory owned by `agentUid` and spawns the custodian with Node's `uid` and
  `gid` options. `CustodianLaunch` gains `adopterUid`, the manager's uid, and the custodian peer
  check in `handle` compares `cred.uid` with `launch.adopterUid` on every frame, so the agent uid
  cannot send `stop` (RIG-4740 row 1). With a shared uid the check is unchanged (RIG-4804 item 2).
- **Delegated CI proof.** The `live` job in `.github/workflows/ci.yml` creates a CI agent user and
  runs `pnpm smoke:lifecycle-e2e` under `sudo systemd-run --scope -p Delegate=yes` with
  `COTAL_SEAT_AGENT_UID` set to that user. All 30 cells pass there. A new cell asserts a
  connection from the agent uid gets "peer uid mismatch" for `stop`. [INFERENCE: T6 verifies]
  GitHub `ubuntu-latest` runners give passwordless `sudo`, systemd and cgroup v2.
- Single-uid runs of the same smoke report retained custody for the despawn cells; the stack does
  not run them as passing proof.

## Tasks

- [ ] T1 custodian keeps `record.json`; identities before spawn; launch fence; no custodian
      `mkdirSync`; patched `pty.node` built, packed and load-smoked on x64 and arm64; every stop,
      liveness read and startup failure through the handle; cells and seat changeset.
- [ ] T2 `reapSeat` sends no record-derived signal; stop only by request; forged-record (pgid
      leader), setsid and foreign-boot cells; seat changeset.
- [ ] T3 fatal reservation; predecessor proof; row-only reap; `spawnCustodied` records `got`;
      rowless slot; revoke and evict before proof; `recordRetainedTerminal`, `retainedReason`,
      `retainedCustody` and CLI status; cells and manager changeset.
- [ ] T4 `release-seat` with verified operator, `ownerInstanceId`, release key in the executor
      grant, `sealSeatLaunch` before the intent, rename removal; cells; seat, manager and core
      changesets.
- [ ] T5 seat cgroup with launcher move, custodian membership wait and fence; release removes the
      empty cgroup under the fence lock; cgroup before record; cells; seat changeset.
- [ ] T6 distinct-uid launch, `adopterUid` peer check, delegated CI job with lifecycle-e2e green;
      manager and seat changesets.

## Resolved decisions

- **Automatic proof (RIG-4546).** Contained per-seat cgroup v2. Unavailable proof returns
  `retained`, never a numeric-signal fallback.
- **Single-uid mode (RIG-4546).** `seatCgroupContained` is false; reaps stay `retained` until a
  verified release.
- **Release (RIG-4546, RIG-4740).** `adminGated` manager verb; operator from the subject caller;
  separate durable record; ownership by `ownerInstanceId`.
- **Custodian stop (RIG-4546 Option 1, RIG-4687 Option A).** Kernel-pinned handle captured in the
  native spawn; acquisition failure fails closed; `cgroup.kill` stays reap-only.
- **Scope and reboot (RIG-4546).** Static only; a foreign-boot record is never released
  automatically.
- **RIG-4740.** A on all five rows: manager-only stop authority, revocation and eviction before
  proof, `refused` with a retained reason, a retained count, one T1–T6 stack.
- **RIG-4804.** The default on all six remaining forks:
  1. **Predecessor on restart and resume.** Prove the predecessor before replacing the single row
     reference. Without containment, in-place restart and maintenance resume end retained, and
     single-uid smokes that restart or resume change outcome. The slot-row schema is unchanged.
  2. **Stop authority with a shared uid.** Single-uid mode keeps today's uid-plus-token check as a
     stated residual; the agent can `kill(2)` its seat anyway.
  3. **Sibling seats under one agent uid.** T6 uses one agent uid for every seat. A compromised
     seat can still signal sibling seats, read their `/proc` entries and write their directories.
     This is an accepted residual; per-seat uids or a broker are out of scope.
  4. **Adoption authenticity.** Adoption binds to the reserved id and stays out of every proof
     path; the same-uid impersonation residual is deferred to RIG-4431.
  5. **Release key and status carrier.** The release record lives at the lifecycle kind's
     `.status` key (caller-readable); the status schema gains optional `retainedReason` and
     `retainedCustody`.
  6. **Distinct-uid launch.** T6 launches the custodian from a root manager; the
     `cotal-seat-launch` helper is not used.
- **RIG-4832.** 1. A: the node-pty pidfd patch is a vendored source patch at the pinned revision,
  built in the seat package's native jobs. 2. B: `pty.node` builds on the plain runners, and the
  seat accepts the higher glibc floor that results (T1, Floor).

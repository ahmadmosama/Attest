# Interruption

A run gets killed. The operator presses Ctrl-C, CI cancels the job, the laptop sleeps, the
process runs out of memory. This page is what Attest does about it, and, just as importantly,
what it does not.

## The two halves

Nothing catches `SIGKILL` or `taskkill /F`. Any design that pretends otherwise is a lie, and a
gate built on a lie is the thing this project exists to avoid. So there are two mechanisms, and
neither is sufficient alone:

| | Covers | Mechanism |
|---|---|---|
| **The cleanup registry** | Ctrl-C, SIGTERM, SIGHUP, SIGBREAK, an uncaught exception, ordinary exit | `src/runtime/cleanup.mjs` |
| **The sweeps** | Everything else, including SIGKILL and pulling the power | the *next* run reclaims what the last one left |

## The registry

One registry, one set of handlers. That is the design, and it is a correction rather than a
feature: there used to be **two**. The replication slot layer installed `SIGINT`/`SIGTERM`
handlers that ended in `process.exit`, and the tenancy layer installed its own that did the same.
Whichever finished first killed the other's in-flight cleanup, so a Ctrl-C during a run holding
both a slot and a tenant reliably leaked one of them. Adding a third for the emulator and the
browser would have made it worse.

What it guarantees:

- **Reverse acquisition order.** A resource acquired later may depend on one acquired earlier:
  the slot is created *through* a connection, the recording runs *on* a booted emulator. Tearing
  down forwards closes the thing the next disposer needs.
- **One failure does not skip the rest.** That was the concrete failure mode of the two competing
  registries.
- **Every disposer is bounded** (5s each, 20s total). A Ctrl-C that appears to hang is worse than
  one that leaks, because the operator's next move is SIGKILL and then *everything* leaks instead
  of one thing. Bounding turns a total loss into a partial one, and what got skipped is named.
- **A second Ctrl-C abandons cleanup and exits.** They pressed it twice. They mean it.
- **`dispose()` and `release()` are idempotent.** The normal path and the signal path race by
  construction, so each has to be safe when it loses.

Handlers install themselves on **first registration**, not only from the CLI entry. A guarantee
that depends on the entry point remembering to call `install()` is not a guarantee, and the whole
finding was that leaks happen on the paths nobody thought about. They come back off when the last
resource is released, so a `node --test` process that opened and closed a slot goes back to
Node's default signal behaviour.

Registered today: Postgres replication slots, Postgres tenants, the surface registry (which owns
the emulator), and web sessions (browser plus scratch dirs).

### The Windows asymmetry, stated rather than assumed

Node **does not deliver `SIGTERM` on Windows at all**. `process.kill(pid, 'SIGTERM')` terminates
immediately with no handler run. So on Ahmad's machine Ctrl-C is covered and `taskkill` without
`/F` is not, while on the Linux and macOS runners both are. That is exactly why the sweeps exist
as well as the registry.

## The interrupted verdict

`run.json` used to be written once, at the very end. Kill the process at step four of sixty and
the run directory held evidence and no record at all, so the AtoZ stage that "reads `run.json`,
never the HTML" got nothing and had to guess. **Both guesses are wrong**: passing ships unverified
code, failing blames the app for the operator's keystroke.

So the run directory is claimed before the first scenario:

```json
{ "status": "in_progress", "note": "This run is still in progress. If this file is still here, the run did not finish." }
```

and a signal turns it into a third status that is neither:

```json
{ "status": "interrupted", "interrupted": true, "reason": "SIGINT", "scenariosCompleted": 4 }
```

The stage blocks on both, under `verify_interrupted`, a different kind from `verify_failed` and
`verify_infra`, so whoever is paged goes to look at the runner rather than at the diff. After
`SIGKILL` the `in_progress` marker is what survives, and that is the honest outcome: the run did
not finish, so it is not a verdict, so the gate blocks.

## Atomic writes

Every artifact is written to a temp file in the same directory and renamed. `rename` within a
directory is atomic on both NTFS and POSIX, so a reader sees either the old file or the whole new
one. A kill during a plain `writeFile` left truncated JSON with nothing to distinguish it from a
complete file, and half a verdict is worse than none, because none is visibly none.

## The sweeps

For the uncatchable half. Each runs at the start of the next run and reclaims what the last one
left:

| Resource | Sweep | Guard |
|---|---|---|
| replication slots | `sweepOrphanSlots`, per scenario preflight | never drops an **active** slot, never a non-`attest_` slot, and never one this process still holds |
| tenant rows | `sweepStaleTenants`, at window open | 24h age cutoff, plus the same held-by-this-process guard |

That guard is not decoration. The slot sweep used to run with `keep: []`, so a scenario's
preflight would drop a sibling's slot the moment it was momentarily inactive. It was masked by
concurrency defaulting to 1, which made it a hazard waiting for the day someone raised it: a green
run whose deltas came from a slot dropped and recreated underneath it.

## What is proven, and how

`test/acceptance/interrupt.test.mjs` spawns a real Node process, lets it take real resources,
kills it the way an operator would, and inspects the disk. It is the only test here that would
catch a registry that is correct in isolation and never actually reached.

```text
✔ SIGINT tears everything down and leaves an interrupted verdict, not silence
✔ SIGKILL leaves the marker behind, which is the honest outcome
✔ a second interrupt does not leave the process wedged
```

The `SIGKILL` test asserts the *opposite* of the others on purpose. A test suite where every case
proves the cleanup works would be describing a system that does not exist.

## Known gaps

1. **The device-side `screenrecord` survives a kill.** The host-side `adb` child is registered,
   but the process on the emulator keeps running to its 180s limit and leaves an unfinalised
   `.mp4` on `/sdcard`. There is no sweep for it.
2. **The iOS simulator is never shut down by Attest**, on any path. The CI workflow does it in an
   `if: always()` step, which covers the only place iOS runs today.
3. **No cross-process lock.** Two concurrent `attest run` invocations against the same database
   are safe with respect to slots (the keep guard), but nothing stops two runs from fighting over
   one emulator.

# Integration

Attest is a gate. A gate nobody calls is a hobby, so this page is how it gets called: as an AtoZ
pipeline stage, and as the thing `/gsd:validate-phase` asks before marking a phase verified.

## The boundary

Attest owns the **adapter**. AtoZ and GSD own **whether and where to mount it**.

`src/integrate/atoz-stage.mjs` imports nothing from AtoZ, and AtoZ imports nothing from Attest at
build time. Two mature projects that import each other are one project with a longer build. The
stage contract is a shape, and this module is built to that shape:

```js
{ name, inputs, applicable, outputSchema, async run(ctx, inputs, deps) }
```

The blocking error is duck typed for the same reason: AtoZ blocks on a `BlockerError` carrying
`kind` and `reason`, so the stage throws an error of that name and shape rather than importing
the class.

## Mounting the stage in AtoZ

Three small changes, all in AtoZ, all reviewable in one diff.

**1. Add the stage module.** Either import Attest's factory, or copy the ten line wrapper:

```js
// src/stages/verify.mjs
import { createAttestStage } from "attest/integrate/atoz-stage";
import { execa } from "execa";

export default createAttestStage({
  inputs: ["build"],
  async runAttest({ cwd, artifactRoot, surfaces }) {
    const result = await execa("attest", ["run", "--artifacts", artifactRoot, "--surface", ...surfaces], {
      cwd,
      reject: false
    });
    return { artifactRoot, runId: /* the run id attest printed */ result.stdout.match(/runs[\\/](\S+)/)?.[1] };
  }
});
```

**2. Mount it in `_registry.mjs`.** Stage order lives in that one array and nowhere else, which is
AtoZ's own D-05 rule. `verify` goes **after `review` and before `deploy`**: reviewing code and
then shipping it unverified is the hole this fills.

```js
import verify from './verify.mjs';
// ... review, verify, legal-docs, deploy ...
```

**3. Declare the artifact.** `VERIFY_REPORT` is exported from the stage module, or add an
equivalent to `src/state/artifacts.mjs` if AtoZ prefers its schemas in one place.

### Three rules that are not negotiable

- **The stage reads `run.json`, never the HTML report.** The blocking decision comes from one
  `status` field. Parsing a report written for humans is how a gate starts disagreeing with
  itself.
- **Infrastructure stays distinguishable from a scenario failure**, all the way to the pipeline:
  `verify_infra` and `verify_failed` are different kinds. "The emulator did not boot" and "the app
  is wrong" call for different actions from whoever is paged.
- **A run with no verdict is not a pass.** A killed run leaves `status: "in_progress"` or
  `"interrupted"`, and the stage blocks on both under a third kind, `verify_interrupted`. This is
  the one that is easy to get wrong: the marker's `counts` are all zero, so a stage reading only
  `counts.failed` would call an interrupted run a clean pass and ship unverified code. See
  [interruption.md](./interruption.md).

| Kind | Means | Who to page |
| --- | --- | --- |
| `verify_failed` | scenarios failed | whoever wrote the change |
| `verify_infra` | the emulator, browser or database did not come up | whoever owns the runner |
| `verify_interrupted` | the run was killed before it produced a verdict | whoever owns the runner |
| `verify_no_run_record` | Attest produced no readable record at all | whoever owns the stage wiring |

## INTEG-02, the mobile track: prepared, not landed

AtoZ's `src/tracks/` has `web.mjs` and a stub. A mobile track means deciding what `build` produces
for a mobile app, what `deploy` even means there, and whether the design and marketing stages
apply. Those are AtoZ's decisions with AtoZ's consequences, and making them from this side would
be exactly the cross project overreach this boundary exists to prevent.

What Attest provides so the track is cheap when AtoZ wants it: the verify stage already accepts
`ctx.surfaces`, and the Android and iOS surfaces already run from one command. The track has to
supply an `.apk` or a simulator `.app` as the stage's app artifact, and nothing else changes.

## The GSD hook

`src/integrate/validate-phase.mjs` takes a phase's requirement IDs and returns a verdict:

```js
const verdict = await validatePhase({
  phase: "7",
  requirements: ["INTEG-01", "INTEG-02"],
  runScenarios: async ({ requirements }) => /* scenario results covering them */
});
```

```text
phase 7 NOT verified
  uncovered INTEG-02: no scenario covers this requirement
  failing INTEG-01: checkout.card [android] failed at step 3 E_ANDROID_NOT_FOUND
```

**A missing verification is a failure, not a pass.** That is the half that matters. Today a phase
is marked verified because somebody read the plan and agreed. If this hook only reported on the
scenarios that exist, a phase with none would sail through, and the hook would make things worse
by lending it authority it had not earned. So a requirement with no covering scenario makes the
phase unverified, by name, and a phase declaring no requirements at all is not verified either.

To wire it into `/gsd:validate-phase`, call `validatePhase` with the phase's requirement IDs from
`.planning/ROADMAP.md` and refuse to write the verified marker unless `verdict.verified` is true.

## Status

| Requirement | State |
| --- | --- |
| INTEG-01, AtoZ stage | The adapter is built and tested. Mounting is a three change diff in AtoZ, not yet made |
| INTEG-02, mobile track | Prepared. The decision is AtoZ's |
| INTEG-03, GSD hook | The hook is built and tested. Wiring it into the command is not yet done |

Nothing here has been run inside AtoZ or GSD. The contracts are asserted against the shapes those
projects use today, which is a good substitute for a live mount and not the same thing.

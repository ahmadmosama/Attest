# Scenario Generation

Generation authors scenarios. It never runs them, and nothing it produces can gate a merge until
somebody promoted it on purpose.

## Two binaries, not two subcommands

```bash
attest            # run, selfcheck
attest-generate   # from-spec, promote
```

That split is not cosmetic. RUN-02 says execution performs zero LLM calls, and
`tools/check-import-boundary.mjs` proves it by refusing any import edge from the runtime into
`src/generate`. Generation may use a model. The runner cannot, because the process that runs
scenarios never loads the generator at all.

This design was arrived at the hard way: the first version added `attest generate` as a subcommand
and the boundary check refused it, naming all three edges. The rule was right.

## Prose never becomes steps

The rule that shapes everything: **a candidate that cannot be grounded in a stated requirement is
not emitted.** It is reported as ungrounded.

A spec states requirements in prose, and declares what one *means* in a fenced block:

````markdown
- [ ] **CHK-001**: A guest can place an order without an account

```attest
# requirement: CHK-001
steps:
  - open: screen:checkout
  - tap: button:place_order
  - expect_visible: state:order_confirmed
```
````

That block is the only thing generation will turn into a scenario. `CHK-002`, stated only in
prose, is reported uncovered, every time:

```text
ungrounded CHK-002 no_declared_scenario
```

This is deliberately a smaller generator than "read the spec and write the tests". A scenario
invented from prose asserts a guess, and a scenario that asserts current behaviour is a test that
can never fail for the right reason. Both lock in whatever the app does today, including the bug
you were about to find.

## Everything emitted compiles first

Each block goes through the real Phase 1 compiler before it is written. A block that does not
compile is rejected with its diagnostics and never lands on disk, because a generated file that
does not compile looks like coverage and is not.

## The uncovered report is the product

```bash
attest-generate from-spec --spec ".planning/**/*.md" --scenarios "scenarios/**/*.attest.yaml"
```

```text
proposed spec.chk_001 covers CHK-001
ungrounded CHK-002 no_declared_scenario
requirements: 2 stated, 1 covered, 1 uncovered
  uncovered CHK-002: The cart badge shows the number of items
Nothing generated gates anything yet. Review, then `attest promote`.
```

Three things are reported, all deterministically ordered so the report diffs cleanly:

- **covered**, with the scenarios covering each requirement
- **uncovered**, with the sentence the spec used
- **unknown**, a scenario claiming a requirement no spec states. Either the spec moved and the
  scenario did not, or the ID is a typo, and both matter: a scenario linked to nothing proves
  nothing.

`--require-full-coverage` turns a gap into a non zero exit, so it can gate rather than inform.

## Quarantine, three layers

A generated scenario cannot gate anything until it is promoted. One layer would not be enough:

1. The default `scenariosGlob` does not reach `scenarios/proposed/`.
2. Every proposal carries `proposed: true` **in the file**, which is part of the scenario schema
   and the IR. A proposal copied elsewhere is still a proposal.
3. The runner refuses any scenario carrying it, wherever it is found:

```text
E_SCENARIO_PROPOSED  A proposed scenario cannot be run until it is promoted
Remediation: Review it, then run `attest promote <file>`. A generated scenario that gates a
merge before anyone read it is worse than no scenario.
```

Layer 2 exists because quarantine by path alone is quarantine somebody can undo with a copy.

## Promotion is a deliberate act

```bash
attest-generate promote scenarios/proposed/spec.chk_001.attest.yaml --requirement CHK-001
```

It refuses a proposal that does not compile, refuses one that names no requirement, removes the
marker, and moves the file out of `proposed/`. Both the marker removal and the move show up in a
diff a reviewer reads. A bulk flag that turned every proposal into a gate would make "reviewed"
indistinguishable from "not yet looked at".

## Not implemented: crawl driven generation

GEN-03, generating by crawling a running app, is not built. The quarantine and promotion machinery
it needs is, and is tested, so a crawler drops into an existing safety net rather than needing one
built around it.

What is missing: driving the web adapter within a step budget, refusing destructive looking
actions, and emitting ungrounded assertions commented out with a review report rather than
asserted.

Generation is also not yet scored against the Phase 4 mutant corpus. The plan is explicit that it
should be evaluated by whether generated scenarios kill seeded mutants, not by whether the output
looks reasonable.

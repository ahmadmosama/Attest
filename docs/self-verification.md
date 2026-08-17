# Self Verification

Self verification measures whether Attest catches a shipped corpus of seeded bugs in the
fixture app. The result is a kill rate:

- killed: the mutated fixture produced a scenario failure attributed to the requirement the
  mutant says should catch it.
- survived: the mutated fixture still passed.
- errored: the run failed for harness or attribution reasons, so it is reported separately.

Errors are never counted as kills. Counting an errored mutant as killed would hide an
unstable harness behind a better looking number. A nonzero error count degrades confidence
because the corpus was not fully scored.

The rate is evidence about this corpus and nothing more. It says Attest catches these
seeded bugs in this fixture app with these rules. It does not say Attest catches all bugs,
all database errors, or all ways the rule engine could be weakened.

## Known Survivor

The corpus intentionally includes `survivor_create_audit_detail`. That mutant changes the
detail payload on a derived audit row, and the current rule proves bounded audit cardinality
rather than validating every derived payload column.

Keeping the survivor is more honest than curating the corpus to 100 percent. The recorded
rate shows both what the gate catches and where the current blind spot is.

## Adding A Mutant

Add mutants in `fixtures/self-verify/corpus.yaml`. Each mutant must declare:

- `id`, a stable unique name.
- `kind`, the class of seeded bug.
- `file`, the fixture file to edit.
- `find`, exactly one clean fixture snippet.
- `replace`, the mutated snippet.
- `seeds`, a plain description of the bug.
- `caught_by`, the requirement that should catch the bug.
- `note`, review context for why the mutant belongs in the corpus.

`caught_by` is mandatory because a failure is not enough. The runner must prove the failure
is attributable to the contract that the mutant was designed to exercise. Without that link,
a mutant could be counted as killed by an unrelated crash.

## Moving The Baseline

Run `attest selfcheck` to print the current killed, survived, errored, rate, corpus hash,
ruleset hash, and fixture tree hash.

The baseline file does not update during a normal run. To move it, run selfcheck with the
update-baseline option after reviewing the result. The command prints the old and new rate,
and it requires the baseline scenario to pass, the fixture to restore, and the run to have
zero errored mutants.

Moving the baseline is a reviewable act. A rate drop should be treated as a real regression
unless the corpus or fixture changed deliberately and the new number is accepted.

## Hash Mismatches

The baseline records three hashes:

- corpus hash: the mutant list and expected catch requirements.
- ruleset hash: the self verification suppression rules.
- fixture tree hash: the shipped fixture app files.

A corpus hash mismatch means the comparison is not like for like. The current rate may be
useful as a fresh measurement, but it is not a regression comparison against the old corpus.
The same is true for ruleset and fixture tree changes: the measured behavior came from a
different contract.

When a hash changes deliberately, review the changed corpus, rules, or fixture behavior,
run selfcheck, and move the baseline with the update-baseline option in the same change.

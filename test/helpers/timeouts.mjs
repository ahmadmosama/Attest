// Web step budgets in this suite are dev-box numbers, small on purpose: a hung
// locator should fail a test in a second rather than a minute.
//
// On 2026-08-20 three web tests timed out on windows-latest while ubuntu passed
// the same commit, and two of the three were driving a LOCAL server on
// 127.0.0.1, so no network was involved. A re-run of that exact SHA went green.
// That is what a margin problem looks like, not a regression: the runner
// launches Chrome under contention with a second test file and a local
// PostgreSQL, and a budget tuned for a dev box has nothing left over.
//
// So the host says how slow it is, exactly the way it already does for
// PostgreSQL via ATTEST_PG_STATEMENT_TIMEOUT_MS, rather than every developer
// paying the slowest runner's budget on every run.
//
// This is a FLOOR, never a cap. A test that asks for more than the floor keeps
// what it asked for, so the knob can only ever buy patience, never take it away
// from a test that deliberately asked for a long one.

const ENV_KEY = "ATTEST_WEB_STEP_TIMEOUT_MS";

export function webStepTimeoutFloorMs(env = process.env) {
  const raw = env[ENV_KEY];
  if (raw === undefined || raw === "") {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `${ENV_KEY} must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}`
    );
  }

  return parsed;
}

export function webStepTimeoutMs(devBoxMs, env = process.env) {
  return Math.max(devBoxMs, webStepTimeoutFloorMs(env));
}

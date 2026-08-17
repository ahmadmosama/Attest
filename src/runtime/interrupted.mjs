import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import { cleanup } from "./cleanup.mjs";

/**
 * The in-progress marker, and the interrupted verdict.
 *
 * `run.json` is written once, at the very end of the suite. That is correct for
 * the happy path and useless for an interrupted one: kill the process at step
 * four of sixty and the run directory has evidence in it and no record at all,
 * so the pipeline stage that "reads run.json, never the HTML" gets nothing.
 *
 * Nothing is not a safe answer here. A stage reading an absent file has to
 * guess, and both guesses are wrong: treating it as a pass ships unverified
 * code, treating it as a failure blames the app for the operator's Ctrl-C. So
 * an interrupted run says so, by name, with a third status.
 *
 * The marker is written when the suite starts and REPLACED by the real record
 * when it finishes, so it exists only for exactly as long as the run is
 * genuinely in progress.
 */

export const RUN_STATUS = Object.freeze({
  inProgress: "in_progress",
  interrupted: "interrupted"
});

async function writeAtomic(target, text) {
  const tempPath = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;

  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(tempPath, text);
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function marker({ runId, artifactDir, startedAt, status, reason, scenarios }) {
  return `${JSON.stringify(
    {
      runId,
      artifactDir,
      status,
      startedAt,
      // Deliberately shaped like the real record's counts, so a reader that
      // already knows run.json does not need a second parser to find out that
      // this run has no verdict.
      counts: { passed: 0, failed: 0, skipped: 0, infra_error: 0 },
      interrupted: status === RUN_STATUS.interrupted,
      reason: reason ?? null,
      scenariosCompleted: scenarios ?? 0,
      note:
        status === RUN_STATUS.interrupted
          ? "This run was interrupted before it produced a verdict. It is neither a pass nor a failure of the app under test."
          : "This run is still in progress. If this file is still here, the run did not finish."
    },
    null,
    2
  )}\n`;
}

/**
 * Claim the run directory, and register the interrupted verdict.
 *
 * Returns a handle: `complete()` when the suite writes the real record (which
 * releases the disposer, because there is now a verdict and overwriting it with
 * "interrupted" would destroy the answer), `count()` to keep the marker's
 * progress roughly current.
 */
export function markRunInProgress({ runId, artifactDir, startedAt, writeFile: write = writeAtomic } = {}) {
  const target = path.join(artifactDir, "run.json");
  let completed = false;
  let scenarios = 0;

  const written = write(
    target,
    marker({ runId, artifactDir, startedAt, status: RUN_STATUS.inProgress, scenarios: 0 })
  ).catch(() => {
    // A run directory that cannot be written is a real problem, but it is the
    // suite's problem to report. Failing to place a marker must not be the
    // thing that takes the run down.
  });

  const handle = cleanup.register(`run-record:${runId}`, async (reason) => {
    if (completed) {
      return;
    }

    await written;
    await write(
      target,
      marker({ runId, artifactDir, startedAt, status: RUN_STATUS.interrupted, reason, scenarios })
    );
  });

  return Object.freeze({
    count(completedScenarios) {
      scenarios = completedScenarios;
    },

    complete() {
      // The suite has written a real verdict. Release rather than dispose: the
      // marker's job is over, and running the disposer now would overwrite the
      // answer with "interrupted".
      completed = true;
      handle.release();
    },

    async ready() {
      await written;
    }
  });
}

/**
 * Read a run record and say whether it is a verdict.
 *
 * The pipeline stage's guard. `in_progress` and `interrupted` are both "no
 * verdict", and the caller must block on them rather than passing.
 */
export function isVerdict(record) {
  const status = record?.status;
  return status !== RUN_STATUS.inProgress && status !== RUN_STATUS.interrupted && record?.interrupted !== true;
}

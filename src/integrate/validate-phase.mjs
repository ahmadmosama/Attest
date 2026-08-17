import { AttestError } from "../errors.mjs";

/**
 * The GSD hook: a phase cannot be marked verified while its scenarios fail, or
 * while it has none.
 *
 * The second half is the one that matters. Today a phase is marked verified
 * because somebody read the plan and agreed. If Attest only reported on the
 * scenarios that exist, a phase with no scenarios at all would sail through,
 * and the hook would make things worse by lending it authority.
 *
 * So silence is never success: a requirement with no covering scenario makes
 * the phase unverified, by name.
 */

function invalid(reason, details = {}) {
  return new AttestError("E_VALIDATE_PHASE_INVALID", "Could not validate the phase", { reason, ...details });
}

function assertStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid("not_a_string_array", { field });
  }

  return value;
}

function coveringScenarios(scenarios, requirementId) {
  return scenarios.filter((scenario) => (scenario.requirements ?? []).includes(requirementId));
}

function verdictFor({ requirements, scenarios }) {
  const uncovered = [];
  const failing = [];

  for (const requirementId of requirements) {
    const covering = coveringScenarios(scenarios, requirementId);

    if (covering.length === 0) {
      uncovered.push(requirementId);
      continue;
    }

    for (const scenario of covering.filter((item) => item.result !== "passed")) {
      failing.push(
        Object.freeze({
          requirement: requirementId,
          scenarioId: scenario.id,
          surface: scenario.surface,
          result: scenario.result,
          code: scenario.error?.code ?? null,
          // The step, so the reader is not sent back to the report to find out
          // which one. DELTA-04's habit, applied to the hook.
          step: scenario.steps?.find((step) => step.status === "failed" || step.status === "timed_out")?.index ?? null
        })
      );
    }
  }

  return Object.freeze({ uncovered: Object.freeze(uncovered), failing: Object.freeze(failing) });
}

export function renderVerdict(verdict) {
  if (verdict.verified) {
    return `phase ${verdict.phase} verified: ${verdict.requirements.length} requirement(s), all covered and passing\n`;
  }

  const lines = [`phase ${verdict.phase} NOT verified`];

  for (const requirementId of verdict.uncovered) {
    // Named, because "no scenario covers this" is a different problem from "a
    // scenario failed" and needs a different fix.
    lines.push(`  uncovered ${requirementId}: no scenario covers this requirement`);
  }

  for (const failure of verdict.failing) {
    lines.push(
      `  failing ${failure.requirement}: ${failure.scenarioId} [${failure.surface}] ${failure.result}` +
        `${failure.step === null ? "" : ` at step ${failure.step}`}${failure.code === null ? "" : ` ${failure.code}`}`
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Validate one phase.
 *
 * `runScenarios` is injected: it takes the requirement IDs and returns the
 * scenario results covering them. That keeps this module a decision function,
 * assertable without running anything.
 */
export async function validatePhase({ phase, requirements, runScenarios, signal } = {}) {
  if (typeof phase !== "string" || phase.length === 0) {
    throw invalid("missing_phase");
  }

  assertStringArray(requirements, "requirements");

  if (requirements.length === 0) {
    // A phase that claims no requirements cannot be verified by evidence, and
    // saying "verified" would be the exact false authority this hook exists to
    // avoid lending.
    return Object.freeze({
      phase,
      verified: false,
      requirements: Object.freeze([]),
      uncovered: Object.freeze([]),
      failing: Object.freeze([]),
      reason: "no_requirements_declared"
    });
  }

  if (typeof runScenarios !== "function") {
    throw invalid("missing_runner", {
      remediation: "Pass runScenarios, which takes the requirement IDs and returns the covering scenario results."
    });
  }

  const scenarios = (await runScenarios({ requirements, signal })) ?? [];
  const { uncovered, failing } = verdictFor({ requirements, scenarios: Array.isArray(scenarios) ? scenarios : [] });

  return Object.freeze({
    phase,
    verified: uncovered.length === 0 && failing.length === 0,
    requirements: Object.freeze([...requirements]),
    uncovered,
    failing,
    reason: uncovered.length > 0 ? "uncovered_requirements" : failing.length > 0 ? "failing_scenarios" : null
  });
}

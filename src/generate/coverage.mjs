import { AttestError } from "../errors.mjs";
import { isRequirementId } from "./spec/parse.mjs";

/**
 * Which requirements have a covering scenario, and which do not.
 *
 * This is the actual product of spec driven generation. A generator that writes
 * plausible files and cannot say what is still uncovered has not helped: the
 * gap is the thing a reviewer needs, and it has to be named rather than
 * implied.
 */

function coverageError(reason, details = {}) {
  return new AttestError("E_COVERAGE_INVALID", "Could not compute requirement coverage", { reason, ...details });
}

function assertArray(value, field) {
  if (!Array.isArray(value)) {
    throw coverageError("not_an_array", { field });
  }

  return value;
}

function requirementIdsOf(scenario) {
  const declared = scenario?.requirement ?? scenario?.requirements ?? [];
  const list = Array.isArray(declared) ? declared : [declared];

  return list.filter((id) => isRequirementId(id));
}

/**
 * @param requirements  every requirement the specs state
 * @param scenarios     every scenario, each with its declared requirement IDs
 */
export function computeRequirementCoverage({ requirements = [], scenarios = [] } = {}) {
  assertArray(requirements, "requirements");
  assertArray(scenarios, "scenarios");

  const stated = new Map(
    requirements.map((requirement) => [
      typeof requirement === "string" ? requirement : requirement.id,
      typeof requirement === "string" ? { id: requirement, statement: null } : requirement
    ])
  );

  const coveredBy = new Map();
  const unknown = new Map();

  for (const scenario of scenarios) {
    const id = scenario?.id ?? null;

    for (const requirementId of requirementIdsOf(scenario)) {
      if (!stated.has(requirementId)) {
        // A scenario claiming a requirement no spec states. Either the spec
        // moved and the scenario did not, or the ID is a typo. Both are worth
        // seeing: a scenario linked to nothing proves nothing about the spec.
        unknown.set(requirementId, [...(unknown.get(requirementId) ?? []), id].toSorted());
        continue;
      }

      coveredBy.set(requirementId, [...(coveredBy.get(requirementId) ?? []), id].toSorted());
    }
  }

  const covered = [...coveredBy.keys()].toSorted();
  const uncovered = [...stated.keys()].filter((id) => !coveredBy.has(id)).toSorted();

  return Object.freeze({
    // Deterministic ordering throughout, so the report diffs cleanly in review.
    covered: Object.freeze(covered),
    uncovered: Object.freeze(
      uncovered.map((id) =>
        Object.freeze({ id, statement: stated.get(id).statement ?? null, file: stated.get(id).file ?? null })
      )
    ),
    unknown: Object.freeze(
      [...unknown.keys()].toSorted().map((id) => Object.freeze({ id, scenarios: Object.freeze(unknown.get(id)) }))
    ),
    byRequirement: Object.freeze(
      Object.fromEntries(covered.map((id) => [id, Object.freeze([...new Set(coveredBy.get(id))])]))
    ),
    counts: Object.freeze({
      stated: stated.size,
      covered: covered.length,
      uncovered: uncovered.length,
      unknown: unknown.size
    })
  });
}

export function renderCoverageReport(coverage) {
  const lines = [
    `requirements: ${coverage.counts.stated} stated, ${coverage.counts.covered} covered, ${coverage.counts.uncovered} uncovered`
  ];

  for (const entry of coverage.uncovered) {
    lines.push(`  uncovered ${entry.id}${entry.statement === null ? "" : `: ${entry.statement}`}`);
  }

  for (const entry of coverage.unknown) {
    lines.push(`  unknown ${entry.id} claimed by ${entry.scenarios.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

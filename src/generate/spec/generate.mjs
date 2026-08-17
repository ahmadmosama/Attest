import { AttestError } from "../../errors.mjs";
import { compileScenarioText } from "../../ir/compile.mjs";
import { computeRequirementCoverage } from "../coverage.mjs";
import { parseSpec } from "./parse.mjs";

/**
 * Turn declared intent into proposed scenarios.
 *
 * The rule that shapes everything here: a candidate that cannot be grounded in
 * a stated requirement is NOT emitted. It is reported as ungrounded. Emitting
 * it anyway would be recording behaviour and calling it intent, which is the
 * failure GEN-05 exists to prevent, and a scenario that asserts current
 * behaviour is a test that can never fail for the right reason.
 *
 * Everything emitted is validated through the real Phase 1 compiler before it
 * is written. A generator that produces files which do not compile has not
 * produced scenarios, it has produced work.
 */

const PROPOSED_MARKER = "proposed: true";

function generateError(reason, details = {}) {
  return new AttestError("E_GENERATE_INVALID", "Could not generate scenarios from the spec", {
    reason,
    ...details
  });
}

function scenarioIdFor(block, index) {
  const first = block.requirements[0];
  const slug = (first ?? `block_${index}`).toLowerCase().replaceAll("-", "_");
  return `spec.${slug}`;
}

function requirementList(requirements) {
  return `[${requirements.join(", ")}]`;
}

/**
 * Assemble the scenario text.
 *
 * `proposed: true` is written into the file itself, not only into its path. A
 * proposed scenario that is copied somewhere else is still proposed, and the
 * runner refuses it wherever it finds it.
 */
export function renderScenario({ id, requirements, body, source }) {
  return [
    `id: ${id}`,
    `requirement: ${requirementList(requirements)}`,
    PROPOSED_MARKER,
    `# generated from ${source.file}:${source.startLine}`,
    "# Review before promoting. `attest promote` is what makes this gate anything.",
    body,
    ""
  ].join("\n");
}

function compileOrReject(text, { id, source }) {
  const compiled = compileScenarioText(text, { file: `${source.file}#${source.startLine}` });

  if (compiled.diagnostics?.ok !== true) {
    // Never written. A generated file that does not compile is worse than no
    // file: it looks like coverage and is not.
    return Object.freeze({
      ok: false,
      id,
      source,
      reason: "does_not_compile",
      diagnostics: Object.freeze(
        (compiled.diagnostics?.errors ?? []).map((entry) =>
          Object.freeze({ code: entry.code, message: entry.message, line: entry.pos?.line ?? null })
        )
      )
    });
  }

  return Object.freeze({ ok: true, id, source, text, ir: compiled.ir });
}

/**
 * Generate from one already parsed spec document.
 */
export function generateFromSpec(text, { file = "spec.md" } = {}) {
  const spec = parseSpec(text, { file });
  const emitted = [];
  const ungrounded = [];
  const rejected = [];

  spec.blocks.forEach((block, index) => {
    if (block.requirements.length === 0) {
      // Declared steps with no requirement is exactly the thing GEN-01 forbids:
      // a scenario nobody can trace back to a stated intent.
      ungrounded.push(
        Object.freeze({
          file: block.file,
          startLine: block.startLine,
          reason: "no_requirement_declared",
          remediation: "Add a `# requirement: ID` line as the first line of the attest block."
        })
      );
      return;
    }

    const id = scenarioIdFor(block, index);
    const rendered = renderScenario({
      id,
      requirements: block.requirements,
      body: block.body,
      source: block
    });
    const compiled = compileOrReject(rendered, { id, source: block });

    if (compiled.ok) {
      emitted.push(compiled);
    } else {
      rejected.push(compiled);
    }
  });

  // A requirement stated in prose with no attest block is the normal case, and
  // the honest output for it is "uncovered", never an invented scenario.
  const covered = new Set(emitted.flatMap((entry) => entry.ir.requirements ?? []));
  for (const requirement of spec.requirements) {
    if (!covered.has(requirement.id)) {
      ungrounded.push(
        Object.freeze({
          file: requirement.file,
          startLine: requirement.line,
          requirement: requirement.id,
          reason: "no_declared_scenario",
          statement: requirement.statement,
          remediation:
            "State the steps this requirement means in an ```attest block in the spec, or write the scenario by hand. Attest will not invent steps from prose."
        })
      );
    }
  }

  return Object.freeze({
    file,
    requirements: spec.requirements,
    scenarios: Object.freeze(emitted),
    ungrounded: Object.freeze(ungrounded),
    rejected: Object.freeze(rejected),
    danglingLinks: spec.danglingLinks
  });
}

/**
 * Generate across several documents and report coverage over all of them.
 */
export function generateFromSpecs(documents = [], { existingScenarios = [] } = {}) {
  if (!Array.isArray(documents)) {
    throw generateError("documents_not_array");
  }

  const results = documents.map((document) =>
    generateFromSpec(document.text, { file: document.file ?? "spec.md" })
  );

  const requirements = results.flatMap((result) => result.requirements);
  const generated = results.flatMap((result) =>
    result.scenarios.map((scenario) => ({ id: scenario.id, requirement: scenario.ir.requirements }))
  );

  return Object.freeze({
    scenarios: Object.freeze(results.flatMap((result) => result.scenarios)),
    ungrounded: Object.freeze(results.flatMap((result) => result.ungrounded)),
    rejected: Object.freeze(results.flatMap((result) => result.rejected)),
    danglingLinks: Object.freeze(results.flatMap((result) => result.danglingLinks)),
    coverage: computeRequirementCoverage({
      requirements,
      scenarios: [...existingScenarios, ...generated]
    })
  });
}

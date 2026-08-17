import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { AttestError, UsageError } from "../errors.mjs";
import { compileScenarioText } from "../ir/compile.mjs";
import { isRequirementId } from "./spec/parse.mjs";

/**
 * Promotion: the deliberate act that turns a proposal into something that can
 * gate a merge.
 *
 * Three things have to be true before a generated scenario is allowed to fail
 * a build, and promotion is where each is checked:
 *
 *   it compiles           a file that does not compile is not a scenario
 *   it names a requirement  a scenario linked to nothing proves nothing
 *   somebody ran this     the marker removal shows up in a diff a reviewer reads
 *
 * The alternative, a flag that turns proposals into gates in bulk, would make
 * "reviewed" indistinguishable from "not yet looked at".
 */

const PROPOSED_LINE_RE = /^proposed:\s*true\s*$/mu;
const REQUIREMENT_LINE_RE = /^requirement:\s*\[(.*)\]\s*$/mu;

function promoteError(code, message, details = {}) {
  return new UsageError(code, message, details);
}

export function isProposedText(text) {
  return PROPOSED_LINE_RE.test(text);
}

/**
 * Remove the marker and, when asked, add a requirement the proposal lacked.
 *
 * Pure, so the rules are assertable without touching a filesystem.
 */
export function promoteText(text, { requirement = null, file = "scenario.attest.yaml" } = {}) {
  if (typeof text !== "string") {
    throw promoteError("E_PROMOTE_INVALID", "Scenario text is required", { file });
  }

  if (!isProposedText(text)) {
    throw promoteError("E_PROMOTE_NOT_PROPOSED", "This scenario is not a proposal", {
      file,
      remediation: "Only a scenario carrying `proposed: true` can be promoted. This one already gates."
    });
  }

  const withRequirement =
    requirement === null
      ? text
      : text.replace(REQUIREMENT_LINE_RE, `requirement: [${[requirement].flat().join(", ")}]`);

  const promoted = withRequirement
    .split(/\r?\n/u)
    .filter((line) => !PROPOSED_LINE_RE.test(line))
    .join("\n");

  const compiled = compileScenarioText(promoted, { file });
  if (compiled.diagnostics?.ok !== true) {
    // Refused rather than written. Promoting a scenario that does not compile
    // would put a permanently red gate into the suite.
    throw promoteError("E_PROMOTE_DOES_NOT_COMPILE", "The promoted scenario does not compile", {
      file,
      diagnostics: (compiled.diagnostics?.errors ?? []).map((entry) =>
        Object.freeze({ code: entry.code, reason: entry.reason ?? entry.message ?? null })
      )
    });
  }

  const requirements = compiled.ir.requirements ?? [];
  if (requirements.length === 0 || !requirements.every((id) => isRequirementId(id))) {
    throw promoteError("E_PROMOTE_NO_REQUIREMENT", "A promoted scenario must name the requirement it covers", {
      file,
      requirements,
      remediation: "Pass --requirement <ID>, or add one to the scenario. A scenario linked to nothing proves nothing."
    });
  }

  return Object.freeze({ text: promoted, id: compiled.ir.id, requirements: Object.freeze([...requirements]) });
}

function destinationFor(file, outDir) {
  if (outDir !== null && outDir !== undefined) {
    return path.join(outDir, path.basename(file));
  }

  // Out of the proposed directory and into the suite beside it, so the move
  // itself is visible in a diff.
  const parent = path.dirname(file);
  return path.basename(parent) === "proposed"
    ? path.join(path.dirname(parent), path.basename(file))
    : file;
}

export async function promoteScenarioFile(file, { requirement = null, outDir = null, move = true } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new AttestError("E_PROMOTE_UNREADABLE", "Could not read the proposed scenario", {
      file,
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  const promoted = promoteText(text, { requirement, file });
  const destination = move ? destinationFor(file, outDir) : file;

  await writeFile(file, promoted.text, "utf8");
  if (destination !== file) {
    await rename(file, destination);
  }

  return Object.freeze({
    ok: true,
    id: promoted.id,
    requirements: promoted.requirements,
    from: file,
    to: destination
  });
}

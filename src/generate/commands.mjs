import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { glob } from "tinyglobby";

import { EXIT } from "../cli/exit-codes.mjs";
import { UsageError } from "../errors.mjs";
import { renderCoverageReport } from "./coverage.mjs";
import { generateFromSpecs } from "./spec/generate.mjs";
import { promoteScenarioFile } from "./promote.mjs";

const DEFAULT_PROPOSED_DIR = path.join("scenarios", "proposed");

function formatError(error) {
  const remediation =
    typeof error?.details?.remediation === "string" ? `
Remediation: ${error.details.remediation}` : "";
  return `${error.code ?? "E_HARNESS"}  ${error.message}${remediation}
`;
}

function write(stream, text) {
  stream?.write?.(text);
}

async function readSpecs(globs, cwd) {
  const files = await glob(globs, { cwd, absolute: true, onlyFiles: true });

  return Promise.all(
    files.toSorted().map(async (file) => ({
      file: path.relative(cwd, file).split(path.sep).join("/"),
      text: await readFile(file, "utf8")
    }))
  );
}

async function loadExistingScenarios(globs, cwd) {
  const { compileScenarioFile } = await import("../ir/compile.mjs");
  const files = await glob(globs, { cwd, absolute: true, onlyFiles: true });
  const scenarios = [];

  for (const file of files.toSorted()) {
    const compiled = await compileScenarioFile(file);
    if (compiled.diagnostics?.ok === true) {
      scenarios.push({ id: compiled.ir.id, requirement: compiled.ir.requirements });
    }
  }

  return scenarios;
}

/**
 * attest generate --from-spec <glob...>
 *
 * Writes proposals, never scenarios that gate. The uncovered report is the
 * actual product: a generator that writes plausible files and cannot say what
 * is still uncovered has not helped.
 */
export async function generateCommand(flags = {}, io = {}) {
  const stdout = io.stdout;
  const stderr = io.stderr;
  const cwd = io.cwd ?? process.cwd();

  try {
    const specGlobs = flags.fromSpec ?? [];
    if (specGlobs.length === 0) {
      throw new UsageError("E_GENERATE_NO_SPEC", "Generation needs at least one spec document", {
        remediation: "Pass --from-spec <glob>, for example --from-spec '.planning/**/*.md'."
      });
    }

    const documents = await readSpecs(specGlobs, cwd);
    const existingScenarios = await loadExistingScenarios(flags.scenarios ?? [], cwd);
    const result = generateFromSpecs(documents, { existingScenarios });
    const outDir = path.resolve(cwd, flags.out ?? DEFAULT_PROPOSED_DIR);

    if (result.scenarios.length > 0) {
      await mkdir(outDir, { recursive: true });
    }

    for (const scenario of result.scenarios) {
      await writeFile(path.join(outDir, `${scenario.id}.attest.yaml`), scenario.text, "utf8");
      write(stdout, `proposed ${scenario.id} covers ${scenario.ir.requirements.join(", ")}\n`);
    }

    for (const entry of result.ungrounded) {
      write(stdout, `ungrounded ${entry.requirement ?? `${entry.file}:${entry.startLine}`} ${entry.reason}\n`);
    }

    for (const entry of result.rejected) {
      write(stderr, `rejected ${entry.id} does not compile: ${entry.diagnostics.map((d) => d.code).join(", ")}\n`);
    }

    for (const entry of result.danglingLinks) {
      write(stderr, `dangling requirement link ${entry.id}\n`);
    }

    write(stdout, renderCoverageReport(result.coverage));

    if (result.scenarios.length > 0) {
      write(stdout, `Nothing generated gates anything yet. Review, then \`attest promote\`.\n`);
    }

    // Full coverage can be demanded, and then the gap is a failure rather than
    // a line somebody scrolled past.
    if (flags.requireFullCoverage === true && result.coverage.counts.uncovered > 0) {
      return EXIT.SCENARIO_FAILURE;
    }

    return result.rejected.length > 0 ? EXIT.USAGE_ERROR : EXIT.PASS;
  } catch (error) {
    write(stderr, formatError(error));
    return error instanceof UsageError ? EXIT.USAGE_ERROR : EXIT.HARNESS_ERROR;
  }
}

/**
 * attest promote <file> [--requirement ID]
 */
export async function promoteCommand(flags = {}, io = {}) {
  const stdout = io.stdout;
  const stderr = io.stderr;
  const cwd = io.cwd ?? process.cwd();

  try {
    if (typeof flags.file !== "string" || flags.file.length === 0) {
      throw new UsageError("E_PROMOTE_NO_FILE", "Promotion needs the proposed scenario file", {});
    }

    const result = await promoteScenarioFile(path.resolve(cwd, flags.file), {
      requirement: flags.requirement ?? null,
      outDir: flags.out === undefined ? null : path.resolve(cwd, flags.out)
    });

    write(stdout, `promoted ${result.id} covering ${result.requirements.join(", ")}\n`);
    write(stdout, `  ${path.relative(cwd, result.from)} -> ${path.relative(cwd, result.to)}\n`);
    return EXIT.PASS;
  } catch (error) {
    write(stderr, formatError(error));
    return error instanceof UsageError ? EXIT.USAGE_ERROR : EXIT.HARNESS_ERROR;
  }
}

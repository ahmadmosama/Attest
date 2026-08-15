import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import stableStringify from "json-stable-stringify";

import { createBundle } from "../../evidence/bundle.mjs";
import { UsageError } from "../../errors.mjs";
import { compileScenarioFile } from "../../ir/compile.mjs";
import { formatDiagnostic } from "../../ir/diagnostics.mjs";
import { loadBindings } from "../../bindings/load.mjs";
import { lintBindings } from "../../bindings/lint.mjs";
import { defineSurfaceCapabilities } from "../../capabilities/surface-caps.mjs";
import { NOT_IMPLEMENTED_DB_CAPS } from "../../capabilities/db-caps.mjs";
import { lower } from "../../lower/lower.mjs";
import { runSuite } from "../../runtime/suite.mjs";
import { createFakeSurface } from "../../surfaces/fake/adapter.mjs";
import { defineScript } from "../../surfaces/fake/script.mjs";
import { renderConsoleSummary } from "../../report/console.mjs";
import { toJUnitXml } from "../../report/junit.mjs";
import { computeCoverage } from "../../report/coverage.mjs";
import { EXIT } from "../exit-codes.mjs";
import { discoverScenarios, applyFilters } from "../discover.mjs";
import { classifyAppArtifact } from "../../config/app-artifact.mjs";
import { resolveConfig } from "../../config/resolve.mjs";

const BASE_SURFACE_SUPPORTS = Object.freeze(["raw_escape"]);

function write(stream, text) {
  stream?.write?.(text);
}

function nowFn(io) {
  return typeof io?.now === "function" ? io.now : () => new Date();
}

function refsUsed(irs) {
  return [...new Set(irs.flatMap((ir) => ir.refs))].toSorted();
}

function stableJson(value) {
  const text = stableStringify(value, { space: 2 });
  if (typeof text !== "string") {
    throw new UsageError("E_BAD_ARTIFACT_JSON", "Artifact JSON value is not serializable", {
      reason: "json_stringify_returned_empty"
    });
  }
  return `${text}\n`;
}

function formatError(error) {
  return `${error.code ?? "E_HARNESS"}  ${error.message}\n`;
}

function scenarioRecordFromIr(ir, surfaces) {
  return Object.freeze({
    id: ir.id,
    tags: ir.tags,
    surfaces,
    ir
  });
}

async function declaredRequirementsFromFile(file, cwd) {
  if (file === undefined) {
    return null;
  }

  const resolved = resolveFromCwd(cwd, file);
  const text = await readFile(resolved, "utf8");
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return Object.freeze([]);
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new UsageError("E_REQUIREMENTS_INVALID", "Requirements JSON must be an array of IDs", {
        file: resolved
      });
    }
    return Object.freeze([...new Set(parsed)].toSorted());
  }

  return Object.freeze(
    [
      ...new Set(
        text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"))
      )
    ].toSorted()
  );
}

async function compileScenarios(files, stderr) {
  const compiled = [];
  const diagnostics = [];

  for (const file of files) {
    const result = await compileScenarioFile(file);
    diagnostics.push(...result.diagnostics.errors);
    if (result.ir !== null) {
      compiled.push(result.ir);
    }
  }

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      write(stderr, `${formatDiagnostic(diagnostic)}\n`);
    }
    return { kind: "error" };
  }

  return { kind: "ok", irs: compiled };
}

function resolveFromCwd(cwd, value) {
  if (typeof value !== "string" || path.isAbsolute(value)) {
    return value;
  }
  return path.join(cwd, value);
}

async function loadBindingsBySurface({ dir, app, surfaces }) {
  const entries = [];
  for (const surface of surfaces) {
    entries.push([surface, await loadBindings({ dir, app, surface })]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

async function bindingAppName(dir, surfaces) {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  if (candidates.length === 1) {
    return candidates[0];
  }

  const scored = [];
  for (const appName of candidates) {
    const files = await readdir(path.join(dir, appName));
    if (surfaces.every((surface) => files.includes(`${surface}.yaml`))) {
      scored.push({ appName, count: files.filter((file) => file.endsWith(".yaml")).length });
    }
  }
  const ordered = scored.toSorted((left, right) => right.count - left.count || left.appName.localeCompare(right.appName));
  if (ordered.length > 0 && (ordered.length === 1 || ordered[0].count > ordered[1].count)) {
    return ordered[0].appName;
  }

  throw new UsageError("E_BINDINGS_APP_REQUIRED", "Bindings directory must identify one app directory", {
    dir,
    appDirectories: candidates
  });
}

function surfaceCaps(surface) {
  return defineSurfaceCapabilities({ surface, supports: BASE_SURFACE_SUPPORTS });
}

function printDiagnostics(stderr, diagnostics) {
  for (const diagnostic of diagnostics) {
    write(stderr, `${formatDiagnostic(diagnostic)}\n`);
  }
}

function lowerSelected({ selected, bindingsBySurface, appArtifact }) {
  const plans = [];
  const skips = [];
  const errors = [];

  for (const scenario of selected) {
    for (const surface of scenario.selectedSurfaces) {
      const outcome = lower(scenario.ir, {
        surface,
        bindings: bindingsBySurface[surface],
        surfaceCaps: surfaceCaps(surface),
        dbCaps: NOT_IMPLEMENTED_DB_CAPS,
        app: appArtifact.url ?? appArtifact.path
      });

      if (outcome.kind === "plan") {
        plans.push(outcome.plan);
      } else if (outcome.kind === "skip") {
        skips.push(outcome.skip);
      } else {
        errors.push(outcome.error);
      }
    }
  }

  return { plans, skips, errors };
}

async function writePlans(bundle, plans) {
  const refs = new Map();
  for (const plan of plans) {
    const ref = await bundle.scenario(plan.scenarioId, plan.surface).writeJson("plan.json", plan);
    refs.set(`${plan.scenarioId}\u0000${plan.surface}`, ref.path);
  }
  return refs;
}

function fakeScriptFor(surface, env = {}) {
  const script = env.ATTEST_FAKE_SCRIPT === undefined ? {} : JSON.parse(env.ATTEST_FAKE_SCRIPT);
  return defineScript({ surface, unknownKind: "ok", ...script });
}

function adapterForFactory(env) {
  return (plan) => createFakeSurface(fakeScriptFor(plan.surface, env));
}

function runConfig(config, flags) {
  return Object.freeze({
    headed: Boolean(flags.headed),
    timeouts: config.timeouts,
    concurrency: config.concurrency,
    failOnSkip: config.failOnSkip,
    filters: {
      ids: flags.ids ?? [],
      tags: flags.tags ?? [],
      surfaces: config.surfaces,
      headed: Boolean(flags.headed),
      dryRun: Boolean(flags.dryRun)
    }
  });
}

function dryRunScenarioForPlan(plan, planPath) {
  return Object.freeze({
    id: plan.scenarioId,
    surface: plan.surface,
    result: "pass",
    durationMs: 0,
    requirements: [...plan.requirements],
    planHash: plan.planHash,
    planPath,
    rawOpUses: plan.rawOpCount,
    skipped: null,
    error: null,
    steps: []
  });
}

function dryRunScenarioForSkip(skip, requirementMap) {
  return Object.freeze({
    id: skip.scenarioId,
    surface: skip.surface,
    result: "skipped",
    durationMs: 0,
    requirements: [...(requirementMap.get(skip.scenarioId) ?? [])],
    planHash: "0".repeat(64),
    planPath: `skipped/${skip.scenarioId}__${skip.surface}.json`,
    rawOpUses: 0,
    skipped: Object.freeze({ capabilities: [...skip.capabilities] }),
    error: null,
    steps: []
  });
}

function countsFor(scenarios) {
  return Object.freeze({
    total: scenarios.length,
    passed: scenarios.filter((scenario) => scenario.result === "pass").length,
    failed: scenarios.filter((scenario) => scenario.result === "fail").length,
    infra_error: scenarios.filter((scenario) => scenario.result === "infra_error").length,
    skipped: scenarios.filter((scenario) => scenario.result === "skipped").length,
    quarantined: scenarios.filter((scenario) => scenario.result === "quarantined").length
  });
}

function exitCodeForDryRun({ counts, failOnSkip }) {
  if (counts.skipped > 0 && failOnSkip) {
    return EXIT.SKIPPED_AS_FAILURE;
  }
  return EXIT.PASS;
}

function statusFor(counts) {
  if (counts.infra_error > 0) {
    return "infra_error";
  }
  return counts.failed > 0 ? "fail" : "pass";
}

function rawUsesForPlans(plans) {
  return plans.flatMap((plan) =>
    plan.ops
      .filter((op) => op.kind === "raw")
      .map((op) => ({
        scenarioId: plan.scenarioId,
        surface: plan.surface,
        stepIndex: op.i,
        reason: op.reason
      }))
  );
}

function extendedRecord(record, coverage) {
  return {
    ...record,
    requirements: {
      covered: coverage.covered,
      byScenario: coverage.byScenario,
      uncovered: coverage.uncovered,
      unknown: coverage.unknown
    }
  };
}

async function rewriteRunJson(record) {
  await writeFile(path.join(record.artifactDir, "run.json"), stableJson(record));
}

async function writeDryRunRecord({ bundle, config, flags, plans, skips, planRefs, coverage, selected, now }) {
  const started = now();
  const requirementMap = new Map(selected.map((scenario) => [scenario.ir.id, scenario.ir.requirements]));
  const scenarios = [
    ...plans.map((plan) => dryRunScenarioForPlan(plan, planRefs.get(`${plan.scenarioId}\u0000${plan.surface}`))),
    ...skips.map((skip) => dryRunScenarioForSkip(skip, requirementMap))
  ];
  const counts = countsFor(scenarios);
  const exitCode = exitCodeForDryRun({ counts, failOnSkip: config.failOnSkip });
  const finished = now();
  const escapeUses = rawUsesForPlans(plans);
  const record = extendedRecord(
    {
      runRecordVersion: 1,
      runId: bundle.runId,
      startedAt: started instanceof Date ? started.toISOString() : new Date(started).toISOString(),
      finishedAt: finished instanceof Date ? finished.toISOString() : new Date(finished).toISOString(),
      durationMs: 0,
      attestVersion: "0.1.0",
      node: { version: process.version, platform: process.platform },
      status: statusFor(counts),
      exitCode,
      counts,
      filters: runConfig(config, flags).filters,
      artifactDir: bundle.dir,
      requirements: coverage,
      escapeHatch: { rawOpUses: escapeUses.length, uses: escapeUses },
      hashes: { bindings: {}, ruleset: null },
      telemetry: { timeouts: 0, retries: 0, convergeMs: [] },
      scenarios
    },
    coverage
  );

  await bundle.writeJson("run.json", record);
  return record;
}

function requirementsSummaryLine(coverage, declaredRequirements) {
  if (declaredRequirements === null) {
    return "";
  }
  return `requirements: ${coverage.covered.length} covered, ${coverage.uncovered.length} uncovered, ${coverage.unknown.length} unknown\n`;
}

async function runSuiteWithRefedEventLoop(options) {
  const keepAlive = setInterval(() => {}, 2147483647);
  try {
    return await runSuite(options);
  } finally {
    clearInterval(keepAlive);
  }
}

export async function runCommand(flags = {}, io = {}) {
  const stdout = io.stdout;
  const stderr = io.stderr;
  const env = io.env ?? {};
  const cwd = io.cwd ?? process.cwd();

  try {
    const configFlags = {
      ...(flags.artifactRoot === undefined ? {} : { artifactRoot: flags.artifactRoot }),
      ...(flags.scenariosGlob === undefined ? {} : { scenariosGlob: flags.scenariosGlob }),
      ...(flags.bindingsDir === undefined ? {} : { bindingsDir: flags.bindingsDir }),
      ...(flags.app === undefined ? {} : { app: flags.app }),
      ...(flags.surfaces === undefined ? {} : { surfaces: flags.surfaces }),
      ...(flags.timeouts === undefined ? {} : { timeouts: flags.timeouts }),
      ...(flags.failOnSkip === undefined ? {} : { failOnSkip: flags.failOnSkip }),
      ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
      ...(flags.color === undefined ? {} : { color: flags.color })
    };
    const config = resolveConfig({ file: flags.configFile ?? {}, env, flags: configFlags });
    const resolvedConfig = {
      ...config,
      artifactRoot: resolveFromCwd(cwd, config.artifactRoot),
      bindingsDir: resolveFromCwd(cwd, config.bindingsDir)
    };
    const appValue = config.app;
    if (appValue === null) {
      throw new UsageError("E_APP_REQUIRED", "An app artifact or URL is required");
    }

    const appArtifact = classifyAppArtifact(appValue);
    const surfaces = config.surfaces;
    const declaredRequirements = await declaredRequirementsFromFile(flags.requirementsFile, cwd);
    const files = await discoverScenarios({ globs: config.scenariosGlob, cwd });
    const compiled = await compileScenarios(
      files.map((file) => resolveFromCwd(cwd, file)),
      stderr
    );
    if (compiled.kind === "error") {
      return EXIT.USAGE_ERROR;
    }

    const scenarioRecords = compiled.irs.map((ir) => scenarioRecordFromIr(ir, surfaces));
    const selected = applyFilters(scenarioRecords, {
      ids: flags.ids ?? [],
      tags: flags.tags ?? [],
      surfaces
    });
    if (selected.every((scenario) => scenario.selectedSurfaces.length === 0)) {
      throw new UsageError("E_EMPTY_SCENARIO_SELECTION", "Scenario selection is empty");
    }
    const coverage = computeCoverage({
      scenarios: selected.map((scenario) => scenario.ir),
      declaredRequirements: declaredRequirements ?? []
    });

    const bindingsBySurface = await loadBindingsBySurface({
      dir: resolvedConfig.bindingsDir,
      app: await bindingAppName(resolvedConfig.bindingsDir, surfaces),
      surfaces
    });
    const lint = lintBindings({
      refsUsed: refsUsed(selected.map((scenario) => scenario.ir)),
      bindingsBySurface,
      surfaces
    });
    printDiagnostics(stderr, lint.diagnostics.errors);
    if (!lint.ok) {
      return EXIT.USAGE_ERROR;
    }

    const lowered = lowerSelected({ selected, bindingsBySurface, appArtifact });
    if (lowered.errors.length > 0) {
      for (const error of lowered.errors) {
        write(stderr, formatError(error));
      }
      return EXIT.USAGE_ERROR;
    }

    const bundle = await createBundle({ root: resolvedConfig.artifactRoot, now: nowFn(io) });

    if (flags.dryRun) {
      const planRefs = await writePlans(bundle, lowered.plans);
      const record = await writeDryRunRecord({
        bundle,
        config,
        flags,
        plans: lowered.plans,
        skips: lowered.skips,
        planRefs,
        coverage,
        selected,
        now: nowFn(io)
      });
      for (const plan of lowered.plans) {
        write(stdout, `${plan.scenarioId} [${plan.surface}] clean compile\n`);
      }
      for (const skip of lowered.skips) {
        write(stdout, `${skip.scenarioId} [${skip.surface}] skipped ${skip.capabilities.join(",")}\n`);
      }
      write(stdout, requirementsSummaryLine(coverage, declaredRequirements));
      await bundle.finalize();
      return record.exitCode;
    }

    const { record } = await runSuiteWithRefedEventLoop({
      plans: lowered.plans,
      skips: lowered.skips,
      adapterFor: io.adapterFor ?? adapterForFactory(env),
      bundle,
      config: runConfig(config, flags),
      now: nowFn(io)
    });

    const recordWithCoverage = extendedRecord(record, coverage);
    await rewriteRunJson(recordWithCoverage);
    await writeFile(path.join(record.artifactDir, "junit.xml"), toJUnitXml(record));
    write(stdout, renderConsoleSummary(record, { color: config.color }));
    write(stdout, requirementsSummaryLine(coverage, declaredRequirements));
    return record.exitCode;
  } catch (error) {
    write(stderr, formatError(error));
    return error instanceof UsageError ? EXIT.USAGE_ERROR : EXIT.HARNESS_ERROR;
  }
}

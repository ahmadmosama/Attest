import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { createBundle } from "../../evidence/bundle.mjs";
import { InfraError, UsageError } from "../../errors.mjs";
import { compileScenarioFile } from "../../ir/compile.mjs";
import { formatDiagnostic } from "../../ir/diagnostics.mjs";
import { loadBindings } from "../../bindings/load.mjs";
import { lintBindings } from "../../bindings/lint.mjs";
import { NOT_IMPLEMENTED_DB_CAPS } from "../../capabilities/db-caps.mjs";
import { describePostgresCapabilities } from "../../db/drivers/postgres/capabilities.mjs";
import { runPreflight } from "../../db/drivers/postgres/preflight.mjs";
import { createDbHooks } from "../../db/hooks.mjs";
import { createDbDriver } from "../../db/registry.mjs";
import { seedDigest } from "../../db/seed.mjs";
import { loadRuleset } from "../../delta/rules/load.mjs";
import { lower } from "../../lower/lower.mjs";
import { createExecutionPlan } from "../../lower/plan.mjs";
import { runSuite } from "../../runtime/suite.mjs";
import { createSurfaceRegistry } from "../../surfaces/registry.mjs";
import { renderConsoleSummary } from "../../report/console.mjs";
import { toJUnitXml } from "../../report/junit.mjs";
import { computeCoverage } from "../../report/coverage.mjs";
import { renderHtmlReport } from "../../report/html.mjs";
import { EXIT } from "../exit-codes.mjs";
import { discoverScenarios, applyFilters } from "../discover.mjs";
import { classifyAppArtifact } from "../../config/app-artifact.mjs";
import { resolveConfig } from "../../config/resolve.mjs";
import { describeTarget } from "../../config/targets.mjs";

function write(stream, text) {
  stream?.write?.(text);
}

function nowFn(io) {
  return typeof io?.now === "function" ? io.now : () => new Date();
}

function dependencySet(io) {
  return Object.freeze({
    runPreflight: io.dbRunPreflight ?? runPreflight,
    describePostgresCapabilities: io.describePostgresCapabilities ?? describePostgresCapabilities,
    loadRuleset: io.dbLoadRuleset ?? loadRuleset,
    createDbDriver: io.createDbDriver ?? createDbDriver,
    createDbHooks: io.createDbHooks ?? createDbHooks
  });
}

function refsUsed(irs) {
  return [...new Set(irs.flatMap((ir) => ir.refs))].toSorted();
}

function formatError(error) {
  const remediation =
    typeof error?.details?.remediation === "string"
      ? `\nRemediation: ${error.details.remediation}`
      : "";
  return `${error.code ?? "E_HARNESS"}  ${error.message}${remediation}\n`;
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

function printDiagnostics(stderr, diagnostics) {
  for (const diagnostic of diagnostics) {
    write(stderr, `${formatDiagnostic(diagnostic)}\n`);
  }
}

function lowerSelected({ selected, bindingsBySurface, appArtifact, registry, dbCaps = NOT_IMPLEMENTED_DB_CAPS }) {
  const plans = [];
  const skips = [];
  const errors = [];

  for (const scenario of selected) {
    for (const surface of scenario.selectedSurfaces) {
      const outcome = lower(scenario.ir, {
        surface,
        bindings: bindingsBySurface[surface],
        surfaceCaps: registry.descriptorFor(surface),
        dbCaps,
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

function runConfig(config, flags) {
  return Object.freeze({
    headed: Boolean(flags.headed),
    timeouts: config.timeouts,
    concurrency: config.concurrency,
    failOnSkip: config.failOnSkip,
    tenantPrefix: config.db?.tenantPrefix ?? config.tenantPrefix ?? "",
    db: config.db,
    dbCapabilities: config.dbCapabilities,
    hashes: config.hashes,
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

function schemaRecord(record) {
  return {
    ...record,
    requirements: {
      covered: record.requirements.covered,
      byScenario: record.requirements.byScenario
    }
  };
}

async function writeHtmlReport(bundle, record) {
  const html = await renderHtmlReport(record, { artifactDir: record.artifactDir });
  await bundle.write("report.html", html);
  return path.join(record.artifactDir, "report.html");
}

function reportableBundle(bundle, coverage) {
  let recordForReport = null;
  let reportPath = null;

  return {
    ...bundle,
    async writeJson(relPath, value) {
      if (relPath !== "run.json") {
        return bundle.writeJson(relPath, value);
      }

      recordForReport = extendedRecord(value, coverage);
      return bundle.writeJson(relPath, recordForReport);
    },
    async finalize() {
      if (recordForReport !== null) {
        reportPath = await writeHtmlReport(bundle, recordForReport);
      }
      return bundle.finalize();
    },
    get reportPath() {
      return reportPath;
    }
  };
}

function writeReportPath(stdout, reportPath) {
  if (typeof reportPath === "string" && reportPath.length > 0) {
    write(stdout, `HTML report: ${reportPath}\n`);
  }
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
      hashes: { bindings: {}, ruleset: config.hashes?.ruleset ?? null },
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

function dbRuntimeConfig(config, flags) {
  return Object.freeze({
    ...config.db,
    ...flags.dbRuntime
  });
}

function preflightError(error, target) {
  if (error instanceof UsageError) {
    return error;
  }

  const details = {
    ...error?.details,
    host: target?.host ?? error?.details?.host ?? null,
    database: target?.database ?? error?.details?.database ?? null,
    port: target?.port ?? error?.details?.port ?? null,
    remediation: "Verify the target is reachable on the direct database port and that ATTEST_DB_URL credentials are valid."
  };

  return new InfraError(
    error?.code ?? "E_DB_PREFLIGHT_FAILED",
    error instanceof Error ? error.message : "Database preflight failed.",
    details
  );
}

async function probeDbCapabilities({ config, flags, deps }) {
  const target = config.db?.target ?? null;
  if (target === null) {
    return NOT_IMPLEMENTED_DB_CAPS;
  }

  const runtime = dbRuntimeConfig(config, flags);
  try {
    const result = await deps.runPreflight({
      target,
      entities: runtime.entities ?? [],
      signal: flags.signal
    });
    return deps.describePostgresCapabilities(result.findings ?? result);
  } catch (error) {
    throw preflightError(error, target);
  }
}

function normalizeLoadedRuleset(result) {
  if (result?.value !== undefined || result?.diagnostics !== undefined) {
    return result;
  }

  return Object.freeze({ value: result, diagnostics: null });
}

async function loadDbRuleset({ config, cwd, stderr, deps }) {
  if (config.db?.target === null || config.db === null) {
    return Object.freeze({ ok: true, ruleset: null, hash: null });
  }

  const file = resolveFromCwd(cwd, config.db.rulesFile);
  const result = normalizeLoadedRuleset(await deps.loadRuleset({ file }));
  if (result.value !== null) {
    return Object.freeze({ ok: true, ruleset: result.value, hash: result.value.hash });
  }

  printDiagnostics(stderr, result.diagnostics.errors);
  return Object.freeze({ ok: false, ruleset: null, hash: null });
}

// The banner exists so an acceptance test can prove the run did not quietly
// use the fake adapter, so it has to name the surface that actually ran. It
// used to say "web" for every real run, which on an Android run was simply
// untrue.
function surfaceDetail(surface, config) {
  if (surface === "web") {
    return `(${config.web.channel})`;
  }

  if (surface === "android") {
    const device = config.android?.serial ?? config.android?.avd ?? "auto";
    return `(${device})`;
  }

  return "";
}

function adapterBanner({ registry, config, appArtifact }) {
  if (registry.mode !== "real") {
    return `surface adapter: fake\n`;
  }

  const target = appArtifact.url ?? appArtifact.path;
  return `${config.surfaces
    .map((surface) => `${surface}: real ${surfaceDetail(surface, config)} ${target}`.replace(/\s+/gu, " "))
    .join("\n")}\n`;
}

function dbBanner({ config, dbCaps }) {
  const target = config.db?.target ?? null;
  if (target === null) {
    return "";
  }

  return `database: ${dbCaps.driver} ${dbCaps.capture} ${describeTarget(target)}\n`;
}

function seedMap(selected, runtime) {
  const configured = runtime.seeds ?? {};
  return new Map(
    selected
      .map((scenario) => {
        const name = scenario.ir.seed;
        const seed = typeof name === "string" ? configured[name] : null;
        return seed === undefined || seed === null ? null : [scenario.ir.id, seed];
      })
      .filter(Boolean)
  );
}

function planWithMetadata(plan, { rulesetHash, seed }) {
  if (seed === undefined && rulesetHash === plan.rulesetHash) {
    return plan;
  }

  return createExecutionPlan({
    scenarioId: plan.scenarioId,
    surface: plan.surface,
    app: plan.app,
    bindingsHash: plan.bindingsHash,
    rulesetHash,
    seedDigest: seed === undefined ? plan.seedDigest : seedDigest(seed),
    requirements: plan.requirements,
    capabilities: plan.capabilities,
    rawOpCount: plan.rawOpCount,
    ops: plan.ops
  });
}

function addPlanMetadata({ plans, selected, runtime, rulesetHash }) {
  const seeds = seedMap(selected, runtime);
  if (seeds.size === 0 && rulesetHash === null) {
    return plans;
  }

  return plans.map((plan) =>
    planWithMetadata(plan, { rulesetHash, seed: seeds.get(plan.scenarioId) })
  );
}

function dbFactory({ config, flags, deps, ruleset, runId, selected }) {
  if (config.db?.target === null || config.db === null) {
    return null;
  }

  const runtime = dbRuntimeConfig(config, flags);
  const seeds = seedMap(selected, runtime);
  return (plan) => {
    const hookConfig = Object.freeze({
      ...runtime,
      seed: seeds.get(plan.scenarioId) ?? runtime.seed ?? null
    });
    const driver = deps.createDbDriver({
      target: config.db.target,
      config: hookConfig,
      runId,
      scenarioId: plan.scenarioId,
      surface: plan.surface
    });
    return deps.createDbHooks({ driver, ruleset, config: hookConfig, runId });
  };
}

function shortfallLine(scenario, step, shortfall) {
  const columns = Array.isArray(shortfall.changed) && shortfall.changed.length > 0
    ? shortfall.changed.join(", ")
    : "any";
  const rowKey = JSON.stringify(shortfall.where ?? {});
  const code = step.error?.code ?? "E_DELTA";
  return `Delta failure: ${code} scenario ${scenario.id} step ${step.index} table ${shortfall.entity} row key ${rowKey} column ${columns}\n`;
}

function unexplainedLine(scenario, step, group, row) {
  const code = step.error?.code ?? "E_DELTA";
  return `Delta failure: ${code} scenario ${scenario.id} step ${step.index} table ${group.entity} row key ${row.key} column ${row.columnText}\n`;
}

function stepFailureLine(scenario, step) {
  if (step.error === null) {
    return null;
  }

  const ruleId = typeof step.error.details?.ruleId === "string"
    ? ` rule ${step.error.details.ruleId}`
    : "";
  return `Scenario failure: ${step.error.code} scenario ${scenario.id} step ${step.index}${ruleId} ${step.error.message}\n`;
}

function deltaFailureLines(record) {
  const lines = [];
  for (const scenario of record.scenarios) {
    for (const step of scenario.steps) {
      const failure = stepFailureLine(scenario, step);
      if (failure !== null) {
        lines.push(failure);
      }
      for (const shortfall of step.delta?.shortfalls ?? []) {
        lines.push(shortfallLine(scenario, step, shortfall));
      }
      for (const group of step.delta?.unexplained ?? []) {
        for (const row of group.rows ?? []) {
          lines.push(unexplainedLine(scenario, step, group, row));
        }
      }
    }
  }
  return lines;
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
  const deps = dependencySet(io);
  // Assigned once the registry exists, torn down in the outer finally, so an
  // emulator this run started is stopped even when the run throws. A leaked
  // emulator is the one failure that breaks the NEXT run rather than this one.
  let shutdownRegistry = null;

  try {
    const configFlags = {
      ...(flags.artifactRoot === undefined ? {} : { artifactRoot: flags.artifactRoot }),
      ...(flags.scenariosGlob === undefined ? {} : { scenariosGlob: flags.scenariosGlob }),
      ...(flags.bindingsDir === undefined ? {} : { bindingsDir: flags.bindingsDir }),
      ...(flags.app === undefined ? {} : { app: flags.app }),
      ...(flags.surfaces === undefined ? {} : { surfaces: flags.surfaces }),
      ...(flags.timeouts === undefined ? {} : { timeouts: flags.timeouts }),
      ...(flags.android === undefined ? {} : { android: flags.android }),
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
    const registry = createSurfaceRegistry({
      surfaces,
      appArtifact,
      config: resolvedConfig,
      env,
      deps: io.surfaceDeps ?? {}
    });
    shutdownRegistry = registry.shutdown ?? null;
    write(stdout, adapterBanner({ registry, config: resolvedConfig, appArtifact }));
    const dbCaps = await probeDbCapabilities({ config: resolvedConfig, flags, deps });
    write(stdout, dbBanner({ config: resolvedConfig, dbCaps }));
    const loadedRuleset = await loadDbRuleset({ config: resolvedConfig, cwd, stderr, deps });
    if (!loadedRuleset.ok) {
      return EXIT.USAGE_ERROR;
    }

    const declaredRequirements = await declaredRequirementsFromFile(flags.requirementsFile, cwd);
    const files = await discoverScenarios({ globs: config.scenariosGlob, cwd });
    const compiled = await compileScenarios(
      files.map((file) => resolveFromCwd(cwd, file)),
      stderr
    );
    if (compiled.kind === "error") {
      return EXIT.USAGE_ERROR;
    }

    // A proposed scenario cannot gate anything (GEN-04). The default glob does
    // not reach the proposed directory, and this refuses one wherever else it
    // is found, because quarantine by path alone is quarantine somebody can
    // undo with a copy.
    const proposed = compiled.irs.filter((ir) => ir.proposed === true);
    if (proposed.length > 0) {
      throw new UsageError("E_SCENARIO_PROPOSED", "A proposed scenario cannot be run until it is promoted", {
        scenarios: proposed.map((ir) => ir.id),
        files: proposed.map((ir) => ir.file),
        remediation:
          "Review it, then run `attest promote <file>`. A generated scenario that gates a merge before anyone read it is worse than no scenario."
      });
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

    const lowered = lowerSelected({ selected, bindingsBySurface, appArtifact, registry, dbCaps });
    if (lowered.errors.length > 0) {
      for (const error of lowered.errors) {
        write(stderr, formatError(error));
      }
      return EXIT.USAGE_ERROR;
    }

    const bundle = await createBundle({ root: resolvedConfig.artifactRoot, now: nowFn(io) });
    const runtimeDb = dbRuntimeConfig(resolvedConfig, flags);
    const plans = addPlanMetadata({
      plans: lowered.plans,
      selected,
      runtime: runtimeDb,
      rulesetHash: loadedRuleset.hash
    });
    const finalConfig = Object.freeze({
      ...resolvedConfig,
      tenantPrefix: resolvedConfig.db?.tenantPrefix ?? "",
      db: dbFactory({
        config: resolvedConfig,
        flags,
        deps,
        ruleset: loadedRuleset.ruleset,
        runId: bundle.runId,
        selected
      }),
      dbCapabilities: dbCaps,
      hashes: Object.freeze({ ruleset: loadedRuleset.hash })
    });

    if (flags.dryRun) {
      const planRefs = await writePlans(bundle, plans);
      const record = await writeDryRunRecord({
        bundle,
        config: finalConfig,
        flags,
        plans,
        skips: lowered.skips,
        planRefs,
        coverage,
        selected,
        now: nowFn(io)
      });
      for (const plan of plans) {
        write(stdout, `${plan.scenarioId} [${plan.surface}] clean compile\n`);
      }
      for (const skip of lowered.skips) {
        write(stdout, `${skip.scenarioId} [${skip.surface}] skipped ${skip.capabilities.join(",")}\n`);
      }
      write(stdout, requirementsSummaryLine(coverage, declaredRequirements));
      await bundle.write("junit.xml", toJUnitXml(schemaRecord(record)));
      const reportPath = await writeHtmlReport(bundle, record);
      await bundle.finalize();
      writeReportPath(stdout, reportPath);
      return record.exitCode;
    }

    const suiteBundle = reportableBundle(bundle, coverage);
    const { record } = await runSuiteWithRefedEventLoop({
      plans,
      skips: lowered.skips,
      adapterFor: io.adapterFor ?? registry.adapterFor,
      bundle: suiteBundle,
      config: runConfig(finalConfig, flags),
      now: nowFn(io)
    });

    write(stdout, renderConsoleSummary(record, { color: config.color }));
    for (const line of deltaFailureLines(record)) {
      write(stdout, line);
    }
    write(stdout, requirementsSummaryLine(coverage, declaredRequirements));
    writeReportPath(stdout, suiteBundle.reportPath);
    return record.exitCode;
  } catch (error) {
    write(stderr, formatError(error));
    return error instanceof UsageError ? EXIT.USAGE_ERROR : EXIT.HARNESS_ERROR;
  } finally {
    if (typeof shutdownRegistry === "function") {
      try {
        await shutdownRegistry();
      } catch {
        // Teardown is best effort. It must never change the exit code, because
        // a run that already produced a verdict has to report that verdict.
      }
    }
  }
}

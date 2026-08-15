import { readdir } from "node:fs/promises";
import path from "node:path";

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
  for (const plan of plans) {
    await bundle.scenario(plan.scenarioId, plan.surface).writeJson("plan.json", plan);
  }
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
      await writePlans(bundle, lowered.plans);
      for (const plan of lowered.plans) {
        write(stdout, `${plan.scenarioId} [${plan.surface}] clean compile\n`);
      }
      for (const skip of lowered.skips) {
        write(stdout, `${skip.scenarioId} [${skip.surface}] skipped ${skip.capabilities.join(",")}\n`);
      }
      await bundle.finalize();
      return lowered.skips.length > 0 && config.failOnSkip ? EXIT.SKIPPED_AS_FAILURE : EXIT.PASS;
    }

    const { record } = await runSuite({
      plans: lowered.plans,
      skips: lowered.skips,
      adapterFor: io.adapterFor ?? adapterForFactory(env),
      bundle,
      config: runConfig(config, flags),
      now: nowFn(io)
    });

    write(stdout, renderConsoleSummary(record, { color: config.color }));
    return record.exitCode;
  } catch (error) {
    write(stderr, formatError(error));
    return error instanceof UsageError ? EXIT.USAGE_ERROR : EXIT.HARNESS_ERROR;
  }
}

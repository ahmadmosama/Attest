#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { classifyError } from "../runtime/classify.mjs";
import { EXIT } from "./exit-codes.mjs";
import { runCommand } from "./commands/run.mjs";
import { selfcheckCommand } from "./commands/selfcheck.mjs";

const DASH = "-";

function flag(value) {
  return `${DASH}${DASH}${value}`;
}

function collect(value, previous) {
  return [...(previous ?? []), value];
}

function parseInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommanderError(EXIT.USAGE_ERROR, "commander.invalidArgument", "Expected a positive integer");
  }
  return parsed;
}

function programFor(io) {
  const program = new Command();

  program
    .name("attest")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text)
    });

  program
    .command("run")
    .option(flag("scenarios <glob...>"))
    .option(flag("bindings <dir>"))
    .option(flag("app <path|url>"))
    .option(flag("surface <name...>"))
    .option(flag("tag <tag>"), undefined, collect, [])
    .option(flag("id <scenarioId>"), undefined, collect, [])
    .option(flag("headed"))
    .option(flag("dry-run"))
    .option(flag("artifacts <dir>"))
    .option(flag("requirements <file>"))
    .option(flag("timeout-step <ms>"), undefined, parseInteger)
    .option(flag("timeout-scenario <ms>"), undefined, parseInteger)
    .option(flag("fail-on-skip"))
    .option(flag("no-fail-on-skip"))
    .option(flag("json"))
    .option(flag("color"))
    .option(flag("no-color"))
    .action(async (options) => {
      const timeouts = {
        ...(options.timeoutStep === undefined ? {} : { stepMs: options.timeoutStep }),
        ...(options.timeoutScenario === undefined ? {} : { scenarioMs: options.timeoutScenario })
      };
      const flags = {
        ...(options.scenarios === undefined ? {} : { scenariosGlob: options.scenarios }),
        ...(options.bindings === undefined ? {} : { bindingsDir: options.bindings }),
        ...(options.app === undefined ? {} : { app: options.app }),
        ...(options.surface === undefined ? {} : { surfaces: options.surface }),
        ...(options.artifacts === undefined ? {} : { artifactRoot: options.artifacts }),
        ...(options.requirements === undefined ? {} : { requirementsFile: options.requirements }),
        ...(Object.keys(timeouts).length === 0 ? {} : { timeouts }),
        ...(options.failOnSkip === undefined ? {} : { failOnSkip: options.failOnSkip }),
        ...(options.color === undefined ? {} : { color: options.color }),
        ids: options.id,
        tags: options.tag,
        headed: Boolean(options.headed),
        dryRun: Boolean(options.dryRun),
        json: Boolean(options.json)
      };

      program.setOptionValue("exitCode", await runCommand(flags, io));
    });

  program
    .command("selfcheck")
    .option(flag("corpus <file>"))
    .option(flag("update-baseline"))
    .option(flag("json"))
    .action(async (options) => {
      program.setOptionValue("exitCode", await selfcheckCommand({
        ...(options.corpus === undefined ? {} : { corpus: options.corpus }),
        updateBaseline: Boolean(options.updateBaseline),
        json: Boolean(options.json)
      }, io));
    });

  return program;
}

export async function main(argv, io = {}) {
  const injected = {
    ...io,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    now: io.now
  };

  try {
    const program = programFor(injected);
    await program.parseAsync(argv, { from: "node" });
    return program.getOptionValue("exitCode") ?? EXIT.PASS;
  } catch (error) {
    if (error instanceof CommanderError) {
      return EXIT.USAGE_ERROR;
    }

    const classification = classifyError(error);
    injected.stderr.write(`${classification.code}  ${classification.message}\n`);
    return EXIT.HARNESS_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv));
}

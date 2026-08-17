#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { EXIT } from "../cli/exit-codes.mjs";
import { generateCommand, promoteCommand } from "./commands.mjs";

/**
 * `attest-generate` is a SEPARATE binary from `attest`, deliberately.
 *
 * RUN-02 says execution performs zero LLM calls, and
 * `tools/check-import-boundary.mjs` proves it mechanically by refusing any
 * import edge from the runtime into `src/generate`. Hanging `generate` off the
 * main CLI would have created exactly that edge, which is how the boundary
 * caught this design being wrong the first time.
 *
 * Two binaries make the guarantee stronger than an import rule anyway: the
 * process that runs scenarios never loads the generator at all, so there is
 * nothing to reason about. The generator may use a model. The runner cannot,
 * because it cannot even see the code that would.
 */
function programFor(io) {
  const program = new Command();

  program
    .name("attest-generate")
    .description("Author scenarios from declared intent. Never runs them.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text)
    });

  program
    .command("from-spec")
    .option("--spec <glob...>")
    .option("--scenarios <glob...>")
    .option("--out <dir>")
    .option("--require-full-coverage")
    .action(async (options) => {
      program.setOptionValue(
        "exitCode",
        await generateCommand(
          {
            fromSpec: options.spec ?? [],
            scenarios: options.scenarios ?? [],
            ...(options.out === undefined ? {} : { out: options.out }),
            requireFullCoverage: Boolean(options.requireFullCoverage)
          },
          io
        )
      );
    });

  program
    .command("promote")
    .argument("<file>")
    .option("--requirement <id>")
    .option("--out <dir>")
    .action(async (file, options) => {
      program.setOptionValue(
        "exitCode",
        await promoteCommand(
          {
            file,
            ...(options.requirement === undefined ? {} : { requirement: options.requirement }),
            ...(options.out === undefined ? {} : { out: options.out })
          },
          io
        )
      );
    });

  return program;
}

export async function main(argv, io = {}) {
  const injected = {
    ...io,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    cwd: io.cwd ?? process.cwd()
  };

  try {
    const program = programFor(injected);
    await program.parseAsync(argv, { from: "node" });
    return program.getOptionValue("exitCode") ?? EXIT.PASS;
  } catch (error) {
    if (error instanceof CommanderError) {
      return EXIT.USAGE_ERROR;
    }

    injected.stderr.write(`${error?.code ?? "E_HARNESS"}  ${error?.message ?? String(error)}\n`);
    return EXIT.HARNESS_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv));
}

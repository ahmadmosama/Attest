import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import { main as runtimeMain } from "../../src/cli/main.mjs";
import { main as generateMain } from "../../src/generate/cli.mjs";

const PACKAGE = JSON.parse(await readFile("package.json", "utf8"));

function captured() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } },
    output: () => out.join(""),
    error: () => err.join("")
  };
}

describe("generation cannot leak into execution", () => {
  test("the runner and the generator are two binaries, not two subcommands", () => {
    // RUN-02 says execution performs zero LLM calls. The generator may use a
    // model, so the process that runs scenarios never loads it at all. That is
    // a stronger guarantee than an import rule, because there is nothing left
    // to reason about.
    assert.equal(PACKAGE.bin.attest, "./src/cli/main.mjs");
    assert.equal(PACKAGE.bin["attest-generate"], "./src/generate/cli.mjs");
  });

  test("the runtime CLI does not offer generate or promote at all", async () => {
    const { io, output } = captured();
    await runtimeMain(["node", "attest", "--help"], io);

    assert.match(output(), /run \[options\]/u);
    assert.match(output(), /selfcheck \[options\]/u);
    // Not hidden, not disabled: absent. An edge from the runtime into
    // src/generate is what the import boundary refuses, and this is the shape
    // that keeps it absent.
    assert.doesNotMatch(output(), /^\s+generate/mu);
    assert.doesNotMatch(output(), /^\s+promote/mu);
  });

  test("the generator CLI offers exactly the authoring commands", async () => {
    const { io, output } = captured();
    await generateMain(["node", "attest-generate", "--help"], io);

    assert.match(output(), /from-spec/u);
    assert.match(output(), /promote/u);
    // And it says what it is for, including what it does not do.
    assert.match(output(), /Never runs them/u);
  });

  test("no file outside src/generate imports src/generate", async () => {
    // The mechanical proof, run here as well as in the lint step, so a
    // regression fails the test suite and not only the lint script.
    const { checkImportBoundary } = await import("../../tools/check-import-boundary.mjs");
    const result = await checkImportBoundary(path.resolve("src"));

    assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  });
});

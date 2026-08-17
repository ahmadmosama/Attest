import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, test } from "node:test";

import { DEFAULTS } from "../../src/config/schema.mjs";
import { compileScenarioText } from "../../src/ir/compile.mjs";
import { isProposedText, promoteScenarioFile, promoteText } from "../../src/generate/promote.mjs";
import { runCommand } from "../../src/cli/commands/run.mjs";

const ROOTS = [];

const PROPOSAL = [
  "id: spec.chk_001",
  "requirement: [CHK-001]",
  "proposed: true",
  "# generated from SPEC.md:12",
  "steps:",
  "  - open: screen:checkout",
  ""
].join("\n");

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(path.join(process.cwd(), `test/generate/.tmp-${label}-`));
  ROOTS.push(root);
  return root;
}

describe("a proposal cannot gate anything until it is promoted", () => {
  test("the default scenario glob does not reach the proposed directory", () => {
    // Quarantine by path is the first of three layers, and it is the one a
    // reader is most likely to assume without checking.
    const [glob] = DEFAULTS.scenariosGlob;

    assert.equal(glob, "scenarios/**/*.attest.yaml");
    assert.equal(glob.includes("proposed"), false);
  });

  test("the marker lives in the file, so a copy is still a proposal", () => {
    const compiled = compileScenarioText(PROPOSAL, { file: "anywhere.attest.yaml" });

    assert.equal(compiled.diagnostics.ok, true);
    assert.equal(compiled.ir.proposed, true);
    assert.equal(isProposedText(PROPOSAL), true);
  });

  test("the runner refuses a proposed scenario wherever it finds it", async () => {
    const root = await tempRoot("run");
    await mkdir(path.join(root, "scenarios"), { recursive: true });
    await mkdir(path.join(root, "bindings", "app"), { recursive: true });
    // Deliberately NOT in a proposed directory: quarantine by path alone is
    // quarantine somebody can undo with a copy.
    await writeFile(path.join(root, "scenarios", "sneaked.attest.yaml"), PROPOSAL, "utf8");
    await writeFile(
      path.join(root, "bindings", "app", "web.yaml"),
      ["surface: web", "screens:", '  screen:checkout: { path: "/checkout", ready: { testId: checkout } }'].join("\n"),
      "utf8"
    );

    const err = [];
    const code = await runCommand(
      {
        configFile: {
          scenariosGlob: ["scenarios/*.attest.yaml"],
          bindingsDir: "bindings",
          app: "https://example.test",
          artifactRoot: path.join(root, "artifacts")
        }
      },
      {
        cwd: root,
        env: {},
        stdout: { write: () => {} },
        stderr: { write: (text) => err.push(text) },
        now: () => new Date("2026-08-17T00:00:00.000Z")
      }
    );

    assert.notEqual(code, 0);
    assert.match(err.join(""), /E_SCENARIO_PROPOSED/u);
    assert.match(err.join(""), /attest promote/u);
  });
});

describe("promotion is a deliberate act", () => {
  test("promoting removes the marker and keeps the requirement link", () => {
    const promoted = promoteText(PROPOSAL, { file: "spec.chk_001.attest.yaml" });

    assert.equal(isProposedText(promoted.text), false);
    assert.deepEqual(promoted.requirements, ["CHK-001"]);
    assert.equal(promoted.id, "spec.chk_001");
  });

  test("promoting a scenario that is not a proposal is refused", () => {
    assert.throws(() => promoteText(PROPOSAL.replace("proposed: true\n", "")), {
      code: "E_PROMOTE_NOT_PROPOSED"
    });
  });

  test("a promoted scenario must name the requirement it covers", () => {
    // A scenario linked to nothing proves nothing about the spec.
    const unlinked = PROPOSAL.replace("requirement: [CHK-001]", "requirement: [NOT-A-REQUIREMENT-ID]");

    assert.throws(() => promoteText(unlinked), (error) => {
      assert(["E_PROMOTE_NO_REQUIREMENT", "E_PROMOTE_DOES_NOT_COMPILE"].includes(error.code));
      return true;
    });

    // And one can be supplied at promotion time.
    const supplied = promoteText(PROPOSAL, { requirement: "CHK-042" });
    assert.deepEqual(supplied.requirements, ["CHK-042"]);
  });

  test("a proposal that does not compile is refused rather than written", () => {
    // Promoting it would put a permanently red gate into the suite.
    const broken = PROPOSAL.replace("  - open: screen:checkout", "  - sleep: 500");

    assert.throws(() => promoteText(broken), (error) => {
      assert.equal(error.code, "E_PROMOTE_DOES_NOT_COMPILE");
      assert(error.details.diagnostics.length > 0);
      return true;
    });
  });

  test("promoting a file moves it out of the proposed directory, so the move shows in a diff", async () => {
    const root = await tempRoot("promote");
    const proposedDir = path.join(root, "scenarios", "proposed");
    await mkdir(proposedDir, { recursive: true });
    const file = path.join(proposedDir, "spec.chk_001.attest.yaml");
    await writeFile(file, PROPOSAL, "utf8");

    const result = await promoteScenarioFile(file);

    assert.equal(existsSync(file), false);
    assert.equal(existsSync(result.to), true);
    assert.equal(path.dirname(result.to), path.join(root, "scenarios"));
    assert.equal(isProposedText(await readFile(result.to, "utf8")), false);
    assert.deepEqual(result.requirements, ["CHK-001"]);
  });

  test("promoting an unreadable file is a named error", async () => {
    await assert.rejects(() => promoteScenarioFile(path.join("does", "not", "exist.attest.yaml")), {
      code: "E_PROMOTE_UNREADABLE"
    });
  });
});

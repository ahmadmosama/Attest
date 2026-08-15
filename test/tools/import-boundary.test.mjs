import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkImportBoundary, LLM_PACKAGE_DENYLIST } from "../../tools/check-import-boundary.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../..");
const fixturesRoot = path.join(repoRoot, "test", "fixtures", "import-boundary");

test("clean trees have no import boundary violations", async () => {
  const result = await checkImportBoundary(path.join(fixturesRoot, "clean", "src"));

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("runtime imports from generate are violations with file and line", async () => {
  const result = await checkImportBoundary(path.join(fixturesRoot, "dirty", "src"));
  const generateViolation = result.violations.find(
    (violation) => violation.rule === "no-generate-edge"
  );

  assert.equal(result.ok, false);
  assert.equal(generateViolation.file, "runtime/loop.mjs");
  assert.equal(generateViolation.line, 1);
  assert.equal(generateViolation.specifier, "../generate/from-spec.mjs");
  assert.match(generateViolation.reason, /RUN-02/);
});

test("LLM packages are violations outside generate", async () => {
  const result = await checkImportBoundary(path.join(fixturesRoot, "dirty", "src"));
  const llmViolation = result.violations.find(
    (violation) => violation.rule === "no-llm-package"
  );

  assert.equal(llmViolation.file, "surfaces/web/session.mjs");
  assert.equal(llmViolation.line, 1);
  assert.equal(llmViolation.specifier, "openai");
});

test("the LLM denylist is frozen", () => {
  assert.throws(() => LLM_PACKAGE_DENYLIST.push("example"));
});

test("generate modules may import generate modules", async () => {
  const rootDir = path.join(repoRoot, "test", ".tmp-import-boundary-generate");

  await rm(rootDir, { force: true, recursive: true });
  await mkdir(path.join(rootDir, "generate"), { recursive: true });
  await writeFile(path.join(rootDir, "generate", "a.mjs"), 'import b from "./b.mjs";\nexport default b;\n');
  await writeFile(path.join(rootDir, "generate", "b.mjs"), "export default 1;\n");

  try {
    const result = await checkImportBoundary(rootDir);
    assert.deepEqual(result, { ok: true, violations: [] });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test("dynamic imports and export-from edges are caught", async () => {
  const rootDir = path.join(repoRoot, "test", ".tmp-import-boundary-dynamic");

  await rm(rootDir, { force: true, recursive: true });
  await mkdir(path.join(rootDir, "runtime"), { recursive: true });
  await mkdir(path.join(rootDir, "generate"), { recursive: true });
  await writeFile(
    path.join(rootDir, "runtime", "loop.mjs"),
    'await import("../generate/x.mjs");\nexport { x } from "../generate/x.mjs";\n'
  );
  await writeFile(path.join(rootDir, "generate", "x.mjs"), "export const x = 1;\n");

  try {
    const result = await checkImportBoundary(rootDir);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.violations.map((violation) => [violation.line, violation.specifier, violation.rule]),
      [
        [1, "../generate/x.mjs", "no-generate-edge"],
        [2, "../generate/x.mjs", "no-generate-edge"]
      ]
    );
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test("CLI exits 1 and prints file line plus reason for dirty trees", () => {
  const dirtyRoot = path.join(fixturesRoot, "dirty", "src");
  const result = spawnSync(process.execPath, ["tools/check-import-boundary.mjs", dirtyRoot], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime\/loop\.mjs:1  no-generate-edge/);
  assert.match(result.stderr, /surfaces\/web\/session\.mjs:1  no-llm-package/);
});

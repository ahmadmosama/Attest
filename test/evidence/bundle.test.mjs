import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { UsageError } from "../../src/errors.mjs";
import { BUNDLE_LAYOUT } from "../../src/evidence/paths.mjs";
import { createBundle } from "../../src/evidence/bundle.mjs";

async function withRepoTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(process.cwd(), `test/evidence/${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("createBundle creates the per run directory and writes inside it", async () => {
  await withRepoTemp("bundle", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-9f3a1c07" });
    const ref = await bundle.write("scenarios/x/steps/01.txt", "hello");
    const file = await readFile(path.join(bundle.dir, "scenarios", "x", "steps", "01.txt"), "utf8");

    assert.equal(file, "hello");
    assert.equal(ref.path, "scenarios/x/steps/01.txt");
    assert.equal(ref.bytes, 5);
    assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  });
});

test("createBundle can generate a run id from an injected clock", async () => {
  await withRepoTemp("clock", async (root) => {
    const bundle = await createBundle({
      root,
      now: () => new Date("2026-08-15T04:46:12.000Z")
    });

    assert.match(bundle.runId, /^20260815T044612Z-[a-f0-9]{8}$/);
  });
});

test("write rejects traversal before writing", async () => {
  await withRepoTemp("escape", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-9f3a1c07" });

    await assert.rejects(
      () => bundle.write("../escape.txt", "no"),
      (error) => error instanceof UsageError && error.code === "E_BAD_PATH_SEGMENT"
    );
  });
});

test("finalize writes a manifest with relative forward slash paths", async () => {
  await withRepoTemp("manifest", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-9f3a1c07" });
    await bundle.write("scenarios/x/steps/01.txt", "hello");
    const finalized = await bundle.finalize();
    const manifestText = await readFile(path.join(bundle.dir, BUNDLE_LAYOUT.manifest), "utf8");
    const manifest = JSON.parse(manifestText);

    assert.deepEqual(manifest, finalized.artifacts.slice(0, 1));
    assert.equal(path.isAbsolute(manifest[0].path), false);
    assert.equal(manifest[0].path.includes("\\"), false);
    assert.deepEqual(Object.keys(manifest[0]), ["bytes", "kind", "path", "sha256"]);
  });
});

test("identical writes with the same run id produce identical manifests", async () => {
  const runId = "20260815T044612Z-9f3a1c07";

  await withRepoTemp("stable-a", async (leftRoot) => {
    await withRepoTemp("stable-b", async (rightRoot) => {
      const left = await createBundle({ root: leftRoot, runId });
      const right = await createBundle({ root: rightRoot, runId });

      await left.writeJson("run.json", { z: 1, a: 2 });
      await right.writeJson("run.json", { z: 1, a: 2 });
      await left.finalize();
      await right.finalize();

      const leftManifest = await readFile(path.join(left.dir, BUNDLE_LAYOUT.manifest), "utf8");
      const rightManifest = await readFile(path.join(right.dir, BUNDLE_LAYOUT.manifest), "utf8");

      assert.equal(leftManifest, rightManifest);
    });
  });
});

test("scenario handles write under the sanitized scenario layout", async () => {
  await withRepoTemp("scenario", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-9f3a1c07" });
    const scenario = bundle.scenario("checkout.guest_purchase", "web");
    const ref = await scenario.writeJson("plan.json", { b: 2, a: 1 });

    assert.equal(ref.path, "scenarios/checkout.guest_purchase__web/plan.json");
    assert.equal(scenario.ref("steps/01-click.txt"), "scenarios/checkout.guest_purchase__web/steps/01-click.txt");
    assert.equal(
      await readFile(path.join(scenario.dir, BUNDLE_LAYOUT.plan), "utf8"),
      "{\n  \"a\": 1,\n  \"b\": 2\n}\n"
    );
  });
});

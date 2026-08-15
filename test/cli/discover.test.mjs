import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../src/cli/exit-codes.mjs";
import { discoverScenarios, applyFilters } from "../../src/cli/discover.mjs";
import { runCommand } from "../../src/cli/commands/run.mjs";

const SCENARIO = `id: smoke.minimal
requirement: [REQ-SMOKE-001]
tags: [smoke]
steps:
  - open: screen:catalog
`;

const CHECKOUT = `id: checkout.guest_purchase
requirement: [REQ-CHK-004]
tags: [checkout, smoke]
steps:
  - open: screen:catalog
`;

const DB_SCENARIO = `id: db.requires_delta
requirement: [REQ-DB-001]
steps:
  - open: screen:catalog
  - delta_window: open
  - delta_window: close
    require_no_unexplained: true
`;

const BINDINGS = `surface: web
screens:
  screen:catalog: { path: "/", ready: { role: heading, name: "Catalog" } }
`;

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(process.cwd(), "test/cli/discover-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSuite(root, scenarios = { "smoke.attest.yaml": SCENARIO }) {
  await mkdir(path.join(root, "scenarios", "nested"), { recursive: true });
  await mkdir(path.join(root, "scenarios", "proposed"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "bindings", "shop"), { recursive: true });
  for (const [file, text] of Object.entries(scenarios)) {
    await writeFile(path.join(root, "scenarios", file), text);
  }
  await writeFile(path.join(root, "scenarios", "nested", "checkout.attest.yaml"), CHECKOUT);
  await writeFile(path.join(root, "scenarios", "proposed", "draft.attest.yaml"), SCENARIO);
  await writeFile(path.join(root, "node_modules", "pkg", "ignored.attest.yaml"), SCENARIO);
  await writeFile(path.join(root, "bindings", "shop", "web.yaml"), BINDINGS);
}

function bufferIo(extra = {}) {
  const out = [];
  const err = [];
  return {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    output: () => out.join(""),
    error: () => err.join(""),
    ...extra
  };
}

test("discoverScenarios returns sorted unique scenario files and ignores proposed and node_modules", async () => {
  await withTempDir(async (root) => {
    await writeSuite(root);
    const found = await discoverScenarios({
      cwd: root,
      globs: ["scenarios/**/*.attest.yaml", "scenarios/**/*.attest.yaml", "node_modules/**/*.attest.yaml"]
    });

    assert.deepEqual(found, ["scenarios/nested/checkout.attest.yaml", "scenarios/smoke.attest.yaml"]);
  });
});

test("applyFilters filters by id and tag and carries surface selection", () => {
  const scenarios = [
    { id: "checkout.guest_purchase", tags: ["smoke", "checkout"], surfaces: ["web", "android"] },
    { id: "smoke.minimal", tags: ["smoke"], surfaces: ["web", "android"] }
  ];

  assert.deepEqual(
    applyFilters(scenarios, { ids: ["checkout.guest_purchase"] }).map((scenario) => scenario.id),
    ["checkout.guest_purchase"]
  );
  assert.deepEqual(
    applyFilters(scenarios, { tags: ["checkout"] }).map((scenario) => scenario.id),
    ["checkout.guest_purchase"]
  );
  assert.deepEqual(applyFilters(scenarios, { surfaces: ["android"] })[0].selectedSurfaces, [
    "android"
  ]);
});

test("runCommand dry-run writes plans and does not call the adapter", async () => {
  await withTempDir(async (root) => {
    await writeSuite(root);
    const io = bufferIo({
      cwd: root,
      now: () => new Date("2026-08-15T04:46:12.000Z"),
      adapterFor() {
        throw new Error("adapter should not be called in dry-run");
      }
    });

    const code = await runCommand(
      {
        dryRun: true,
        scenariosGlob: ["scenarios/smoke.attest.yaml"],
        bindingsDir: "bindings",
        app: "https://example.test",
        surfaces: ["web"],
        artifactRoot: path.join(root, "artifacts")
      },
      io
    );

    assert.equal(code, EXIT.PASS);
    assert.match(io.output(), /smoke\.minimal \[web\] clean compile/);
  });
});

test("runCommand returns usage error for empty selections and compile diagnostics", async () => {
  await withTempDir(async (root) => {
    await writeSuite(root, {
      "invalid.attest.yaml": `id: invalid.sleep_step
requirement: [REQ-BAN-001]
steps:
  - tap:
      target: button:continue
      sleep: true
`
    });

    const emptyIo = bufferIo({ cwd: root });
    assert.equal(
      await runCommand(
        {
          dryRun: true,
          scenariosGlob: ["scenarios/smoke.attest.yaml"],
          bindingsDir: "bindings",
          app: "https://example.test",
          surfaces: ["web"],
          ids: ["missing.scenario"]
        },
        emptyIo
      ),
      EXIT.USAGE_ERROR
    );
    assert.match(emptyIo.error(), /E_EMPTY_SCENARIO_SELECTION/);

    const invalidIo = bufferIo({ cwd: root });
    assert.equal(
      await runCommand(
        {
          dryRun: true,
          scenariosGlob: ["scenarios/invalid.attest.yaml"],
          bindingsDir: "bindings",
          app: "https://example.test",
          surfaces: ["web"]
        },
        invalidIo
      ),
      EXIT.USAGE_ERROR
    );
    assert.match(invalidIo.error(), /E_BANNED_SLEEP/);
    assert.match(invalidIo.error(), /invalid\.attest\.yaml:\d+:\d+/);
  });
});

test("runCommand dry-run reports unsupported db capability as a named usage error", async () => {
  await withTempDir(async (root) => {
    await writeSuite(root, { "db.attest.yaml": DB_SCENARIO });
    const io = bufferIo({ cwd: root });

    const code = await runCommand(
      {
        dryRun: true,
        scenariosGlob: ["scenarios/db.attest.yaml"],
        bindingsDir: "bindings",
        app: "https://example.test",
        surfaces: ["web"]
      },
      io
    );

    assert.equal(code, EXIT.USAGE_ERROR);
    assert.match(io.error(), /E_DELTA_UNSUPPORTED/);
  });
});

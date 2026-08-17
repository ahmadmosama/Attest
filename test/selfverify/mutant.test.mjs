import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  applyMutant,
  hashMutant,
  MutantSchema,
  revertMutant
} from "../../src/selfverify/mutant.mjs";

async function tempRoot(prefix) {
  return mkdtemp(path.join(process.cwd(), `test/selfverify/${prefix}-`));
}

async function writeFixture(root, text) {
  const dir = path.join(root, "fixtures", "self-verify");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "app.mjs");
  await writeFile(file, text, "utf8");
  return file;
}

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function baseMutant(fields = {}) {
  return {
    id: "omit_order_write",
    kind: "omit_write",
    file: "fixtures/self-verify/app.mjs",
    find: "return total + tax;",
    replace: "return total;",
    seeds: "The order total is saved without tax",
    caught_by: "DELTA-01",
    ...fields
  };
}

async function withRoot(prefix, run) {
  const root = await tempRoot(prefix);
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("MutantSchema rejects unknown mutant kinds", () => {
  const parsed = MutantSchema.safeParse(baseMutant({ kind: "free_form_patch" }));

  assert.equal(parsed.success, false);
});

test("applyMutant raises E_MUTANT_NOT_APPLICABLE when find is absent", async () => {
  await withRoot("mutant-absent", async (root) => {
    await writeFixture(root, "return total;");

    await assert.rejects(() => applyMutant(baseMutant(), { root }), {
      code: "E_MUTANT_NOT_APPLICABLE",
      details: {
        mutantId: "omit_order_write",
        file: path.join(root, "fixtures", "self-verify", "app.mjs")
      }
    });
  });
});

test("applyMutant raises E_MUTANT_AMBIGUOUS when find occurs twice", async () => {
  await withRoot("mutant-ambiguous", async (root) => {
    await writeFixture(root, "return total + tax;\nreturn total + tax;\n");

    await assert.rejects(() => applyMutant(baseMutant(), { root }), {
      code: "E_MUTANT_AMBIGUOUS",
      details: {
        mutantId: "omit_order_write",
        file: path.join(root, "fixtures", "self-verify", "app.mjs"),
        occurrences: 2
      }
    });
  });
});

test("applyMutant refuses paths outside fixtures self verify before writing", async () => {
  await withRoot("mutant-scope", async (root) => {
    const outside = path.join(root, "app.mjs");
    await writeFile(outside, "return total + tax;", "utf8");

    await assert.rejects(
      () => applyMutant(baseMutant({ file: "app.mjs" }), { root }),
      {
        code: "E_MUTANT_OUT_OF_SCOPE",
        details: {
          mutantId: "omit_order_write",
          file: "app.mjs"
        }
      }
    );
    assert.equal(await readFile(outside, "utf8"), "return total + tax;");
  });
});

test("applyMutant then revertMutant restores a byte identical file", async () => {
  await withRoot("mutant-revert", async (root) => {
    const file = await writeFixture(root, "export function total() {\n  return total + tax;\n}\n");
    const before = await hashFile(file);

    const applied = await applyMutant(baseMutant(), { root });
    assert.notEqual(applied.afterHash, before);
    assert.equal(await readFile(file, "utf8"), "export function total() {\n  return total;\n}\n");

    const reverted = await revertMutant(baseMutant(), { root });
    assert.equal(reverted.afterHash, before);
    assert.equal(await hashFile(file), before);
  });
});

test("revertMutant raises E_MUTANT_NOT_APPLIED on an unapplied file", async () => {
  await withRoot("mutant-unapplied", async (root) => {
    await writeFixture(root, "return total + tax;");

    await assert.rejects(() => revertMutant(baseMutant(), { root }), {
      code: "E_MUTANT_NOT_APPLIED",
      details: {
        mutantId: "omit_order_write",
        file: path.join(root, "fixtures", "self-verify", "app.mjs")
      }
    });
  });
});

test("hashMutant is stable across key order and changes across content", () => {
  const first = baseMutant();
  const second = {
    caught_by: "DELTA-01",
    seeds: "The order total is saved without tax",
    replace: "return total;",
    find: "return total + tax;",
    file: "fixtures/self-verify/app.mjs",
    kind: "omit_write",
    id: "omit_order_write"
  };
  const changed = baseMutant({ replace: "return 0;" });

  assert.equal(hashMutant(first), hashMutant(second));
  assert.notEqual(hashMutant(first), hashMutant(changed));
});

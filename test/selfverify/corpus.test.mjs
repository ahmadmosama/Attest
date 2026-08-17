import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { hashCorpus, loadCorpus, parseCorpus } from "../../src/selfverify/corpus.mjs";

async function tempRoot(prefix) {
  return mkdtemp(path.join(process.cwd(), `test/selfverify/${prefix}-`));
}

async function withRoot(prefix, run) {
  const root = await tempRoot(prefix);
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeText(file, text) {
  await writeFile(file, text.trimStart(), "utf8");
  return file;
}

async function writeRequirements(root, ids = ["DELTA-01", "DELTA-03"]) {
  return writeText(
    path.join(root, "REQUIREMENTS.md"),
    ids.map((id) => `- [ ] **${id}**: Requirement ${id}`).join("\n")
  );
}

function corpusYaml(fields = {}) {
  return `
version: 1
mutants:
  - id: ${fields.id ?? "omit_order_write"}
    kind: ${fields.kind ?? "omit_write"}
    file: ${fields.file ?? "fixtures/self-verify/app.mjs"}
    find: "await insertOrder();"
    replace: ${fields.replace ?? "\"\""}
    seeds: ${fields.seeds ?? "Order is not persisted"}
    caught_by: ${fields.caught_by ?? "DELTA-01"}
`;
}

function mutant(fields = {}) {
  return {
    id: "omit_order_write",
    kind: "omit_write",
    file: "fixtures/self-verify/app.mjs",
    find: "await insertOrder();",
    replace: "",
    seeds: "Order is not persisted",
    caught_by: "DELTA-01",
    ...fields
  };
}

test("loadCorpus loads a versioned YAML corpus with a reportable hash", async () => {
  await withRoot("corpus-load", async (root) => {
    const file = await writeText(path.join(root, "corpus.yml"), corpusYaml());
    const requirementsFile = await writeRequirements(root);

    const loaded = await loadCorpus({ file, requirementsFile });

    assert.equal(loaded.path, file);
    assert.equal(loaded.corpus.version, 1);
    assert.equal(loaded.corpus.mutants.length, 1);
    assert.equal(loaded.byId.omit_order_write.caught_by, "DELTA-01");
    assert.equal(loaded.hash, hashCorpus(loaded.corpus));
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.corpus.mutants[0]), true);
  });
});

test("loadCorpus reports duplicate mutant ids at both line numbers", async () => {
  await withRoot("corpus-duplicate", async (root) => {
    const file = await writeText(
      path.join(root, "corpus.yml"),
      `
version: 1
mutants:
  - id: duplicate_mutant
    kind: omit_write
    file: fixtures/self-verify/app.mjs
    find: "one"
    replace: "two"
    seeds: First bug
    caught_by: DELTA-01
  - id: duplicate_mutant
    kind: wrong_value
    file: fixtures/self-verify/app.mjs
    find: "three"
    replace: "four"
    seeds: Second bug
    caught_by: DELTA-03
`
    );
    const requirementsFile = await writeRequirements(root);

    const result = await loadCorpus({ file, requirementsFile });
    const errors = result.diagnostics.errors;

    assert.equal(result.value, null);
    assert.equal(errors.length, 2);
    assert.deepEqual(
      errors.map((error) => error.code),
      ["E_CORPUS_DUPLICATE_ID", "E_CORPUS_DUPLICATE_ID"]
    );
    assert.notEqual(errors[0].line, errors[1].line);
    assert.match(errors[0].reason, new RegExp(String(errors[1].line), "u"));
    assert.match(errors[1].reason, new RegExp(String(errors[0].line), "u"));
  });
});

test("loadCorpus rejects a mutant missing seeds", async () => {
  await withRoot("corpus-seeds", async (root) => {
    const file = await writeText(
      path.join(root, "corpus.yml"),
      `
version: 1
mutants:
  - id: omit_order_write
    kind: omit_write
    file: fixtures/self-verify/app.mjs
    find: "await insertOrder();"
    replace: ""
    caught_by: DELTA-01
`
    );
    const requirementsFile = await writeRequirements(root);

    const result = await loadCorpus({ file, requirementsFile });

    assert.equal(result.value, null);
    assert.equal(result.diagnostics.errors[0].code, "E_CORPUS_SCHEMA");
    assert.deepEqual(result.diagnostics.errors[0].path, ["mutants", 0, "seeds"]);
  });
});

test("loadCorpus rejects a mutant missing caught_by", async () => {
  await withRoot("corpus-caught-by", async (root) => {
    const file = await writeText(
      path.join(root, "corpus.yml"),
      `
version: 1
mutants:
  - id: omit_order_write
    kind: omit_write
    file: fixtures/self-verify/app.mjs
    find: "await insertOrder();"
    replace: ""
    seeds: Order is not persisted
`
    );
    const requirementsFile = await writeRequirements(root);

    const result = await loadCorpus({ file, requirementsFile });

    assert.equal(result.value, null);
    assert.equal(result.diagnostics.errors[0].code, "E_CORPUS_SCHEMA");
    assert.deepEqual(result.diagnostics.errors[0].path, ["mutants", 0, "caught_by"]);
  });
});

test("loadCorpus rejects unknown requirement ids with a position", async () => {
  await withRoot("corpus-requirement", async (root) => {
    const file = await writeText(path.join(root, "corpus.yml"), corpusYaml({ caught_by: "DELTA-99" }));
    const requirementsFile = await writeRequirements(root, ["DELTA-01"]);

    const result = await loadCorpus({ file, requirementsFile });
    const error = result.diagnostics.errors[0];

    assert.equal(result.value, null);
    assert.equal(error.code, "E_CORPUS_REQUIREMENT_UNKNOWN");
    assert.equal(error.path.at(-1), "caught_by");
    assert.match(await readFile(file, "utf8"), /DELTA-99/u);
    assert.ok(error.line > 1);
  });
});

test("hashCorpus ignores mutant order and changes across corpus content", () => {
  const first = mutant({ id: "omit_order_write" });
  const second = mutant({
    id: "extra_audit_write",
    kind: "extra_write",
    find: "await writeAudit();",
    replace: "await writeAudit();\nawait writeAudit();",
    seeds: "An extra audit row is written",
    caught_by: "DELTA-03"
  });

  const ordered = { version: 1, mutants: [first, second] };
  const reversed = { version: 1, mutants: [second, first] };
  const changed = { version: 1, mutants: [first, { ...second, replace: "await skipAudit();" }] };
  const removed = { version: 1, mutants: [first] };
  const added = { version: 1, mutants: [first, second, mutant({ id: "wrong_target_mutant" })] };

  assert.equal(hashCorpus(ordered), hashCorpus(reversed));
  assert.notEqual(hashCorpus(ordered), hashCorpus(changed));
  assert.notEqual(hashCorpus(ordered), hashCorpus(removed));
  assert.notEqual(hashCorpus(ordered), hashCorpus(added));
});

test("parseCorpus reports YAML failures as corpus diagnostics", async () => {
  await withRoot("corpus-yaml", async (root) => {
    const file = path.join(root, "corpus.yml");
    const requirementsFile = await writeRequirements(root);

    const result = await parseCorpus("version: [", { file, requirementsFile });

    assert.equal(result.value, null);
    assert.equal(result.diagnostics.errors[0].code, "E_CORPUS_YAML");
    assert.equal(result.diagnostics.errors[0].file, file);
  });
});

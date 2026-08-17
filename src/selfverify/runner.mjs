import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createDbDriver } from "../db/registry.mjs";
import { createDbHooks } from "../db/hooks.mjs";
import { createPgClient } from "../db/drivers/postgres/connect.mjs";
import { loadRuleset } from "../delta/rules/load.mjs";
import { AttestError, InfraError } from "../errors.mjs";
import { tenantPrefixFor } from "../db/tenancy.mjs";
import { applyMutant, revertMutant } from "./mutant.mjs";
import { hashCorpus } from "./corpus.mjs";
import { computeKillRate } from "./killrate.mjs";

const FIXTURE_DIR = path.join("fixtures", "self-verify");
const FIXTURE_APP_DIR = path.join(FIXTURE_DIR, "app");
const RULES_FILE = path.join(FIXTURE_DIR, "rules", "self-verify.rules.yaml");
const SURFACE = "web";
const PASS = 0;
const SCENARIO_FAIL = 1;
const INFRA_ERROR = 2;
const DELTA_MISSING = "E_DELTA_MISSING_MUTATION";
const DELTA_UNEXPLAINED = "E_DELTA_UNEXPLAINED";
const RULE_TOO_BROAD = "E_RULE_TOO_BROAD";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function corpusValue(input) {
  if (Array.isArray(input?.corpus?.mutants)) {
    return input.corpus;
  }

  if (Array.isArray(input?.mutants)) {
    return input;
  }

  throw new TypeError("runSelfVerification corpus must be a loaded corpus or corpus value");
}

function corpusHashFor(input, corpus) {
  if (typeof input?.hash === "string") {
    return input.hash;
  }

  return hashCorpus(corpus);
}

function occurrenceCount(text, needle) {
  let count = 0;
  let offset = 0;

  while (offset <= text.length) {
    const index = text.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }

  return count;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function relativeSlash(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

async function walkFiles(root, dir = root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.toSorted((left, right) => left.name.localeCompare(right.name)).map(async (entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(root, file);
      }
      return entry.isFile() ? [file] : [];
    })
  );

  return nested.flat();
}

export async function hashFixtureTree({ root = process.cwd() } = {}) {
  const fixtureRoot = path.resolve(root, FIXTURE_APP_DIR);
  const files = await walkFiles(fixtureRoot);
  const entries = [];

  for (const file of files) {
    const text = await readFile(file);
    entries.push(`${relativeSlash(fixtureRoot, file)}\0${sha256Text(text)}`);
  }

  return sha256Text(entries.join("\0"));
}

function resolvedMutantFile(root, mutant) {
  return path.resolve(root, mutant.file);
}

async function assertMutantClean(root, mutant) {
  const file = resolvedMutantFile(root, mutant);
  const text = await readFile(file, "utf8");
  const findCount = occurrenceCount(text, mutant.find);
  const replacementCount = mutant.replace.length === 0 ? 0 : occurrenceCount(text, mutant.replace);

  if (findCount !== 1 || replacementCount !== 0) {
    throw new AttestError("E_SELFVERIFY_FIXTURE_DIRTY", "Fixture app is not clean for corpus run.", {
      mutantId: mutant.id,
      file: mutant.file,
      findCount,
      replacementCount
    });
  }
}

async function assertCleanFixture(root, mutants) {
  for (const mutant of mutants) {
    await assertMutantClean(root, mutant);
  }
}

function entity(schema, table) {
  return `${schema}.${table}`;
}

function tenantEntities(schema) {
  return deepFreeze(
    ["order_items", "order_audit", "orders", "customers"].map((table) => ({
      schema,
      table,
      tenantColumn: "tenant_key"
    }))
  );
}

function keyColumns(schema) {
  return deepFreeze({
    [entity(schema, "customers")]: ["tenant_key", "id"],
    [entity(schema, "orders")]: ["tenant_key", "id"],
    [entity(schema, "order_items")]: ["tenant_key", "order_id", "line_number"],
    [entity(schema, "order_audit")]: ["tenant_key", "id"]
  });
}

function createExpectations(schema) {
  return deepFreeze([
    { entity: entity(schema, "orders"), op: "insert", count: 1, where: { id: "order_300", status: "created", total_cents: 9900 } },
    { entity: entity(schema, "order_items"), op: "insert", count: 1, where: { order_id: "order_300", line_number: 1, sku: "new_lamp", quantity: 2 } },
    { entity: entity(schema, "order_items"), op: "insert", count: 1, where: { order_id: "order_300", line_number: 2, sku: "new_shade", quantity: 1 } }
  ]);
}

function deleteExpectations(schema) {
  return deepFreeze([
    { entity: entity(schema, "order_items"), op: "delete", count: 1, where: { order_id: "order_100", line_number: 1 } },
    { entity: entity(schema, "order_items"), op: "delete", count: 1, where: { order_id: "order_100", line_number: 2 } },
    { entity: entity(schema, "order_items"), op: "delete", count: 1, where: { order_id: "order_101", line_number: 1 } },
    { entity: entity(schema, "order_items"), op: "delete", count: 1, where: { order_id: "order_101", line_number: 2 } },
    { entity: entity(schema, "orders"), op: "delete", count: 1, where: { id: "order_100", customer_id: "cust_c" } },
    { entity: entity(schema, "orders"), op: "delete", count: 1, where: { id: "order_101", customer_id: "cust_c" } },
    { entity: entity(schema, "customers"), op: "delete", count: 1, where: { id: "cust_c" } },
    { entity: entity(schema, "order_audit"), op: "insert", count: 2, where: { action: "deleted" } }
  ]);
}

function schemaName(runId, scenarioId) {
  const hash = sha256Text(`${runId}\0${scenarioId}`).slice(0, 24);
  return `sv_${hash}`;
}

function quoteIdent(identifier) {
  if (typeof identifier !== "string" || !/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new TypeError("Self verification schema must be a safe identifier");
  }

  return `"${identifier}"`;
}

async function dropSchema(target, schema, signal) {
  const client = await createPgClient(target, { signal });
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function loadFixtureApp(root, nonce) {
  const file = path.resolve(root, FIXTURE_APP_DIR, "server.mjs");
  const url = pathToFileURL(file);
  url.searchParams.set("selfverify", nonce);
  const mod = await import(url.href);

  return mod.startFixtureApp;
}

async function postJson(url, body, signal) {
  const options = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
  if (signal !== undefined) {
    options.signal = signal;
  }

  const response = await fetch(new URL("/orders", url), options);

  return response.status === 201 ? null : `POST /orders returned ${response.status}`;
}

async function postDelete(url, customerId, signal) {
  const options = {
    method: "POST",
    redirect: "manual"
  };
  if (signal !== undefined) {
    options.signal = signal;
  }

  const response = await fetch(new URL(`/customers/${customerId}/delete`, url), options);

  return response.status === 303 ? null : `POST /customers/${customerId}/delete returned ${response.status}`;
}

function createOrderBody() {
  return deepFreeze({
    customerId: "cust_a",
    orderId: "order_300",
    status: "created",
    totalCents: 9900,
    items: [
      { sku: "new_lamp", quantity: 2, unitCents: 3000 },
      { sku: "new_shade", quantity: 1, unitCents: 3900 }
    ]
  });
}

async function runWindow({ hooks, seq, action, expect, signal, ctx }) {
  const open = { kind: "db_window_open", seq, scenarioId: ctx.scenarioId, surface: SURFACE };
  const close = { kind: "db_window_close", seq, scenarioId: ctx.scenarioId, surface: SURFACE, expect, requireNoUnexplained: true };
  const options = signal === undefined ? { ctx } : { signal, ctx };

  await hooks.onWindowOpen(open, options);
  const actionError = await action();
  if (actionError !== null) {
    throw new AttestError("E_SELFVERIFY_APP_ACTION_FAILED", actionError);
  }

  return hooks.onWindowClose(close, options);
}

function scenarioContexts(runId) {
  return deepFreeze([
    { scenarioId: "self_verify.create_order", seq: 0, kind: "create" },
    { scenarioId: "self_verify.delete_customer", seq: 0, kind: "delete" }
  ].map((item) => ({ ...item, runId, schema: schemaName(runId, item.scenarioId) })));
}

async function runFixtureScenario({ target, ruleset, item, signal, env, root }) {
  const tenantKey = tenantPrefixFor({ runId: item.runId, scenarioId: item.scenarioId, surface: SURFACE });
  const startFixtureApp = await loadFixtureApp(root, `${item.runId}_${item.scenarioId}`);
  const app = await startFixtureApp({ target, schema: item.schema, signal, env, tenantKey });
  const driver = createDbDriver({
    target,
    runId: item.runId,
    scenarioId: item.scenarioId,
    config: { entities: tenantEntities(item.schema), keyColumns: keyColumns(item.schema), surface: SURFACE, logger: false }
  });
  const hooks = createDbHooks({
    driver,
    ruleset: item.kind === "create" ? ruleset : null,
    config: { tenantEntities: tenantEntities(item.schema), ruleHealthPath: null },
    runId: item.runId
  });

  try {
    const ctx = { runId: item.runId, scenarioId: item.scenarioId, surface: SURFACE, entities: tenantEntities(item.schema) };
    if (item.kind === "create") {
      return await runWindow({
        hooks,
        seq: item.seq,
        expect: createExpectations(item.schema),
        action: () => postJson(app.url, createOrderBody(), signal),
        signal,
        ctx
      });
    }

    return await runWindow({
      hooks,
      seq: item.seq,
      expect: deleteExpectations(item.schema),
      action: () => postDelete(app.url, "cust_c", signal),
      signal,
      ctx
    });
  } finally {
    await hooks.teardown({ signal }).catch(() => {});
    await app.close().catch(() => {});
    await dropSchema(target, item.schema, signal).catch(() => {});
  }
}

function failureText(error) {
  const delta = error?.details?.delta;
  const shortfalls = asArray(delta?.shortfalls).map((item) => JSON.stringify(item));
  const unexplained = asArray(delta?.unexplained).map((item) => JSON.stringify(item));
  return [
    error?.code,
    error?.message,
    error?.details?.causeCode,
    error?.details?.causeMessage,
    error?.details?.causeText,
    ...shortfalls,
    ...unexplained
  ].filter(Boolean).join(" ");
}

async function runFixtureSuite({ target, ruleset, runId, signal, env, root }) {
  try {
    for (const item of scenarioContexts(runId)) {
      try {
        await runFixtureScenario({ target, ruleset, item, signal, env, root });
      } catch (error) {
        throw new AttestError("E_SELFVERIFY_SCENARIO_FAILED", "Self verification scenario failed.", {
          scenarioId: item.scenarioId,
          causeCode: error?.code ?? null,
          causeMessage: error instanceof Error ? error.message : String(error),
          causeText: failureText(error)
        });
      }
    }

    return deepFreeze({ exitCode: PASS, reason: "passed", error: null, text: "" });
  } catch (error) {
    const exitCode = error instanceof InfraError ? INFRA_ERROR : SCENARIO_FAIL;
    return deepFreeze({
      exitCode,
      reason: error?.code ?? "E_SELFVERIFY_RUN_FAILED",
      error,
      text: failureText(error) || (error instanceof Error ? (error.stack ?? error.message) : String(error))
    });
  }
}

function attributable(caughtBy, run) {
  const code = run.reason;
  if (caughtBy === "DELTA-01") {
    return code === DELTA_MISSING || run.text.includes(DELTA_MISSING);
  }

  if (caughtBy === "DELTA-03") {
    return [DELTA_UNEXPLAINED, RULE_TOO_BROAD].includes(code) || run.text.includes(DELTA_UNEXPLAINED);
  }

  return run.text.includes(caughtBy);
}

function scoreRun(mutant, run) {
  if (run.exitCode === PASS) {
    return deepFreeze({ mutantId: mutant.id, outcome: "survived", exitCode: run.exitCode, reason: "run passed" });
  }

  if (run.exitCode === SCENARIO_FAIL && attributable(mutant.caught_by, run)) {
    return deepFreeze({ mutantId: mutant.id, outcome: "killed", exitCode: run.exitCode, reason: run.text || run.reason });
  }

  return deepFreeze({ mutantId: mutant.id, outcome: "error", exitCode: run.exitCode, reason: run.reason });
}

function errorResult(mutant, error) {
  return deepFreeze({
    mutantId: mutant.id,
    outcome: "error",
    exitCode: INFRA_ERROR,
    reason: error?.code ?? error?.message ?? "E_SELFVERIFY_MUTANT_ERROR"
  });
}

async function loadRules(root, io) {
  const loader = io.loadRuleset ?? loadRuleset;
  const result = await loader({ file: path.resolve(root, RULES_FILE) });
  if (result?.value === null) {
    throw new AttestError("E_SELFVERIFY_RULESET_INVALID", "Self verification ruleset did not load.");
  }

  return result?.value ?? result;
}

async function runBaseline({ runSuite, target, ruleset, signal, env, root }) {
  const baseline = await runSuite({ target, ruleset, runId: `selfv_base_${randomUUID()}`, signal, env, root });
  if (baseline.exitCode !== PASS) {
    throw new AttestError("E_SELFVERIFY_BASELINE_FAILED", "Self verification baseline must pass.", {
      reason: baseline.reason,
      text: baseline.text ?? ""
    });
  }

  return deepFreeze({ outcome: "passed", exitCode: baseline.exitCode, reason: baseline.reason });
}

async function runOneMutant({ mutant, runSuite, target, ruleset, root, signal, env, deps }) {
  let applied = false;
  try {
    await deps.applyMutant(mutant, { root });
    applied = true;
    const run = await runSuite({ target, ruleset, runId: `selfv_${mutant.id}_${randomUUID()}`, signal, env, root });
    return scoreRun(mutant, run);
  } catch (error) {
    return errorResult(mutant, error);
  } finally {
    if (applied) {
      await deps.revertMutant(mutant, { root });
    }
  }
}

function dependencies(io) {
  return deepFreeze({
    applyMutant: io.applyMutant ?? applyMutant,
    revertMutant: io.revertMutant ?? revertMutant,
    hashFixtureTree: io.hashFixtureTree ?? hashFixtureTree
  });
}

export async function runSelfVerification({
  corpus,
  target,
  artifactRoot = null,
  concurrency = 1,
  signal,
  io = {}
} = {}) {
  const root = path.resolve(io.cwd ?? process.cwd());
  const parsedCorpus = corpusValue(corpus);
  const mutants = asArray(parsedCorpus.mutants);
  const deps = dependencies(io);
  const ruleset = await loadRules(root, io);
  const runSuite = io.runFixtureSuite ?? runFixtureSuite;
  const env = io.env ?? process.env;
  const runSignal = signal ?? new AbortController().signal;

  await assertCleanFixture(root, mutants);
  const beforeHash = await deps.hashFixtureTree({ root });
  const baseline = await runBaseline({ runSuite, target, ruleset, signal: runSignal, env, root });
  const results = [];

  for (const mutant of mutants) {
    results.push(await runOneMutant({ mutant, runSuite, target, ruleset, root, signal: runSignal, env, deps }));
  }

  const afterHash = await deps.hashFixtureTree({ root });
  const restored = beforeHash === afterHash;
  const killRate = computeKillRate({
    baseline,
    results,
    corpusHash: corpusHashFor(corpus, parsedCorpus),
    rulesetHash: ruleset.hash,
    fixtureTreeHash: afterHash,
    restored
  });

  return deepFreeze({
    baseline,
    results,
    restored,
    killRate,
    artifactRoot,
    concurrency
  });
}

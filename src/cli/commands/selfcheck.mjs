import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { resolveTarget, parseTarget, describeTarget } from "../../config/targets.mjs";
import { AttestError, UsageError } from "../../errors.mjs";
import { formatDiagnostic } from "../../ir/diagnostics.mjs";
import { loadCorpus } from "../../selfverify/corpus.mjs";
import { runSelfVerification } from "../../selfverify/runner.mjs";
import { EXIT } from "../exit-codes.mjs";

const DEFAULT_CORPUS = path.join("fixtures", "self-verify", "corpus.yaml");
const DEFAULT_BASELINE = path.join("fixtures", "self-verify", "baseline.json");
const DASH = "-";
const UPDATE_FLAG = `${DASH}${DASH}update-baseline`;

const CountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    killed: z.number().int().nonnegative(),
    survived: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    scored: z.number().int().nonnegative()
  })
  .strict();

const HashesSchema = z
  .object({
    corpus: z.string().regex(/^[0-9a-f]{64}$/u),
    ruleset: z.string().regex(/^[0-9a-f]{64}$/u),
    fixtureTree: z.string().regex(/^[0-9a-f]{64}$/u)
  })
  .strict();

const MutantSchema = z
  .object({
    id: z.string().min(1),
    outcome: z.enum(["killed", "survived", "error"])
  })
  .strict();

const BaselineSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.string().min(1),
    corpus: z.string().min(1),
    rate: z.number().min(0).max(1),
    ratePercent: z.number().min(0).max(100),
    confidence: z.enum(["clean", "degraded"]),
    counts: CountsSchema,
    hashes: HashesSchema,
    mutants: z.array(MutantSchema)
  })
  .strict();

function write(stream, text) {
  stream?.write?.(text);
}

function resolveFromCwd(cwd, file) {
  return path.isAbsolute(file) ? file : path.join(cwd, file);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function nowIso(io) {
  const now = typeof io.now === "function" ? io.now() : new Date();
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function baselinePath(cwd, flags) {
  return resolveFromCwd(cwd, flags.baseline ?? DEFAULT_BASELINE);
}

async function loadBaseline(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UsageError("E_SELFCHECK_BASELINE_MISSING", "Selfcheck baseline file is missing.", { file });
    }
    throw new UsageError("E_SELFCHECK_BASELINE_READ", "Selfcheck baseline file could not be read.", {
      file,
      reason: error.message
    });
  }

  try {
    return deepFreeze(BaselineSchema.parse(JSON.parse(text)));
  } catch (error) {
    throw new UsageError("E_SELFCHECK_BASELINE_INVALID", "Selfcheck baseline file is malformed.", {
      file,
      reason: error.message
    });
  }
}

function normalizeCorpusResult(result, stderr) {
  if (result?.corpus !== undefined && result?.hash !== undefined) {
    return result;
  }
  if (result?.value !== undefined) {
    if (result.value !== null) {
      return result.value;
    }
    for (const diagnostic of result.diagnostics?.errors ?? []) {
      write(stderr, `${formatDiagnostic(diagnostic)}\n`);
    }
  }
  throw new UsageError("E_SELFCHECK_CORPUS_INVALID", "Self verification corpus failed to load.");
}

async function loadCorpusForRun({ file, stderr, deps }) {
  const result = await deps.loadCorpus({ file });
  return normalizeCorpusResult(result, stderr);
}

function allowlistFromUrl(url) {
  const target = parseTarget(url);
  return Object.freeze([
    Object.freeze({
      host: target.host,
      database: target.database,
      nonProd: true,
      note: "selfcheck environment database target"
    })
  ]);
}

function targetFromEnv(env) {
  const url = env.ATTEST_DB_URL ?? env.ATTEST_PG_URL;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new UsageError("E_SELFCHECK_DB_URL_MISSING", "Set ATTEST_DB_URL before running selfcheck.");
  }
  return resolveTarget({ url, allowlist: allowlistFromUrl(url) });
}

function baselinePassed(killRate) {
  return killRate?.baseline?.outcome === "passed" && killRate.baseline.exitCode === EXIT.PASS;
}

function assertReportUsable(result) {
  const killRate = result?.killRate;
  if (!baselinePassed(killRate)) {
    throw new AttestError("E_SELFVERIFY_BASELINE_FAILED", "Self verification baseline must pass.");
  }
  if (result?.restored !== true || killRate.restored !== true) {
    throw new AttestError("E_SELFVERIFY_FIXTURE_RESTORE_FAILED", "Self verification fixture was not restored.");
  }
  return killRate;
}

function mutantOutcomes(killRate) {
  return killRate.results.map((result) =>
    Object.freeze({
      id: result.mutantId,
      outcome: result.outcome
    })
  );
}

function baselineRecord({ killRate, corpusFile, updatedAt }) {
  return deepFreeze({
    version: 1,
    updatedAt,
    corpus: corpusFile,
    rate: killRate.rate,
    ratePercent: killRate.ratePercent,
    confidence: killRate.confidence,
    counts: killRate.counts,
    hashes: killRate.hashes,
    mutants: mutantOutcomes(killRate)
  });
}

function publicRecord({ baseline, killRate, status, startedAt, finishedAt }) {
  const record = {
    version: 1,
    status,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    baseline: {
      rate: baseline.rate,
      ratePercent: baseline.ratePercent,
      counts: baseline.counts,
      hashes: baseline.hashes
    },
    current: {
      rate: killRate.rate,
      ratePercent: killRate.ratePercent,
      confidence: killRate.confidence,
      counts: killRate.counts,
      hashes: killRate.hashes,
      mutants: mutantOutcomes(killRate)
    }
  };
  return deepFreeze(record);
}

function changedHashes(baseline, killRate) {
  return Object.keys(baseline.hashes).filter((key) => baseline.hashes[key] !== killRate.hashes[key]);
}

function outcomeMap(mutants) {
  return new Map(mutants.map((mutant) => [mutant.id, mutant.outcome]));
}

function newlySurvived(baseline, killRate) {
  const previous = outcomeMap(baseline.mutants);
  return killRate.results
    .filter((result) => result.outcome === "survived" && previous.get(result.mutantId) === "killed")
    .map((result) => result.mutantId);
}

function currentSurvivors(killRate) {
  return killRate.results.filter((result) => result.outcome === "survived").map((result) => result.mutantId);
}

function gateStatus({ baseline, killRate }) {
  const hashChanges = changedHashes(baseline, killRate);
  if (hashChanges.length > 0) {
    return Object.freeze({ ok: false, reason: "hash_mismatch", hashChanges });
  }
  if (killRate.counts.errored > 0) {
    return Object.freeze({ ok: false, reason: "errored_mutants", hashChanges });
  }
  if (killRate.rate < baseline.rate) {
    return Object.freeze({ ok: false, reason: "rate_drop", hashChanges });
  }
  return Object.freeze({ ok: true, reason: "passed", hashChanges });
}

function percent(value) {
  return `${Number((value * 100).toFixed(2)).toFixed(2)}%`;
}

function linesForHuman({ baseline, killRate, target, status, updating }) {
  const lines = [
    `Selfcheck target: ${describeTarget(target)}`,
    `Mutants: killed ${killRate.counts.killed}, survived ${killRate.counts.survived}, errored ${killRate.counts.errored}, total ${killRate.counts.total}`,
    `Kill rate: ${percent(killRate.rate)} (${killRate.rate})`,
    `Baseline: ${percent(baseline.rate)} (${baseline.rate})`,
    `Hashes: corpus ${killRate.hashes.corpus}, ruleset ${killRate.hashes.ruleset}, fixture ${killRate.hashes.fixtureTree}`
  ];
  if (killRate.counts.errored > 0) {
    lines.push("Confidence degraded: one or more mutants errored and were not counted as kills.");
  }
  if (status.reason === "hash_mismatch") {
    lines.push(`Not like for like: ${status.hashChanges.join(", ")} changed since the recorded baseline.`);
  }
  if (status.reason === "rate_drop") {
    lines.push(`Newly survived mutants: ${newlySurvived(baseline, killRate).join(", ") || "none detected from baseline outcomes"}`);
    lines.push(`Current survivors: ${currentSurvivors(killRate).join(", ") || "none"}`);
  }
  if (status.ok && killRate.rate > baseline.rate && !updating) {
    lines.push(`Kill rate is above baseline. Run attest selfcheck ${UPDATE_FLAG} to move the recorded baseline deliberately.`);
  }
  return `${lines.join("\n")}\n`;
}

function dependencies(io) {
  return Object.freeze({
    loadCorpus: io.loadCorpus ?? loadCorpus,
    runSelfVerification: io.runSelfVerification ?? runSelfVerification,
    writeFile: io.writeFile ?? writeFile
  });
}

async function writeBaseline({ file, record, deps }) {
  await deps.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function errorText(error) {
  return `${error.code ?? "E_SELFCHECK_FAILED"}  ${error.message}\n`;
}

async function execute(flags, io, deps, startedAt) {
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const corpusFile = resolveFromCwd(cwd, flags.corpus ?? DEFAULT_CORPUS);
  const loaded = await loadCorpusForRun({ file: corpusFile, stderr: io.stderr, deps });
  const baseline = await loadBaseline(baselinePath(cwd, flags));
  const target = flags.target ?? io.target ?? targetFromEnv(env);
  const result = await deps.runSelfVerification({ corpus: loaded, target, io: { env, cwd } });
  const killRate = assertReportUsable(result);
  const status = gateStatus({ baseline, killRate });
  const finishedAt = nowIso(io);

  if (flags.updateBaseline && !status.ok && status.reason !== "rate_drop") {
    throw new UsageError("E_SELFCHECK_BASELINE_NOT_COMPARABLE", "Selfcheck baseline cannot be updated from an unclean run.");
  }
  if (flags.updateBaseline && killRate.counts.errored > 0) {
    throw new UsageError("E_SELFCHECK_BASELINE_NOT_CLEAN", "Selfcheck baseline update requires zero errored mutants.");
  }
  if (flags.updateBaseline) {
    const next = baselineRecord({ killRate, corpusFile: flags.corpus ?? DEFAULT_CORPUS, updatedAt: finishedAt });
    await writeBaseline({ file: baselinePath(cwd, flags), record: next, deps });
  }
  const finalStatus = flags.updateBaseline ? Object.freeze({ ok: true, reason: "updated", hashChanges: [] }) : status;

  if (flags.json) {
    write(io.stdout, `${JSON.stringify(publicRecord({ baseline, killRate, status: finalStatus.reason, startedAt, finishedAt }), null, 2)}\n`);
  } else {
    write(io.stdout, linesForHuman({ baseline, killRate, target, status: finalStatus, updating: flags.updateBaseline }));
    if (flags.updateBaseline) {
      write(io.stdout, `Baseline updated: ${percent(baseline.rate)} to ${percent(killRate.rate)}\n`);
    }
  }

  return finalStatus.ok ? EXIT.PASS : EXIT.SCENARIO_FAILURE;
}

export async function selfcheckCommand(flags = {}, io = {}) {
  const injected = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    now: io.now,
    target: io.target
  };
  const deps = dependencies(io);
  const startedAt = nowIso(injected);

  try {
    return await execute(flags, injected, deps, startedAt);
  } catch (error) {
    if (error?.code === "E_SELFVERIFY_BASELINE_FAILED") {
      write(injected.stderr, "E_SELFVERIFY_BASELINE_FAILED  Self verification baseline scenario failed. No kill rate printed.\n");
      return EXIT.HARNESS_ERROR;
    }
    write(injected.stderr, errorText(error));
    return error instanceof UsageError ? EXIT.USAGE_ERROR : EXIT.HARNESS_ERROR;
  }
}

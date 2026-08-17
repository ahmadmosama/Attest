import { readFile } from "node:fs/promises";
import path from "node:path";

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { z } from "zod";

import { hashRuleset } from "../delta/rules/hash.mjs";
import { DiagnosticList } from "../ir/diagnostics.mjs";
import { MutantSchema } from "./mutant.mjs";

export const CORPUS_VERSION = 1;

const ROOT_KEY = "";
const REQUIREMENT_PATTERN = /\b[A-Z][A-Z0-9]+-\d{2}\b/gu;

const CorpusSchema = z
  .object({
    version: z.literal(CORPUS_VERSION, {
      error: () => `corpus version must be ${CORPUS_VERSION}`
    }),
    mutants: z.array(MutantSchema).default([])
  })
  .strict();

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function pathKey(pathValue) {
  return typeof pathValue === "string"
    ? pathValue
    : pathValue.map((segment) => String(segment)).join(".");
}

function normalizePath(pathValue) {
  if (pathValue === undefined || pathValue === null || pathValue === ROOT_KEY) {
    return [];
  }
  if (Array.isArray(pathValue)) {
    return pathValue;
  }
  if (typeof pathValue !== "string") {
    throw new TypeError("Path must be an array or dotted string");
  }
  return pathValue.length === 0
    ? []
    : pathValue.split(".").map((segment) => {
        const numeric = Number(segment);
        return Number.isInteger(numeric) && String(numeric) === segment ? numeric : segment;
      });
}

function offsetOf(node) {
  return node?.range?.[0] ?? 0;
}

function posFromOffset(lineCounter, offset) {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const position = lineCounter.linePos(safeOffset);
  return Object.freeze({
    line: Math.max(1, position.line),
    col: Math.max(1, position.col),
    offset: safeOffset
  });
}

function posFromNode(lineCounter, node) {
  return posFromOffset(lineCounter, offsetOf(node));
}

function scalarKey(key) {
  return isScalar(key) ? String(key.value) : String(key?.toString?.() ?? "");
}

function addPosition(index, lineCounter, file, pathValue, node) {
  index[pathKey(pathValue)] = Object.freeze({ file, ...posFromNode(lineCounter, node) });
}

function walkPositions(node, lineCounter, file, index, pathValue = []) {
  if (node === null || node === undefined) {
    return;
  }

  addPosition(index, lineCounter, file, pathValue, node);
  if (isMap(node)) {
    for (const pair of node.items) {
      const childPath = [...pathValue, scalarKey(pair.key)];
      addPosition(index, lineCounter, file, childPath, pair.value ?? pair.key);
      walkPositions(pair.value, lineCounter, file, index, childPath);
    }
    return;
  }

  if (isSeq(node)) {
    for (const [indexInSeq, item] of node.items.entries()) {
      walkPositions(item, lineCounter, file, index, [...pathValue, indexInSeq]);
    }
  }
}

function buildPositionIndex(doc, lineCounter, file) {
  const index = {};
  walkPositions(doc.contents, lineCounter, file, index);
  return Object.freeze(
    Object.fromEntries(Object.entries(index).map(([key, value]) => [key, Object.freeze(value)]))
  );
}

function positionOf(index, pathValue) {
  const segments = normalizePath(pathValue);
  for (let end = segments.length; end >= 0; end -= 1) {
    const key = pathKey(segments.slice(0, end));
    if (index[key] !== undefined) {
      return index[key];
    }
  }
  return Object.freeze({ line: 1, col: 1, offset: 0 });
}

function addDiagnostic(diagnostics, { file, line = 1, col = 1, code, reason, severity, path: diagPath }) {
  diagnostics.add({ file, line, col, code, reason, severity, path: diagPath });
  return diagnostics;
}

function yamlErrorPos(lineCounter, error) {
  if (Array.isArray(error.linePos)) {
    const position = error.linePos[0];
    return { line: Math.max(1, position.line), col: Math.max(1, position.col) };
  }

  const position = posFromOffset(lineCounter, Array.isArray(error.pos) ? error.pos[0] : 0);
  return { line: position.line, col: position.col };
}

function addYamlDiagnostic(diagnostics, file, lineCounter, error, severity = "error") {
  const pos = yamlErrorPos(lineCounter, error);
  return addDiagnostic(diagnostics, {
    file,
    line: pos.line,
    col: pos.col,
    code: "E_CORPUS_YAML",
    reason: error.message.split("\n")[0],
    severity
  });
}

function scanUnsupportedYaml(node, lineCounter, file, diagnostics) {
  if (node === null || node === undefined) {
    return;
  }

  if (node.anchor !== undefined || isAlias(node)) {
    const pos = posFromNode(lineCounter, node);
    addDiagnostic(diagnostics, {
      file,
      line: pos.line,
      col: pos.col,
      code: "E_CORPUS_YAML_UNSUPPORTED",
      reason: isAlias(node) ? "YAML aliases are not supported" : "YAML anchors are not supported"
    });
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      scanUnsupportedYaml(pair.key, lineCounter, file, diagnostics);
      scanUnsupportedYaml(pair.value, lineCounter, file, diagnostics);
    }
    return;
  }

  if (isSeq(node)) {
    for (const item of node.items) {
      scanUnsupportedYaml(item, lineCounter, file, diagnostics);
    }
  }
}

function addSchemaIssues(diagnostics, file, positions, issues) {
  for (const issue of issues) {
    const pos = positionOf(positions, issue.path);
    addDiagnostic(diagnostics, {
      file,
      line: pos.line,
      col: pos.col,
      code: "E_CORPUS_SCHEMA",
      reason: issue.message,
      path: issue.path
    });
  }
  return diagnostics;
}

function extractRequirementIds(text) {
  return Object.freeze(new Set(text.match(REQUIREMENT_PATTERN) ?? []));
}

async function loadRequirementIds(requirementsFile) {
  const text = await readFile(requirementsFile, "utf8");
  return extractRequirementIds(text);
}

function addDuplicateDiagnostics(diagnostics, file, positions, mutants) {
  const seen = new Map();

  for (const [index, mutant] of mutants.entries()) {
    const previous = seen.get(mutant.id);
    if (previous === undefined) {
      seen.set(mutant.id, index);
      continue;
    }

    const currentPos = positionOf(positions, ["mutants", index, "id"]);
    const previousPos = positionOf(positions, ["mutants", previous, "id"]);
    addDiagnostic(diagnostics, {
      file,
      line: currentPos.line,
      col: currentPos.col,
      code: "E_CORPUS_DUPLICATE_ID",
      reason: `duplicate mutant id "${mutant.id}" also appears on line ${previousPos.line}`,
      path: ["mutants", index, "id"]
    });
    addDiagnostic(diagnostics, {
      file,
      line: previousPos.line,
      col: previousPos.col,
      code: "E_CORPUS_DUPLICATE_ID",
      reason: `duplicate mutant id "${mutant.id}" also appears on line ${currentPos.line}`,
      path: ["mutants", previous, "id"]
    });
  }

  return diagnostics;
}

function addRequirementDiagnostics(diagnostics, file, positions, corpus, requirementIds) {
  for (const [index, mutant] of corpus.mutants.entries()) {
    if (requirementIds.has(mutant.caught_by)) {
      continue;
    }

    const pos = positionOf(positions, ["mutants", index, "caught_by"]);
    addDiagnostic(diagnostics, {
      file,
      line: pos.line,
      col: pos.col,
      code: "E_CORPUS_REQUIREMENT_UNKNOWN",
      reason: `unknown requirement id "${mutant.caught_by}"`,
      path: ["mutants", index, "caught_by"]
    });
  }

  return diagnostics;
}

function loadedCorpus({ file, corpus }) {
  const frozenCorpus = deepFreeze(corpus);
  const result = {
    path: file,
    corpus: frozenCorpus,
    hash: hashCorpus(frozenCorpus),
    byId: Object.fromEntries(frozenCorpus.mutants.map((mutant) => [mutant.id, mutant]))
  };

  return deepFreeze(result);
}

async function checkedRequirements({ diagnostics, requirementsFile }) {
  try {
    return await loadRequirementIds(requirementsFile);
  } catch (error) {
    addDiagnostic(diagnostics, {
      file: requirementsFile,
      code: "E_CORPUS_REQUIREMENTS_READ_FAILED",
      reason: error.message
    });
    return null;
  }
}

export function hashCorpus(corpus) {
  const parsed = CorpusSchema.parse(corpus);
  return hashRuleset({
    version: parsed.version,
    rules: parsed.mutants
  });
}

function parseYamlDocument(text, { file, diagnostics, lineCounter }) {
  try {
    const doc = parseDocument(text, {
      lineCounter,
      keepSourceTokens: true,
      uniqueKeys: true,
      merge: false
    });

    for (const warning of doc.warnings) {
      addYamlDiagnostic(diagnostics, file, lineCounter, warning, "warning");
    }
    for (const error of doc.errors) {
      addYamlDiagnostic(diagnostics, file, lineCounter, error);
    }

    return doc.errors.length === 0 ? doc : null;
  } catch (error) {
    addDiagnostic(diagnostics, {
      file,
      code: "E_CORPUS_YAML",
      reason: error.message
    });
    return null;
  }
}

function documentValue(doc, { file, diagnostics }) {
  try {
    return doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    addDiagnostic(diagnostics, {
      file,
      code: "E_CORPUS_YAML_UNSUPPORTED",
      reason: error.message
    });
    return null;
  }
}

async function validateCorpusValue({ value, file, positions, diagnostics, requirementsFile }) {
  const parsed = CorpusSchema.safeParse(value);
  if (!parsed.success) {
    addSchemaIssues(diagnostics, file, positions, parsed.error.issues);
    return null;
  }

  addDuplicateDiagnostics(diagnostics, file, positions, parsed.data.mutants);
  if (!diagnostics.ok) {
    return null;
  }

  const requirementIds = await checkedRequirements({ diagnostics, requirementsFile });
  if (requirementIds === null) {
    return null;
  }

  addRequirementDiagnostics(diagnostics, file, positions, parsed.data, requirementIds);
  if (!diagnostics.ok) {
    return null;
  }

  return loadedCorpus({ file, corpus: parsed.data });
}

export async function parseCorpus(text, { file, requirementsFile }) {
  const diagnostics = new DiagnosticList();
  const lineCounter = new LineCounter();
  const doc = parseYamlDocument(text, { file, diagnostics, lineCounter });
  if (doc === null) {
    return { value: null, diagnostics };
  }

  const positions = buildPositionIndex(doc, lineCounter, file);
  scanUnsupportedYaml(doc.contents, lineCounter, file, diagnostics);
  const value = diagnostics.ok ? documentValue(doc, { file, diagnostics }) : null;
  if (value === null) {
    return { value: null, diagnostics };
  }

  return {
    value: await validateCorpusValue({ value, file, positions, diagnostics, requirementsFile }),
    diagnostics
  };
}

export async function loadCorpus({
  file,
  requirementsFile = path.resolve(process.cwd(), ".planning/REQUIREMENTS.md")
}) {
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new TypeError("loadCorpus file must be a non empty string");
  }

  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      const diagnostics = new DiagnosticList([
        {
          file,
          line: 1,
          col: 1,
          code: "E_CORPUS_NOT_FOUND",
          reason: "Corpus file not found"
        }
      ]);
      return { value: null, diagnostics };
    }

    const diagnostics = new DiagnosticList([
      {
        file,
        line: 1,
        col: 1,
        code: "E_CORPUS_READ_FAILED",
        reason: error.message
      }
    ]);
    return { value: null, diagnostics };
  }

  const result = await parseCorpus(text, { file, requirementsFile });
  return result.diagnostics.ok ? result.value : result;
}

import { readFile } from "node:fs/promises";

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

import { DiagnosticList } from "../../ir/diagnostics.mjs";
import { hashRuleset } from "./hash.mjs";
import { RULESET_VERSION, RulesetSchema } from "./schema.mjs";

const ROOT_KEY = "";
const EMPTY_RULESET = Object.freeze({
  version: RULESET_VERSION,
  rules: Object.freeze([])
});

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function pathKey(path) {
  return typeof path === "string" ? path : path.map((segment) => String(segment)).join(".");
}

function normalizePath(path) {
  if (path === undefined || path === null || path === ROOT_KEY) {
    return [];
  }
  if (Array.isArray(path)) {
    return path;
  }
  if (typeof path !== "string") {
    throw new TypeError("Path must be an array or dotted string");
  }
  return path.length === 0
    ? []
    : path.split(".").map((segment) => {
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

function addPosition(index, lineCounter, file, path, node) {
  index[pathKey(path)] = Object.freeze({ file, ...posFromNode(lineCounter, node) });
}

function walkPositions(node, lineCounter, file, index, path = []) {
  if (node === null || node === undefined) {
    return;
  }

  addPosition(index, lineCounter, file, path, node);
  if (isMap(node)) {
    for (const pair of node.items) {
      const childPath = [...path, scalarKey(pair.key)];
      addPosition(index, lineCounter, file, childPath, pair.value ?? pair.key);
      walkPositions(pair.value, lineCounter, file, index, childPath);
    }
    return;
  }

  if (isSeq(node)) {
    for (const [indexInSeq, item] of node.items.entries()) {
      walkPositions(item, lineCounter, file, index, [...path, indexInSeq]);
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

function positionOf(index, path) {
  const segments = normalizePath(path);
  for (let end = segments.length; end >= 0; end -= 1) {
    const key = pathKey(segments.slice(0, end));
    if (index[key] !== undefined) {
      return index[key];
    }
  }
  return Object.freeze({ line: 1, col: 1, offset: 0 });
}

function addDiagnostic(diagnostics, { file, line = 1, col = 1, code, reason, severity, path }) {
  diagnostics.add({ file, line, col, code, reason, severity, path });
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
    code: "E_RULESET_YAML",
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
      code: "E_RULESET_YAML_UNSUPPORTED",
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
      code: "E_RULESET_SCHEMA",
      reason: issue.message,
      path: issue.path
    });
  }
  return diagnostics;
}

function loadedRuleset({ file, ruleset }) {
  const rulesetHash = hashRuleset(ruleset);
  const result = {
    path: file,
    ruleset,
    hash: rulesetHash,
    byId: Object.fromEntries(ruleset.rules.map((rule) => [rule.id, rule]))
  };

  return deepFreeze(result);
}

export function parseRuleset(text, { file }) {
  const diagnostics = new DiagnosticList();
  const lineCounter = new LineCounter();
  let doc;

  try {
    doc = parseDocument(text, {
      lineCounter,
      keepSourceTokens: true,
      uniqueKeys: true,
      merge: false
    });
  } catch (error) {
    return {
      value: null,
      diagnostics: addDiagnostic(diagnostics, {
        file,
        code: "E_RULESET_YAML",
        reason: error.message
      })
    };
  }

  for (const warning of doc.warnings) {
    addYamlDiagnostic(diagnostics, file, lineCounter, warning, "warning");
  }
  for (const error of doc.errors) {
    addYamlDiagnostic(diagnostics, file, lineCounter, error);
  }
  if (doc.errors.length > 0) {
    return { value: null, diagnostics };
  }

  const positions = buildPositionIndex(doc, lineCounter, file);
  scanUnsupportedYaml(doc.contents, lineCounter, file, diagnostics);
  if (!diagnostics.ok) {
    return { value: null, diagnostics };
  }

  let value;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    addDiagnostic(diagnostics, {
      file,
      code: "E_RULESET_YAML_UNSUPPORTED",
      reason: error.message
    });
    return { value: null, diagnostics };
  }

  const parsed = RulesetSchema.safeParse(value);
  if (!parsed.success) {
    return {
      value: null,
      diagnostics: addSchemaIssues(diagnostics, file, positions, parsed.error.issues)
    };
  }

  return {
    value: loadedRuleset({ file, ruleset: parsed.data }),
    diagnostics
  };
}

export async function loadRuleset({ file }) {
  if (file === null) {
    return loadedRuleset({ file: null, ruleset: EMPTY_RULESET });
  }
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new TypeError("loadRuleset file must be a non empty string or null");
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
          code: "E_RULESET_NOT_FOUND",
          reason: "Ruleset file not found"
        }
      ]);
      return { value: null, diagnostics };
    }

    const diagnostics = new DiagnosticList([
      {
        file,
        line: 1,
        col: 1,
        code: "E_RULESET_READ_FAILED",
        reason: error.message
      }
    ]);
    return { value: null, diagnostics };
  }

  const result = parseRuleset(text, { file });
  return result.diagnostics.ok ? result.value : result;
}

import { readFile, stat } from "node:fs/promises";

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

import { DiagnosticList } from "./diagnostics.mjs";
import { OPS } from "./ops.mjs";
import { ScenarioSchema } from "./schema.mjs";

const MAX_SCENARIO_BYTES = 1024 * 1024;
const ROOT_KEY = "";

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

export function positionOf(index, path) {
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
    code: "E_YAML_SYNTAX",
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
      code: "E_YAML_UNSUPPORTED",
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
      code: "E_SCHEMA",
      reason: issue.message,
      path: issue.path
    });
  }
  return diagnostics;
}

function valueAtPath(value, path) {
  return path.reduce((current, segment) => current?.[segment], value);
}

function branchIssuesForKnownOp(issue, value) {
  if (issue.code !== "invalid_union" || !Array.isArray(issue.errors)) {
    return [];
  }

  const node = valueAtPath(value, issue.path);
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return [];
  }

  const opName = Object.keys(node).find((key) => OPS.includes(key));
  if (opName === undefined) {
    return [];
  }

  return issue.errors
    .flat()
    .filter((branchIssue) => branchIssue.path[0] === opName)
    .map((branchIssue) => ({ ...branchIssue, path: [...issue.path, ...branchIssue.path] }));
}

function schemaIssuesFor(value, issues) {
  return issues.flatMap((issue) => {
    const branchIssues = branchIssuesForKnownOp(issue, value);
    return branchIssues.length > 0 ? branchIssues : [issue];
  });
}

function makeAst({ value, positions, file }) {
  return Object.freeze({
    value,
    positions,
    file,
    pos: positionOf(positions, []),
    positionOf(path) {
      return positionOf(positions, path);
    }
  });
}

function fileDiagnostic(file, code, reason) {
  return addDiagnostic(new DiagnosticList(), { file, code, reason });
}

export function parseScenarioText(text, { file }) {
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
      ast: null,
      diagnostics: addDiagnostic(diagnostics, {
        file,
        code: "E_YAML_SYNTAX",
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
    return { ast: null, diagnostics };
  }

  const positions = buildPositionIndex(doc, lineCounter, file);
  scanUnsupportedYaml(doc.contents, lineCounter, file, diagnostics);
  if (!diagnostics.ok) {
    return { ast: makeAst({ value: null, positions, file }), diagnostics };
  }

  let value;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    addDiagnostic(diagnostics, {
      file,
      code: "E_YAML_UNSUPPORTED",
      reason: error.message
    });
    return { ast: makeAst({ value: null, positions, file }), diagnostics };
  }

  const parsed = ScenarioSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ast: makeAst({ value, positions, file }),
      diagnostics: addSchemaIssues(
        diagnostics,
        file,
        positions,
        schemaIssuesFor(value, parsed.error.issues)
      )
    };
  }

  return { ast: makeAst({ value: parsed.data, positions, file }), diagnostics };
}

export async function parseScenarioFile(path) {
  try {
    const fileStats = await stat(path);
    if (fileStats.size > MAX_SCENARIO_BYTES) {
      return {
        ast: null,
        diagnostics: fileDiagnostic(path, "E_SCENARIO_TOO_LARGE", "Scenario file exceeds 1 MiB")
      };
    }
    return parseScenarioText(await readFile(path, "utf8"), { file: path });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ast: null,
        diagnostics: fileDiagnostic(path, "E_SCENARIO_NOT_FOUND", "Scenario file not found")
      };
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return {
        ast: null,
        diagnostics: fileDiagnostic(path, "E_SCENARIO_UNREADABLE", "Scenario file is not readable")
      };
    }
    return {
      ast: null,
      diagnostics: fileDiagnostic(path, "E_SCENARIO_READ_FAILED", error.message)
    };
  }
}

import { AttestError } from "../errors.mjs";

const EMPTY_PATH = Object.freeze([]);
const VALID_SEVERITIES = new Set(["error", "warning"]);

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizePath(path) {
  if (path === undefined) {
    return EMPTY_PATH;
  }

  if (!Array.isArray(path)) {
    throw new TypeError("Diagnostic path must be an array");
  }

  return Object.freeze([...path]);
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Diagnostic ${name} must be a non empty string`);
  }

  return value;
}

export function createDiagnostic({
  file,
  line,
  col,
  code,
  reason,
  severity = "error",
  path = EMPTY_PATH
}) {
  if (!isPositiveInteger(line)) {
    throw new TypeError("Diagnostic line must be a positive integer");
  }

  if (!isPositiveInteger(col)) {
    throw new TypeError("Diagnostic col must be a positive integer");
  }

  if (!VALID_SEVERITIES.has(severity)) {
    throw new TypeError("Diagnostic severity must be error or warning");
  }

  return Object.freeze({
    file: requireNonEmptyString(file, "file"),
    line,
    col,
    code: requireNonEmptyString(code, "code"),
    reason: requireNonEmptyString(reason, "reason"),
    severity,
    path: normalizePath(path)
  });
}

export function formatDiagnostic(diagnostic) {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.col}  ${diagnostic.code}  ${diagnostic.reason}`;
}

export class DiagnosticList {
  #items;

  constructor(items = []) {
    if (!Array.isArray(items)) {
      throw new TypeError("DiagnosticList items must be an array");
    }

    this.#items = [];
    for (const item of items) {
      this.add(item);
    }
  }

  add(diagnostic) {
    this.#items.push(
      createDiagnostic({
        file: diagnostic.file,
        line: diagnostic.line,
        col: diagnostic.col,
        code: diagnostic.code,
        reason: diagnostic.reason,
        severity: diagnostic.severity,
        path: diagnostic.path
      })
    );

    return this;
  }

  get errors() {
    return Object.freeze(this.#items.filter((diagnostic) => diagnostic.severity === "error"));
  }

  get all() {
    return Object.freeze([...this.#items]);
  }

  get ok() {
    return this.errors.length === 0;
  }

  throwIfErrors() {
    const errors = this.errors;
    if (errors.length === 0) {
      return;
    }

    throw new AttestError("E_SCENARIO_INVALID", "Scenario is invalid", {
      diagnostics: errors
    });
  }

  toJSON() {
    return Object.freeze(this.all.map((diagnostic) => ({ ...diagnostic })));
  }
}

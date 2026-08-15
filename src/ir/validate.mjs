import { AttestError } from "../errors.mjs";
import { applyBans } from "./bans.mjs";
import { DiagnosticList } from "./diagnostics.mjs";
import { deepFreeze } from "./freeze.mjs";
import { OP_SET } from "./ops.mjs";
import { createScenarioNode } from "./nodes/scenario.mjs";
import { createStepNode } from "./nodes/step.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stepOp(step) {
  if (!isRecord(step)) {
    return null;
  }

  if (step.delta_window !== undefined) {
    return "delta_window";
  }

  const keys = Object.keys(step);
  return keys.length === 1 ? keys[0] : null;
}

function stepValue(step, op) {
  return op === "delta_window" ? step : step[op];
}

function diagnosticFor(ast, path, code, reason) {
  const pos = ast.positionOf(path);
  return {
    file: pos.file ?? ast.file,
    line: pos.line,
    col: pos.col,
    code,
    reason,
    path
  };
}

function addErrorDiagnostic(diagnostics, ast, path, error) {
  if (error instanceof AttestError) {
    diagnostics.add(
      diagnosticFor(ast, path, error.code, error.details.reason ?? error.message ?? "Invalid scenario")
    );
    return;
  }

  diagnostics.add(diagnosticFor(ast, path, "E_VALIDATE", error.message ?? "Invalid scenario"));
}

function createSteps(ast, diagnostics) {
  if (!Array.isArray(ast.value?.steps)) {
    diagnostics.add(diagnosticFor(ast, ["steps"], "E_SCHEMA", "Scenario steps must be an array"));
    return [];
  }

  return ast.value.steps.flatMap((step, index) => {
    const op = stepOp(step);
    const path = ["steps", index];

    if (op === null || !OP_SET.has(op)) {
      diagnostics.add(diagnosticFor(ast, path, "E_UNKNOWN_OP", "Step must use a known operation"));
      return [];
    }

    try {
      return [
        createStepNode({
          index,
          op,
          value: stepValue(step, op),
          pos: ast.positionOf([...path, op])
        })
      ];
    } catch (error) {
      addErrorDiagnostic(diagnostics, ast, [...path, op], error);
      return [];
    }
  });
}

function deltaWindowState(step) {
  if (step.op !== "delta_window") {
    return null;
  }

  if (step.value?.open === true) {
    return "open";
  }

  if (isRecord(step.value?.close)) {
    return "close";
  }

  return null;
}

function addCrossStepDiagnostics(ast, steps, diagnostics) {
  let openStep = null;
  const checkpoints = new Map();

  for (const step of steps) {
    const path = ["steps", step.index, step.op];
    const windowState = deltaWindowState(step);

    if (windowState === "open") {
      if (openStep !== null) {
        diagnostics.add(
          diagnosticFor(
            ast,
            path,
            "E_NESTED_DELTA_WINDOW",
            `delta_window opened before closing step ${openStep.index}`
          )
        );
      }
      openStep = step;
    }

    if (windowState === "close") {
      if (openStep === null) {
        diagnostics.add(
          diagnosticFor(ast, path, "E_UNBALANCED_DELTA_WINDOW", "delta_window close has no open")
        );
      }
      openStep = null;
    }

    if (step.op === "checkpoint") {
      const name = step.value;
      if (checkpoints.has(name)) {
        diagnostics.add(
          diagnosticFor(
            ast,
            path,
            "E_DUPLICATE_CHECKPOINT",
            `checkpoint ${JSON.stringify(name)} is used more than once`
          )
        );
      }
      checkpoints.set(name, step);
    }

    if (step.op === "run_flow" && step.value === ast.value.id) {
      diagnostics.add(
        diagnosticFor(ast, path, "E_FLOW_SELF_REFERENCE", "run_flow cannot reference its own scenario")
      );
    }
  }
}

export function validateScenario(ast) {
  const diagnostics = new DiagnosticList();

  if (ast === null || ast === undefined || ast.value === null || ast.value === undefined) {
    diagnostics.add({
      file: ast?.file ?? "unknown",
      line: 1,
      col: 1,
      code: "E_AST_MISSING",
      reason: "Scenario AST is missing"
    });
    return { ir: null, diagnostics };
  }

  applyBans(ast, diagnostics);
  if (!diagnostics.ok) {
    return { ir: null, diagnostics };
  }

  const steps = createSteps(ast, diagnostics);
  addCrossStepDiagnostics(ast, steps, diagnostics);

  if (!diagnostics.ok) {
    return { ir: null, diagnostics };
  }

  return {
    ir: deepFreeze(createScenarioNode({ ast, steps })),
    diagnostics
  };
}

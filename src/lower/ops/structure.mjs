import { PLAN_OP_KINDS } from "../plan.mjs";
import { CompileError } from "../errors.mjs";

const DELTA_FENCE = "attest_watermark";
const CONVERGE_TIMEOUT_MS = 10000;
const QUIET_PERIOD_MS = 750;
const FLOW_DEPTH_LIMIT = 5;

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function lowerDeltaWindow(step, ctx) {
  const seq = ctx.nextDeltaSeq();

  if (step.value.open === true) {
    return [
      {
        kind: PLAN_OP_KINDS.delta_window.open,
        fence: DELTA_FENCE,
        scenarioId: ctx.scenarioId,
        seq
      }
    ];
  }

  return [
    {
      kind: PLAN_OP_KINDS.delta_window.close,
      fence: DELTA_FENCE,
      scenarioId: ctx.scenarioId,
      seq,
      expect: cloneJson(step.value.close.expect_mutations ?? []),
      requireNoUnexplained: step.value.close.require_no_unexplained === true,
      convergeTimeoutMs: CONVERGE_TIMEOUT_MS,
      quietPeriodMs: QUIET_PERIOD_MS
    }
  ];
}

function lowerRaw(step, ctx) {
  const block = step.value[ctx.surface];
  if (block === undefined) {
    return ctx.rawMissing(step);
  }

  return [
    {
      kind: PLAN_OP_KINDS.raw,
      surface: ctx.surface,
      reason: step.value.reason,
      block: cloneJson(block)
    }
  ];
}

export function lowerStructure(step, ctx) {
  switch (step.op) {
    case "checkpoint":
      return [{ kind: PLAN_OP_KINDS.checkpoint, label: step.value }];
    case "delta_window":
      return lowerDeltaWindow(step, ctx);
    case "raw":
      return lowerRaw(step, ctx);
    default:
      return ctx.unlowered(step);
  }
}

function normalizeFlows(flows) {
  if (flows instanceof Map) {
    return flows;
  }

  if (flows !== null && typeof flows === "object" && !Array.isArray(flows)) {
    return new Map(Object.entries(flows));
  }

  return new Map();
}

function flowCompileError(ir, ctx, code, step, details) {
  return new CompileError(code, {
    scenarioId: ir.id,
    surface: ctx.surface,
    stepIndex: step.index,
    capabilities: [],
    ...details
  });
}

export function flattenScenarioSteps(ir, flows, ctx) {
  const flowMap = normalizeFlows(flows);
  const flattened = [];

  function visit(currentIr, depth, chain) {
    if (depth > FLOW_DEPTH_LIMIT) {
      return flowCompileError(ir, ctx, "E_FLOW_DEPTH", chain.at(-1).step, {
        flowId: currentIr.id,
        depth,
        maxDepth: FLOW_DEPTH_LIMIT,
        chain: chain.map((entry) => entry.id).join(" -> ")
      });
    }

    for (const step of currentIr.steps) {
      if (step.op !== "run_flow") {
        flattened.push(step);
        continue;
      }

      const flowId = step.value;
      const nextFlow = flowMap.get(flowId) ?? null;
      if (nextFlow === null) {
        return flowCompileError(ir, ctx, "E_FLOW_NOT_FOUND", step, { flowId });
      }

      const ids = chain.map((entry) => entry.id);
      if (ids.includes(flowId)) {
        return flowCompileError(ir, ctx, "E_FLOW_CYCLE", step, {
          flowId,
          chain: [...ids, flowId].join(" -> ")
        });
      }

      const result = visit(nextFlow, depth + 1, [...chain, { id: flowId, step }]);
      if (result !== null) {
        return result;
      }
    }

    return null;
  }

  const error = visit(ir, 0, [{ id: ir.id, step: { index: null } }]);
  return error ?? flattened;
}

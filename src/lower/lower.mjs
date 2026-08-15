import { AttestError } from "../errors.mjs";
import { resolveRef } from "../bindings/resolve.mjs";
import { assertKnownCapability, isDbCapability } from "../capabilities/registry.mjs";
import { NOT_IMPLEMENTED_DB_CAPS } from "../capabilities/db-caps.mjs";
import { OP_CATEGORIES } from "../ir/ops.mjs";
import {
  CompileError,
  compileErrorOutcome,
  skipOutcome,
  unboundRefCompileError,
  unknownCapabilityCompileError
} from "./errors.mjs";
import { createExecutionPlan } from "./plan.mjs";
import { lowerAssertion } from "./ops/assertion.mjs";
import { lowerInteraction } from "./ops/interaction.mjs";
import { lowerNavigation } from "./ops/navigation.mjs";
import { flattenScenarioSteps, lowerStructure } from "./ops/structure.mjs";

const NAVIGATION_OPS = new Set(OP_CATEGORIES.navigation);
const ASSERTION_OPS = new Set(OP_CATEGORIES.assertion);
const INTERACTION_OPS = new Set([...OP_CATEGORIES.interaction, ...OP_CATEGORIES.environment]);
const STRUCTURE_OPS = new Set([...OP_CATEGORIES.structure, ...OP_CATEGORIES.escape_hatch]);

class RawMissingForSurface extends Error {
  constructor(step) {
    super("raw_missing_for_surface");
    this.step = step;
  }
}

function sortedUnique(values) {
  return [...new Set(values)].toSorted();
}

function dbFlag(capability) {
  return capability.slice("db.".length);
}

function capabilityRecords(ir, steps) {
  const records = [];

  for (const capability of ir.capabilities) {
    records.push({ capability, stepIndex: null });
  }

  for (const step of steps) {
    for (const capability of step.capabilities) {
      records.push({ capability, stepIndex: step.index });
    }
  }

  return records;
}

function validateCapabilities(ir, ctx, records) {
  for (const record of records) {
    try {
      assertKnownCapability(record.capability);
    } catch (error) {
      if (error instanceof AttestError && error.code === "E_UNKNOWN_CAPABILITY") {
        return unknownCapabilityCompileError({ ir, ctx, error, stepIndex: record.stepIndex });
      }
      throw error;
    }
  }

  return null;
}

function firstStepDemand(records, capability) {
  const record = records.find(
    (item) => item.capability === capability && item.stepIndex !== null
  );
  return record?.stepIndex ?? null;
}

function gateCapabilities(ir, ctx, records) {
  const validation = validateCapabilities(ir, ctx, records);
  if (validation !== null) {
    return validation;
  }

  const demanded = sortedUnique(records.map((record) => record.capability));
  const missingDb = demanded.filter((capability) => isDbCapability(capability) && !ctx.dbCaps.has(capability));

  if (missingDb.length > 0) {
    const first = missingDb[0];
    return compileErrorOutcome("E_DELTA_UNSUPPORTED", {
      scenarioId: ir.id,
      surface: ctx.surface,
      stepIndex: firstStepDemand(records, first),
      driver: ctx.dbCaps.driver,
      flag: dbFlag(first),
      capabilities: missingDb
    });
  }

  const missingSurface = demanded.filter(
    (capability) => !isDbCapability(capability) && !ctx.surfaceCaps.has(capability)
  );

  if (missingSurface.length > 0) {
    return skipOutcome({
      scenarioId: ir.id,
      surface: ctx.surface,
      reason: "capability_missing",
      capabilities: missingSurface
    });
  }

  return null;
}

function lowerStep(step, ctx) {
  if (NAVIGATION_OPS.has(step.op)) {
    return lowerNavigation(step, ctx);
  }
  if (INTERACTION_OPS.has(step.op)) {
    return lowerInteraction(step, ctx);
  }
  if (ASSERTION_OPS.has(step.op)) {
    return lowerAssertion(step, ctx);
  }
  if (STRUCTURE_OPS.has(step.op)) {
    return lowerStructure(step, ctx);
  }

  throw new AttestError("E_UNLOWERED_OP", `No lowering exists for operation ${step.op}`, {
    op: step.op,
    stepIndex: step.index
  });
}

function buildLowerContext(ir, ctx) {
  let deltaSeq = 0;
  let currentStep = null;

  return {
    scenarioId: ir.id,
    surface: ctx.surface,
    setCurrentStep(step) {
      currentStep = step;
    },
    nextDeltaSeq() {
      deltaSeq += 1;
      return deltaSeq;
    },
    resolve(ref) {
      return resolveRef(ctx.bindings, ref);
    },
    rawMissing(step) {
      throw new RawMissingForSurface(step);
    },
    unlowered(step) {
      throw new AttestError("E_UNLOWERED_OP", `No lowering exists for operation ${step.op}`, {
        op: step.op,
        stepIndex: step.index
      });
    },
    currentStep() {
      return currentStep;
    }
  };
}

function lowerSteps(ir, ctx, steps) {
  const lowerCtx = buildLowerContext(ir, ctx);
  const ops = [];

  try {
    for (const step of steps) {
      lowerCtx.setCurrentStep(step);
      ops.push(...lowerStep(step, lowerCtx));
    }
  } catch (error) {
    if (error instanceof RawMissingForSurface) {
      return skipOutcome({
        scenarioId: ir.id,
        surface: ctx.surface,
        reason: "raw_missing_for_surface",
        capabilities: ["raw_escape"]
      });
    }

    if (error instanceof AttestError && error.code === "E_UNBOUND_REF") {
      const step = lowerCtx.currentStep();
      return unboundRefCompileError({ ir, ctx, error, stepIndex: step?.index ?? null });
    }

    throw error;
  }

  return {
    kind: "ops",
    ops: ops.map((op, i) => ({ i, ...op }))
  };
}

function planCapabilities(records, ctx) {
  const demanded = sortedUnique(records.map((record) => record.capability));
  return {
    demanded,
    satisfiedBy: {
      surface: sortedUnique(ctx.surfaceCaps.supports),
      db: sortedUnique(ctx.dbCaps.supports)
    }
  };
}

function buildPlan(ir, ctx, records, ops) {
  return createExecutionPlan({
    scenarioId: ir.id,
    surface: ctx.surface,
    app: ctx.app ?? ctx.bindings.app,
    bindingsHash: ctx.bindings.hash,
    requirements: ir.requirements,
    capabilities: planCapabilities(records, ctx),
    rawOpCount: ops.filter((op) => op.kind === "raw").length,
    ops
  });
}

export function lower(
  ir,
  { surface, bindings, surfaceCaps, dbCaps = NOT_IMPLEMENTED_DB_CAPS, flows = new Map(), app } = {}
) {
  // A caller with no DB driver configured is a legal call, a scenario that then
  // demands a DB capability must fail as a named E_DELTA_UNSUPPORTED compile
  // error, never as a TypeError. Defaulting to the "none" driver descriptor is
  // what keeps that path a refusal instead of a crash.
  const ctx = { surface, bindings, surfaceCaps, dbCaps, app };
  const flattened = flattenScenarioSteps(ir, flows, ctx);
  if (flattened instanceof CompileError) {
    return { kind: "error", error: flattened };
  }

  const records = capabilityRecords(ir, flattened);
  const gated = gateCapabilities(ir, ctx, records);
  if (gated !== null) {
    return gated;
  }

  const lowered = lowerSteps(ir, ctx, flattened);
  if (lowered.kind !== "ops") {
    return lowered;
  }

  return {
    kind: "plan",
    plan: buildPlan(ir, ctx, records, lowered.ops)
  };
}

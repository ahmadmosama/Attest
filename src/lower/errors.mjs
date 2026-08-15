import { AttestError } from "../errors.mjs";

export const COMPILE_ERROR_CODES = Object.freeze([
  "E_DELTA_UNSUPPORTED",
  "E_UNBOUND_REF",
  "E_UNKNOWN_CAPABILITY",
  "E_FLOW_NOT_FOUND",
  "E_FLOW_CYCLE",
  "E_FLOW_DEPTH"
]);

const COMPILE_ERROR_SET = new Set(COMPILE_ERROR_CODES);

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function asNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non empty string`);
  }
  return value;
}

function asCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("SkipDecision capabilities must be a non empty array");
  }

  for (const capability of value) {
    asNonEmptyString(capability, "SkipDecision capability");
  }

  return Object.freeze([...new Set(value)].toSorted());
}

function compileMessage(code, details) {
  if (code === "E_DELTA_UNSUPPORTED") {
    return `${code}: driver '${details.driver}' declares ${details.flag}=false, scenario '${details.scenarioId}' step ${details.stepIndex} requires it`;
  }

  if (code === "E_UNBOUND_REF") {
    return `${code}: SemanticRef ${details.ref} has no binding on surface ${details.surface} in ${details.file}, scenario '${details.scenarioId}' step ${details.stepIndex}`;
  }

  if (code === "E_UNKNOWN_CAPABILITY") {
    return `${code}: scenario '${details.scenarioId}' step ${details.stepIndex} requires unknown capability '${details.capability}'`;
  }

  if (code === "E_FLOW_NOT_FOUND") {
    return `${code}: scenario '${details.scenarioId}' step ${details.stepIndex} references missing flow '${details.flowId}'`;
  }

  if (code === "E_FLOW_CYCLE") {
    return `${code}: scenario '${details.scenarioId}' step ${details.stepIndex} creates flow cycle ${details.chain}`;
  }

  if (code === "E_FLOW_DEPTH") {
    return `${code}: scenario '${details.scenarioId}' step ${details.stepIndex} exceeds flow depth ${details.maxDepth}`;
  }

  return `${code}: scenario '${details.scenarioId}' could not be lowered`;
}

function normalizeDetails(details) {
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    throw new TypeError("CompileError details must be an object");
  }

  return deepFreeze({
    ...details,
    capabilities: Array.isArray(details.capabilities)
      ? Object.freeze([...new Set(details.capabilities)].toSorted())
      : Object.freeze([])
  });
}

export class CompileError extends AttestError {
  constructor(code, details, message = null) {
    if (!COMPILE_ERROR_SET.has(code)) {
      throw new TypeError(`Unknown compile error code ${code}`);
    }

    const frozenDetails = normalizeDetails(details);
    super(code, message ?? compileMessage(code, frozenDetails), frozenDetails);
  }
}

export function compileErrorOutcome(code, details, message = null) {
  return { kind: "error", error: new CompileError(code, details, message) };
}

export function unknownCapabilityCompileError({ ir, ctx, error, stepIndex }) {
  return compileErrorOutcome("E_UNKNOWN_CAPABILITY", {
    scenarioId: ir.id,
    surface: ctx.surface,
    stepIndex,
    capability: error.details.capability,
    capabilities: [error.details.capability]
  });
}

export function unboundRefCompileError({ ir, ctx, error, stepIndex }) {
  return compileErrorOutcome("E_UNBOUND_REF", {
    scenarioId: ir.id,
    surface: ctx.surface,
    stepIndex,
    ref: error.details.ref,
    file: error.details.file,
    capabilities: []
  });
}

export function SkipDecision({ scenarioId, surface, reason, capabilities }) {
  const skip = {
    kind: "skip",
    scenarioId: asNonEmptyString(scenarioId, "SkipDecision scenarioId"),
    surface: asNonEmptyString(surface, "SkipDecision surface"),
    reason: asNonEmptyString(reason, "SkipDecision reason"),
    capabilities: asCapabilities(capabilities)
  };

  return deepFreeze(skip);
}

export function skipOutcome(fields) {
  return { kind: "skip", skip: SkipDecision(fields) };
}

import { AttestError, InfraError, UnsupportedOpError } from "../errors.mjs";
import { TimeoutError } from "./timeout.mjs";

function detailsFor(error) {
  if (error?.details !== null && typeof error?.details === "object" && !Array.isArray(error.details)) {
    return Object.freeze({ ...error.details });
  }

  return Object.freeze({});
}

function errorShape(result, error) {
  return Object.freeze({
    result,
    code: error.code,
    message: error.message,
    details: detailsFor(error)
  });
}

function unexpectedShape(error) {
  return Object.freeze({
    result: "infra_error",
    code: "E_UNEXPECTED",
    message: error instanceof Error ? error.message : "Unexpected harness error",
    details: Object.freeze({
      name: error instanceof Error ? error.name : typeof error
    })
  });
}

export function classifyError(error) {
  if (error instanceof InfraError) {
    return errorShape("infra_error", error);
  }

  if (error instanceof TimeoutError) {
    const timeoutKind = error.details.kind;
    const result = timeoutKind === "preflight" || timeoutKind === "close" ? "infra_error" : "fail";
    return errorShape(result, error);
  }

  if (error instanceof UnsupportedOpError) {
    return errorShape("fail", error);
  }

  if (error instanceof AttestError) {
    const result = error.code.startsWith("E_ADAPTER_") ? "infra_error" : "fail";
    return errorShape(result, error);
  }

  return unexpectedShape(error);
}

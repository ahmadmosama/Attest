import { AttestError } from "../errors.mjs";

const TIMEOUT_KINDS = new Set(["step", "scenario", "preflight", "close", "evidence"]);
const SIGNAL_DETAILS = new WeakMap();

function noop() {}

function assertTimeoutInput(fn, { ms, kind, parentSignal }) {
  if (typeof fn !== "function") {
    throw new TypeError("withTimeout requires a function");
  }

  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new TypeError("withTimeout ms must be a non negative safe integer");
  }

  if (!TIMEOUT_KINDS.has(kind)) {
    throw new TypeError(`Unknown timeout kind ${kind}`);
  }

  if (
    parentSignal !== undefined &&
    (parentSignal === null || typeof parentSignal.aborted !== "boolean")
  ) {
    throw new TypeError("parentSignal must be an AbortSignal");
  }
}

function errorDetails({ kind, ms, at }) {
  return Object.freeze({
    kind,
    ms,
    at: at ?? null
  });
}

export class TimeoutError extends AttestError {
  constructor({ kind, ms, at, message } = {}) {
    if (!TIMEOUT_KINDS.has(kind)) {
      throw new TypeError(`Unknown timeout kind ${kind}`);
    }

    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new TypeError("TimeoutError ms must be a non negative safe integer");
    }

    super("E_TIMEOUT", message ?? `${kind} timed out after ${ms}ms`, errorDetails({ kind, ms, at }));
  }
}

function isAbortSignal(value) {
  return value !== null && typeof value === "object" && typeof value.aborted === "boolean";
}

function isTimeoutSignalAbort(signal, timeoutSignal) {
  return timeoutSignal.aborted && signal.reason === timeoutSignal.reason;
}

function parentTimeoutError(parentSignal) {
  if (!isAbortSignal(parentSignal) || !parentSignal.aborted) {
    return null;
  }

  if (parentSignal.reason instanceof TimeoutError) {
    return parentSignal.reason;
  }

  const details = SIGNAL_DETAILS.get(parentSignal);
  if (details !== undefined) {
    return new TimeoutError(details);
  }

  return null;
}

function abortError({ signal, timeoutSignal, parentSignal, ownDetails }) {
  const parentError = parentTimeoutError(parentSignal);
  if (parentError !== null && signal.reason === parentSignal.reason) {
    return parentError;
  }

  if (isTimeoutSignalAbort(signal, timeoutSignal)) {
    return new TimeoutError(ownDetails);
  }

  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  return new TimeoutError(ownDetails);
}

export async function withTimeout(fn, { ms, kind, at = null, parentSignal } = {}) {
  assertTimeoutInput(fn, { ms, kind, parentSignal });

  const timeoutSignal = AbortSignal.timeout(ms);
  const ownDetails = { kind, ms, at };
  const signals = parentSignal === undefined ? [timeoutSignal] : [parentSignal, timeoutSignal];
  const signal = AbortSignal.any(signals);
  SIGNAL_DETAILS.set(timeoutSignal, ownDetails);
  SIGNAL_DETAILS.set(signal, ownDetails);

  let removeAbortListener = noop;
  const abortPromise = new Promise((_, reject) => {
    const onAbort = () =>
      reject(
        abortError({
          signal,
          timeoutSignal,
          parentSignal,
          ownDetails
        })
      );

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([abortPromise, Promise.resolve().then(() => fn({ signal }))]);
  } finally {
    removeAbortListener();
  }
}

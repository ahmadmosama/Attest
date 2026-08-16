const MAX_ABORT_TIMEOUT_MS = 2_147_483_647;

function isAbortSignal(value) {
  return value !== null && typeof value === "object" && typeof value.aborted === "boolean";
}

function assertSignal(signal, name) {
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError(`${name} must be an AbortSignal`);
  }
}

function assertNonNegativeMs(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non negative safe integer`);
  }
}

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

function elapsedSince(startedAt, now) {
  return Math.max(0, now() - startedAt);
}

function waitTick(ms, signal) {
  throwIfAborted(signal);

  const boundedMs = Math.min(ms, MAX_ABORT_TIMEOUT_MS);
  const tickSignal = AbortSignal.timeout(boundedMs);
  const combinedSignal = signal === undefined ? tickSignal : AbortSignal.any([signal, tickSignal]);

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      combinedSignal.removeEventListener("abort", onAbort);

      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }

      resolve();
    };

    if (combinedSignal.aborted) {
      onAbort();
      return;
    }

    combinedSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function resultFor(fields) {
  return Object.freeze({
    ok: fields.ok,
    attempts: fields.attempts,
    elapsedMs: fields.elapsedMs,
    value: fields.value,
    lastError: fields.lastError
  });
}

function quietResultFor(fields) {
  return Object.freeze({
    quiet: fields.quiet,
    elapsedMs: fields.elapsedMs,
    events: fields.events,
    extensions: fields.extensions
  });
}

function isSatisfied(outcome) {
  return outcome !== null && typeof outcome === "object" && outcome.ok === true;
}

function assertDrainCount(count) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("quietPeriod drain must return a non negative safe integer");
  }
}

export const ConvergeResult = Object.freeze({
  ok({ attempts, elapsedMs, value }) {
    return resultFor({ ok: true, attempts, elapsedMs, value, lastError: undefined });
  },
  miss({ attempts, elapsedMs, lastError }) {
    return resultFor({ ok: false, attempts, elapsedMs, value: undefined, lastError });
  },
  quiet({ elapsedMs, events, extensions }) {
    return quietResultFor({ quiet: true, elapsedMs, events, extensions });
  },
  noisy({ elapsedMs, events, extensions }) {
    return quietResultFor({ quiet: false, elapsedMs, events, extensions });
  }
});

export async function converge({ probe, timeoutMs, intervalMs = 50, signal, now = Date.now } = {}) {
  assertFunction(probe, "converge probe");
  assertFunction(now, "converge now");
  assertSignal(signal, "converge signal");
  assertNonNegativeMs(timeoutMs, "converge timeoutMs");
  assertNonNegativeMs(intervalMs, "converge intervalMs");

  const startedAt = now();
  let attempts = 0;
  let lastError;

  while (true) {
    throwIfAborted(signal);
    attempts += 1;

    try {
      const outcome = await probe({ signal });
      throwIfAborted(signal);

      if (isSatisfied(outcome)) {
        return ConvergeResult.ok({
          attempts,
          elapsedMs: elapsedSince(startedAt, now),
          value: outcome.value
        });
      }
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
    }

    const elapsedMs = elapsedSince(startedAt, now);
    if (elapsedMs >= timeoutMs) {
      return ConvergeResult.miss({ attempts, elapsedMs, lastError });
    }

    await waitTick(Math.min(intervalMs, timeoutMs - elapsedMs), signal);
  }
}

export async function quietPeriod({ drain, quietMs, capMs, signal, now = Date.now } = {}) {
  assertFunction(drain, "quietPeriod drain");
  assertFunction(now, "quietPeriod now");
  assertSignal(signal, "quietPeriod signal");
  assertNonNegativeMs(quietMs, "quietPeriod quietMs");
  assertNonNegativeMs(capMs, "quietPeriod capMs");

  const startedAt = now();
  let quietStartedAt = startedAt;
  let events = 0;
  let extensions = 0;

  while (true) {
    throwIfAborted(signal);

    const count = await drain({ signal });
    throwIfAborted(signal);
    assertDrainCount(count);

    if (count > 0) {
      events += count;
      extensions += 1;
      quietStartedAt = now();
    }

    const elapsedMs = elapsedSince(startedAt, now);
    const quietElapsedMs = Math.max(0, now() - quietStartedAt);

    if (quietElapsedMs >= quietMs) {
      return ConvergeResult.quiet({ elapsedMs, events, extensions });
    }

    if (elapsedMs >= capMs) {
      return ConvergeResult.noisy({ elapsedMs, events, extensions });
    }

    await waitTick(Math.min(quietMs - quietElapsedMs, capMs - elapsedMs), signal);
  }
}

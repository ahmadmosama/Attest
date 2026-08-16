import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ConvergeResult, converge, quietPeriod } from "../../src/runtime/converge.mjs";

test("converge succeeds on the first attempt with zero elapsed time", async () => {
  const result = await converge({
    timeoutMs: 100,
    probe: () => ({ ok: true, value: "ready" }),
    now: () => 10
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.elapsedMs, 0);
  assert.equal(result.value, "ready");
});

test("converge polls until the probe reports satisfied", async () => {
  let currentMs = 0;
  let attempts = 0;

  const result = await converge({
    timeoutMs: 20,
    intervalMs: 1,
    now: () => currentMs,
    probe: () => {
      attempts += 1;
      currentMs += 5;
      return attempts === 3 ? { ok: true, value: { id: 7 } } : { ok: false };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 15);
  assert.deepEqual(result.value, { id: 7 });
});

test("converge returns the last probe error when the budget expires", async () => {
  let currentMs = 0;
  const firstError = new Error("first");
  const secondError = new Error("second");
  const errors = [firstError, secondError];

  const result = await converge({
    timeoutMs: 10,
    intervalMs: 1,
    now: () => currentMs,
    probe: () => {
      currentMs += 5;
      throw errors.shift();
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.elapsedMs, 10);
  assert.equal(result.lastError, secondError);
});

test("converge rejects with an abort reason during an already running wait", async () => {
  const controller = new AbortController();
  const reason = new Error("stop now");
  let attempts = 0;

  const pending = converge({
    timeoutMs: 1000,
    intervalMs: 1000,
    signal: controller.signal,
    probe: () => {
      attempts += 1;
      return { ok: false };
    }
  });

  await Promise.resolve();
  controller.abort(reason);

  await assert.rejects(() => pending, reason);
  assert.equal(attempts, 1);
});

test("converge with zero timeout makes exactly one probe attempt", async () => {
  let attempts = 0;

  const result = await converge({
    timeoutMs: 0,
    probe: () => {
      attempts += 1;
      return { ok: false };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(attempts, 1);
});

test("quietPeriod returns quiet when no events arrive across the quiet window", async () => {
  let currentMs = 0;

  const result = await quietPeriod({
    quietMs: 10,
    capMs: 50,
    now: () => currentMs,
    drain: () => {
      currentMs += 10;
      return 0;
    }
  });

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, {
    quiet: true,
    elapsedMs: 10,
    events: 0,
    extensions: 0
  });
});

test("quietPeriod extends the window for every non zero drain", async () => {
  let currentMs = 0;
  const counts = [2, 1, 0];

  const result = await quietPeriod({
    quietMs: 10,
    capMs: 100,
    now: () => currentMs,
    drain: () => {
      const count = counts.shift() ?? 0;
      currentMs += count > 0 ? 4 : 10;
      return count;
    }
  });

  assert.deepEqual(result, {
    quiet: true,
    elapsedMs: 18,
    events: 3,
    extensions: 2
  });
});

test("quietPeriod stops at the cap when events never stop arriving", async () => {
  let currentMs = 0;

  const result = await quietPeriod({
    quietMs: 10,
    capMs: 12,
    now: () => currentMs,
    drain: () => {
      currentMs += 4;
      return 1;
    }
  });

  assert.deepEqual(result, {
    quiet: false,
    elapsedMs: 12,
    events: 3,
    extensions: 3
  });
});

test("quietPeriod rejects with an abort reason during an already running wait", async () => {
  const controller = new AbortController();
  const reason = new Error("quiet aborted");
  let drains = 0;

  const pending = quietPeriod({
    quietMs: 1000,
    capMs: 2000,
    signal: controller.signal,
    drain: () => {
      drains += 1;
      return 0;
    }
  });

  await Promise.resolve();
  controller.abort(reason);

  await assert.rejects(() => pending, reason);
  assert.equal(drains, 1);
});

test("ConvergeResult helper is frozen", () => {
  assert.equal(Object.isFrozen(ConvergeResult), true);
});

test("converge source uses AbortSignal bounding without setTimeout", async () => {
  const source = await readFile("src/runtime/converge.mjs", "utf8");

  assert.equal(source.includes("setTimeout"), false);
  assert.equal(source.includes("AbortSignal.timeout"), true);
  assert.equal(source.includes("AbortSignal.any"), true);
});

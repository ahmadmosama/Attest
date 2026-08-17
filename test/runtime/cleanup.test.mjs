import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import { SIGNAL_EXIT_CODES, createCleanupRegistry } from "../../src/runtime/cleanup.mjs";

function harness(options = {}) {
  const emitter = new EventEmitter();
  const exits = [];
  const events = [];
  const registry = createCleanupRegistry({ onEvent: (event) => events.push(event), ...options });

  registry.install({ emitter, exit: (code) => exits.push(code) });

  return { registry, emitter, exits, events };
}

describe("the cleanup registry", () => {
  test("disposers run in reverse acquisition order", async () => {
    const order = [];
    const { registry } = harness();

    registry.register("connection", () => order.push("connection"));
    registry.register("slot", () => order.push("slot"));
    registry.register("recording", () => order.push("recording"));

    await registry.runAll("test");

    // Reverse, because a resource acquired later may depend on one acquired
    // earlier: the slot is created THROUGH the connection, the recording runs
    // ON the booted emulator. Tearing down forwards closes the thing the next
    // disposer needs.
    assert.deepEqual(order, ["recording", "slot", "connection"]);
  });

  test("one disposer failing does not skip the ones after it", async () => {
    const ran = [];
    const { registry } = harness();

    registry.register("emulator", () => ran.push("emulator"));
    registry.register("slot", () => {
      throw new Error("connection already gone");
    });
    registry.register("browser", () => ran.push("browser"));

    const summary = await registry.runAll("test");

    // The concrete failure mode of the two competing registries this replaces:
    // whichever failed first took the rest down with it.
    assert.deepEqual(ran, ["browser", "emulator"]);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].name, "slot");
    assert.match(summary.failed[0].message, /already gone/u);
  });

  test("a hung disposer is bounded, and the rest still run", async () => {
    const ran = [];
    const { registry } = harness({ disposerTimeoutMs: 60 });

    registry.register("connection", () => ran.push("connection"));
    // A socket to a database that is never going to answer.
    registry.register("hung", () => new Promise(() => {}));
    registry.register("emulator", () => ran.push("emulator"));

    const summary = await registry.runAll("SIGINT");

    // A Ctrl-C that appears to hang is worse than one that leaks: the
    // operator's next move is SIGKILL, and then everything leaks rather than
    // one thing. Bounding turns a total loss into a partial one.
    assert.deepEqual(ran, ["emulator", "connection"]);
    assert.equal(summary.failed.length, 1);
    assert.match(summary.failed[0].message, /timed out/u);
  });

  test("a total deadline stops the run and names what it skipped", async () => {
    const { registry } = harness({ disposerTimeoutMs: 40, totalTimeoutMs: 50 });
    const ran = [];

    registry.register("never-reached", () => ran.push("never-reached"));
    registry.register("hung-b", () => new Promise(() => {}));
    registry.register("hung-a", () => new Promise(() => {}));

    const summary = await registry.runAll("SIGINT");

    assert.deepEqual(ran, []);
    // Named, not silently dropped, so the operator knows exactly what to go and
    // check by hand.
    assert.ok(summary.results.some((result) => result.skipped === "deadline_exceeded"));
    assert.ok(summary.results.some((result) => result.name === "never-reached"));
  });

  test("dispose is idempotent, and release stops tracking without disposing", async () => {
    const calls = [];
    const { registry } = harness();

    const disposed = registry.register("a", (reason) => calls.push(`a:${reason}`));
    const released = registry.register("b", (reason) => calls.push(`b:${reason}`));

    await disposed.dispose();
    await disposed.dispose();
    released.release();

    await registry.runAll("SIGINT");

    // The normal path and the signal path race by construction, so each has to
    // be safe when it loses. `release` is the normal path saying "I am dropping
    // this right now", and disposing it again would drop it twice.
    assert.deepEqual(calls, ["a:explicit"]);
    assert.equal(registry.size(), 0);
  });

  test("a signal runs every disposer once, then exits with 128 plus the signal", async () => {
    const ran = [];
    const { registry, emitter, exits } = harness();

    registry.register("slot", () => ran.push("slot"));
    registry.register("tenant", () => ran.push("tenant"));

    emitter.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(ran, ["tenant", "slot"]);
    assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT]);
    assert.equal(SIGNAL_EXIT_CODES.SIGINT, 130);
  });

  test("both a slot and a tenant survive one Ctrl-C, which is the bug this replaces", async () => {
    const ran = [];
    const { registry, emitter } = harness();

    // Before this registry existed, the slot layer and the tenancy layer each
    // installed their own SIGINT handler ending in process.exit. Whichever
    // settled first killed the other's in-flight cleanup, so a run holding both
    // reliably leaked one of them.
    registry.register("pg-slot:attest_x", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ran.push("slot");
    });
    registry.register("pg-tenant:attest_y", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ran.push("tenant");
    });

    emitter.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.deepEqual(ran.sort(), ["slot", "tenant"]);
  });

  test("a second signal abandons cleanup rather than appearing hung", async () => {
    const { registry, emitter, exits, events } = harness({ disposerTimeoutMs: 60_000 });

    registry.register("hung", () => new Promise(() => {}));

    emitter.emit("SIGINT");
    emitter.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));

    // The operator pressed Ctrl-C twice. They mean it.
    assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT]);
    assert.ok(events.some((event) => event.type === "cleanup_abandoned"));
  });

  test("an uncaught exception runs cleanup before dying", async () => {
    const ran = [];
    const { registry, emitter, exits } = harness();

    registry.register("emulator", () => ran.push("emulator"));
    emitter.emit("uncaughtException", new Error("boom"));
    await new Promise((resolve) => setImmediate(resolve));

    // The default behaviour is to print and die with everything still held.
    assert.deepEqual(ran, ["emulator"]);
    assert.deepEqual(exits, [1]);
  });

  test("handlers install themselves on first register, so a library caller is covered too", () => {
    // A guarantee that depends on the entry point remembering to call install()
    // is not a guarantee. Importing the db layer directly and opening a slot has
    // to be as safe as running the CLI.
    const registry = createCleanupRegistry();
    const emitter = new EventEmitter();

    assert.equal(registry.isInstalled(), false);
    const handle = registry.register("slot", () => {});
    assert.equal(registry.isInstalled(), true);

    handle.release();
    // And removed when idle, so a node --test process that opened and closed a
    // slot goes back to Node's default signal behaviour rather than keeping an
    // interceptor with nothing left to clean up.
    assert.equal(registry.isInstalled(), false);
    assert.equal(emitter.listenerCount("SIGINT"), 0);
  });

  test("an explicit install pins the handlers on across an idle moment", () => {
    const { registry } = harness();

    const handle = registry.register("slot", () => {});
    handle.release();

    assert.equal(registry.size(), 0);
    assert.equal(registry.isInstalled(), true, "the CLI owns the process for the whole run");
  });

  test("an observer that throws does not take the cleanup down with it", async () => {
    const registry = createCleanupRegistry({
      onEvent: () => {
        throw new Error("observer exploded");
      }
    });
    const ran = [];

    registry.register("a", () => {
      throw new Error("fail");
    });
    registry.register("b", () => ran.push("b"));

    await assert.doesNotReject(() => registry.runAll("test"));
    assert.deepEqual(ran, ["b"]);
  });

  test("a disposer must be a function", () => {
    const { registry } = harness();
    assert.throws(() => registry.register("bad", "not a function"), TypeError);
  });
});

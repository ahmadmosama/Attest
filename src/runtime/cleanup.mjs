/**
 * One process-scoped disposer registry, and one set of signal handlers.
 *
 * Before this existed there were two: the replication slot layer installed
 * SIGINT/SIGTERM handlers that ended in `process.exit`, and the tenancy layer
 * installed its own that did the same. Whichever settled first killed the
 * other's in-flight cleanup, so pressing Ctrl-C during a run with both a slot
 * and a tenant would reliably leak one of them. Adding a third registry for the
 * emulator and the browser would have made that worse, so this supersedes both
 * rather than joining them.
 *
 * What it guarantees, and what it deliberately does not:
 *
 *   guaranteed   Ctrl-C, SIGTERM (on a POSIX runner), SIGHUP, SIGBREAK, an
 *                uncaught exception, and ordinary exit all run every disposer
 *                once, in reverse acquisition order, with a bounded deadline.
 *   NOT possible SIGKILL and `taskkill /F` cannot be caught by any process.
 *                Nothing in here helps there, which is exactly why the sweeps
 *                exist: the registry handles the catchable half, and the next
 *                run's sweep handles the rest. Neither alone is enough.
 *
 * Windows note, because it changes what is actually covered here: Node does not
 * deliver SIGTERM on Windows at all. SIGINT and SIGBREAK are synthesised from
 * console events and do work. So on Ahmad's machine Ctrl-C is covered and
 * `taskkill` without /F is not, while on the CI runners both are.
 */

const DEFAULT_DISPOSER_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;

// 128 + signal number, the shell convention. A caller who scripts around Attest
// can tell "the user pressed Ctrl-C" from "a scenario failed" without parsing
// anything.
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGBREAK: 149
});

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Race a disposer against a deadline.
 *
 * A disposer that hangs must not stop the ones after it. This is the reason:
 * a Ctrl-C that appears to hang is worse than one that leaks, because the
 * operator's next move is SIGKILL, and then EVERYTHING leaks rather than one
 * thing. Bounding each disposer converts a total loss into a partial one.
 */
async function withDeadline(promise, timeoutMs) {
  let timer = null;

  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
        // The timer must never itself hold the loop open. A cleanup registry
        // that keeps the process alive is a new leak wearing the fix's clothes.
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export function createCleanupRegistry({
  disposerTimeoutMs = DEFAULT_DISPOSER_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  onEvent = null
} = {}) {
  const entries = new Map();
  const installed = new Map();
  let sequence = 0;
  let running = null;
  let signalCount = 0;
  let boundEmitter = process;
  let boundExit = (code) => process.exit(code);
  let explicitlyInstalled = false;

  function emit(event) {
    if (typeof onEvent === "function") {
      try {
        onEvent(Object.freeze(event));
      } catch {
        // An observer that throws must not take the cleanup down with it.
      }
    }
  }

  /**
   * Register a disposer.
   *
   * Returns a handle with `dispose()` for the normal path and `release()` for
   * "this resource went away on its own, stop tracking it". Both are idempotent,
   * because the normal path and the signal path race by construction and each
   * has to be safe when it loses.
   */
  function register(name, dispose, { critical = false } = {}) {
    if (typeof dispose !== "function") {
      throw new TypeError("A cleanup disposer must be a function");
    }

    const id = ++sequence;
    const entry = { id, name: String(name), dispose, critical, done: false };
    entries.set(id, entry);

    // Installed here, on first registration, NOT only from the CLI entry.
    //
    // A guarantee that depends on the entry point remembering to call install()
    // is not a guarantee, and the whole audit finding was that leaks happen on
    // the paths nobody thought about. Importing Attest's db layer as a library
    // and opening a slot has to be as safe as running the CLI, because that is
    // exactly the shape the interrupt tests spawn.
    ensureSignalHandlers();

    return Object.freeze({
      id,
      name: entry.name,

      async dispose() {
        if (entry.done) {
          return Object.freeze({ ok: true, alreadyDone: true });
        }

        entry.done = true;
        entries.delete(id);
        releaseIfIdle();

        try {
          await withDeadline(Promise.resolve(dispose("explicit")), disposerTimeoutMs);
          return Object.freeze({ ok: true });
        } catch (error) {
          return Object.freeze({ ok: false, error });
        }
      },

      release() {
        entry.done = true;
        entries.delete(id);
        releaseIfIdle();
      }
    });
  }

  /**
   * Run every registered disposer.
   *
   * Reverse acquisition order, because a resource acquired later may depend on
   * one acquired earlier: the poll client is opened against a connection, the
   * slot is created through a client, the recording is started on a booted
   * emulator. Tearing down forwards would close the thing the next disposer
   * needs.
   *
   * Never throws, and never stops early on a failure. One disposer failing must
   * not skip the eight after it, which was the concrete failure mode of the two
   * competing registries this replaces.
   */
  async function runAll(reason) {
    if (running !== null) {
      // A second signal arriving mid-cleanup joins the run in progress rather
      // than starting a competing one.
      return running;
    }

    const startedAt = nowMs();
    const pending = Array.from(entries.values()).sort((a, b) => b.id - a.id);
    const results = [];

    running = (async () => {
      for (const entry of pending) {
        if (entry.done) {
          continue;
        }

        entry.done = true;
        entries.delete(entry.id);

        const remaining = totalTimeoutMs - (nowMs() - startedAt);
        if (remaining <= 0) {
          // Out of budget. Recorded by name rather than silently skipped, so
          // the operator knows exactly what to go and check by hand.
          results.push(Object.freeze({ name: entry.name, ok: false, skipped: "deadline_exceeded" }));
          emit({ type: "cleanup_skipped", name: entry.name, reason });
          continue;
        }

        try {
          await withDeadline(Promise.resolve(entry.dispose(reason)), Math.min(disposerTimeoutMs, remaining));
          results.push(Object.freeze({ name: entry.name, ok: true }));
        } catch (error) {
          results.push(
            Object.freeze({
              name: entry.name,
              ok: false,
              critical: entry.critical,
              message: error instanceof Error ? error.message : String(error)
            })
          );
          emit({ type: "cleanup_failed", name: entry.name, reason, error });
        }
      }

      return Object.freeze({
        reason,
        elapsedMs: nowMs() - startedAt,
        results: Object.freeze(results),
        failed: Object.freeze(results.filter((result) => result.ok !== true))
      });
    })();

    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function handleSignal(signalName, exit) {
    return () => {
      signalCount += 1;

      if (signalCount > 1) {
        // The operator pressed Ctrl-C twice. They mean it. Stop trying to be
        // tidy and go, rather than appearing hung while a disposer waits on a
        // socket that is never going to answer.
        emit({ type: "cleanup_abandoned", reason: signalName });
        exit(SIGNAL_EXIT_CODES[signalName] ?? 1);
        return;
      }

      emit({ type: "cleanup_started", reason: signalName, pending: entries.size });
      void runAll(signalName).then((summary) => {
        emit({ type: "cleanup_finished", reason: signalName, summary });
        exit(SIGNAL_EXIT_CODES[signalName] ?? 1);
      });
    };
  }

  /**
   * The signal handlers. Installed lazily on first registration, removed when
   * the last resource is released.
   *
   * Removing them when idle matters more than it looks: a `node --test` process
   * that opens and closes a slot must end up back on Node's default signal
   * behaviour, or every subsequent Ctrl-C in that runner is intercepted by a
   * registry with nothing left to clean up.
   */
  function ensureSignalHandlers() {
    if (installed.size > 0 || boundEmitter === null) {
      return;
    }

    for (const signalName of Object.keys(SIGNAL_EXIT_CODES)) {
      const handler = handleSignal(signalName, boundExit);
      installed.set(signalName, handler);
      boundEmitter.on(signalName, handler);
    }

    // The library path's analogue of the CLI's explicit runAll("exit"): the loop
    // drained with resources still held, which is the last chance to release
    // them before the process goes.
    const onBeforeExit = () => {
      if (entries.size > 0) {
        void runAll("beforeExit");
      }
    };
    installed.set("beforeExit", onBeforeExit);
    boundEmitter.on("beforeExit", onBeforeExit);
  }

  function releaseIfIdle() {
    if (entries.size === 0 && !explicitlyInstalled) {
      uninstall();
    }
  }

  /**
   * Take ownership of the process.
   *
   * The CLI calls this. It pins the handlers on (so they are not removed
   * between scenarios) and adds the uncaught exception path, which is added
   * ONLY here: a `node --test` process must keep its own exception semantics,
   * and swallowing them would make failing tests look like passing ones.
   *
   * `emitter` and `exit` are injected so signal dispatch is asserted without a
   * test having to kill its own runner.
   */
  function install({ emitter = process, exit = (code) => process.exit(code) } = {}) {
    if (explicitlyInstalled) {
      return Object.freeze({ installed: false });
    }

    boundEmitter = emitter;
    boundExit = exit;
    explicitlyInstalled = true;

    uninstall();
    ensureSignalHandlers();

    // An uncaught exception is an abrupt exit too, and the default behaviour is
    // to print and die with everything still held.
    const onFatal = (error) => {
      emit({ type: "cleanup_started", reason: "uncaughtException", pending: entries.size, error });
      void runAll("uncaughtException").then(() => exit(1));
    };
    installed.set("uncaughtException", onFatal);
    emitter.on("uncaughtException", onFatal);

    return Object.freeze({ installed: true });
  }

  function uninstall() {
    if (boundEmitter === null) {
      return;
    }

    for (const [eventName, handler] of installed) {
      boundEmitter.off(eventName, handler);
    }
    installed.clear();
  }

  return Object.freeze({
    register,
    runAll,
    install,
    uninstall() {
      explicitlyInstalled = false;
      uninstall();
    },
    size: () => entries.size,
    names: () => Object.freeze(Array.from(entries.values(), (entry) => entry.name)),
    isInstalled: () => installed.size > 0
  });
}

// The process-wide instance. A module-scoped singleton on purpose: the whole
// point is that there is exactly one, and passing it through every constructor
// would leave the door open to a second.
export const cleanup = createCleanupRegistry();

export { SIGNAL_EXIT_CODES };

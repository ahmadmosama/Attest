import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { InfraError } from "../../../src/errors.mjs";
import { withClient } from "../../../src/db/drivers/postgres/connect.mjs";
import {
  createSlot,
  drainSlot,
  dropSlot,
  slotNameFor,
  sweepOrphanSlots,
  withSlot
} from "../../../src/db/drivers/postgres/slots.mjs";
import { skipUnlessPostgres } from "../../helpers/postgres.mjs";

function uniquePart(label) {
  return `${label}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`.toLowerCase();
}

function fakeTarget() {
  return Object.freeze({
    driver: "postgres",
    host: "127.0.0.1",
    port: 5432,
    database: "postgres",
    user: "postgres"
  });
}

function createSlotClient({ createError = null, dropErrors = [], slotRows = [] } = {}) {
  return {
    queries: [],
    dropCalls: 0,
    async query(sql, values = []) {
      const text = String(sql);
      this.queries.push({ text, values });

      if (text.includes("pg_create_logical_replication_slot")) {
        if (createError !== null) {
          const error = createError;
          createError = null;
          throw error;
        }
        return { rows: [{ slot_name: values[0] }] };
      }

      if (text.includes("pg_drop_replication_slot")) {
        const error = dropErrors[this.dropCalls];
        this.dropCalls += 1;
        if (error !== undefined) {
          throw error;
        }
        return { rows: [] };
      }

      if (text.includes("pg_replication_slots")) {
        return { rows: slotRows };
      }

      if (text.includes("pg_logical_slot_get_changes")) {
        return { rows: [{ lsn: "0/1", xid: "10", data: "BEGIN 10" }] };
      }

      throw new Error(`unexpected query ${text}`);
    }
  };
}

function pgError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function childScript({ useWithSlot }) {
  const createLine = useWithSlot
    ? `
      await withSlot(target, slotName, async () => {
        console.log("ready");
        process.stdin.resume();
        process.stdin.on("data", () => process.emit("SIGINT"));
        await new Promise(() => {});
      });
    `
    : `
      const client = await createPgClient(target);
      await createSlot(client, slotName);
      console.log("ready");
      process.stdin.resume();
      process.stdin.on("data", () => process.emit("SIGINT"));
      setInterval(() => {}, 1000);
    `;

  return `
    import { createPgClient } from "./src/db/drivers/postgres/connect.mjs";
    import { createSlot, withSlot } from "./src/db/drivers/postgres/slots.mjs";

    const parsed = new URL(process.env.ATTEST_PG_URL);
    const target = {
      driver: parsed.protocol.replace(/:$/u, ""),
      host: parsed.hostname.toLowerCase(),
      port: parsed.port === "" ? 5432 : Number(parsed.port),
      database: decodeURIComponent(parsed.pathname.replace(/^\\//u, "")),
      user: decodeURIComponent(parsed.username)
    };
    const slotName = process.env.ATTEST_CHILD_SLOT;
    ${createLine}
  `;
}

function waitForStdout(child, pattern) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`child did not print ${pattern}`));
    }, 8000);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (pattern.test(text)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before ready: ${code ?? signal}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function slotNames(client, like = "attest\\_%") {
  const result = await client.query(
    "SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE $1 ESCAPE '\\' ORDER BY slot_name",
    [like]
  );
  return result.rows.map((row) => row.slot_name);
}

test("slotNameFor returns legal deterministic names inside the Postgres identifier limit", () => {
  const first = slotNameFor({
    runId: "Run ID 123",
    scenarioId: "checkout scenario",
    surface: "web"
  });
  const same = slotNameFor({
    runId: "Run ID 123",
    scenarioId: "checkout scenario",
    surface: "web"
  });
  const second = slotNameFor({
    runId: "Run ID 123",
    scenarioId: "profile scenario",
    surface: "web"
  });
  const long = slotNameFor({
    runId: "RUN".repeat(50),
    scenarioId: "scenario/with spaces and punctuation".repeat(50),
    surface: "android"
  });

  assert.equal(first, same);
  assert.notEqual(first, second);
  assert.match(first, /^attest_[a-z0-9_]+$/u);
  assert.match(long, /^attest_[a-z0-9_]+$/u);
  assert(Buffer.byteLength(first, "utf8") <= 63);
  assert(Buffer.byteLength(long, "utf8") <= 63);
});

test("createSlot uses test_decoding and reports create failures as InfraError", async () => {
  const client = createSlotClient({ createError: new Error("boom") });
  const slotName = slotNameFor({ runId: "unit", scenarioId: "create_failure" });

  await assert.rejects(
    () => createSlot(client, slotName),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_SLOT_CREATE");
      assert.equal(error.details.slotName, slotName);
      return true;
    }
  );
  assert.match(client.queries[0].text, /pg_create_logical_replication_slot/u);
  assert.deepEqual(client.queries[0].values, [slotName]);
});

test("createSlot treats an existing slot as an orphan and recreates it with a warning", async () => {
  const client = createSlotClient({
    createError: pgError("42710", "replication slot already exists")
  });
  const slotName = slotNameFor({ runId: "unit", scenarioId: "existing" });

  const result = await createSlot(client, slotName);

  assert.equal(result.warnings[0].code, "W_DB_SLOT_ORPHAN_RECREATED");
  assert.equal(result.warnings[0].slotName, slotName);
  assert.deepEqual(
    client.queries.map((entry) =>
      entry.text.includes("pg_create_logical_replication_slot")
        ? "create"
        : entry.text.includes("pg_replication_slots")
          ? "inspect"
          : "drop"
    ),
    ["create", "inspect", "drop", "create"]
  );
});

test("createSlot never drops an active existing Attest slot", async () => {
  const slotName = slotNameFor({ runId: "unit", scenarioId: "active_existing" });
  const client = createSlotClient({
    createError: pgError("42710", "replication slot already exists"),
    slotRows: [{ slot_name: slotName, active: true }]
  });

  await assert.rejects(
    () => createSlot(client, slotName),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_SLOT_CREATE");
      assert.equal(error.details.reason, "existing_slot_active");
      return true;
    }
  );

  assert.equal(client.queries.some((entry) => entry.text.includes("pg_drop_replication_slot")), false);
});

test("withSlot drops in a finally block when the body throws or rejects", async () => {
  const slotName = slotNameFor({ runId: "unit", scenarioId: "finally_throw" });
  const thrownClient = createSlotClient();

  await assert.rejects(
    () =>
      withSlot(fakeTarget(), slotName, () => {
        throw new Error("assertion failed");
      }, { client: thrownClient }),
    /assertion failed/u
  );
  assert.equal(thrownClient.dropCalls, 1);

  const rejectedClient = createSlotClient();
  await assert.rejects(
    () =>
      withSlot(fakeTarget(), slotNameFor({ runId: "unit", scenarioId: "finally_reject" }), async () => {
        throw new Error("timeout");
      }, { client: rejectedClient }),
    /timeout/u
  );
  assert.equal(rejectedClient.dropCalls, 1);
});

test("withSlot drops when the caller aborts through the signal", async () => {
  const controller = new AbortController();
  const client = createSlotClient();

  await assert.rejects(
    () =>
      withSlot(fakeTarget(), slotNameFor({ runId: "unit", scenarioId: "abort" }), async ({ signal }) => {
        controller.abort(new Error("bounded timeout"));
        signal.throwIfAborted();
      }, { client, signal: controller.signal }),
    /bounded timeout/u
  );
  assert.equal(client.dropCalls, 1);
});

test("dropSlot retries once and then reports E_DB_SLOT_DROP without swallowing the incident", async () => {
  const slotName = slotNameFor({ runId: "unit", scenarioId: "drop_retry" });
  const recovered = createSlotClient({
    dropErrors: [new Error("temporary")]
  });

  const result = await dropSlot(recovered, slotName);
  assert.equal(result.dropped, true);
  assert.equal(result.attempts, 2);

  const failed = createSlotClient({
    dropErrors: [new Error("first"), new Error("second")]
  });
  await assert.rejects(
    () => dropSlot(failed, slotNameFor({ runId: "unit", scenarioId: "drop_fail" })),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_SLOT_DROP");
      assert.equal(error.details.severity, "infra_error");
      assert.equal(error.details.attempts, 2);
      return true;
    }
  );
});

test("sweepOrphanSlots drops inactive attest slots, keeps requested slots, and leaves active or foreign slots alone", async () => {
  const dropped = slotNameFor({ runId: "unit", scenarioId: "drop_me" });
  const kept = slotNameFor({ runId: "unit", scenarioId: "keep_me" });
  const active = slotNameFor({ runId: "unit", scenarioId: "active" });
  const logs = [];
  const client = createSlotClient({
    slotRows: [
      { slot_name: dropped, active: false },
      { slot_name: kept, active: false },
      { slot_name: active, active: true },
      { slot_name: "other_tool_slot", active: false }
    ]
  });

  const result = await sweepOrphanSlots(client, {
    keep: [kept],
    logger: (entry) => logs.push(entry)
  });

  assert.deepEqual(result, [dropped]);
  assert.deepEqual(
    client.queries.filter((entry) => entry.text.includes("pg_drop_replication_slot")).map((entry) => entry.values[0]),
    [dropped]
  );
  assert.deepEqual(
    logs.map((entry) => entry.action),
    ["drop_orphan", "skip_keep", "skip_active", "skip_non_attest"]
  );
});

test("drainSlot returns bounded rows and a more flag", async () => {
  const client = createSlotClient();
  const slotName = slotNameFor({ runId: "unit", scenarioId: "drain" });

  const result = await drainSlot(client, slotName, { batchSize: 1 });

  assert.equal(result.rows.length, 1);
  assert.equal(result.more, true);
  assert.deepEqual(client.queries[0].values, [slotName, 1]);
});

test("live Postgres lifecycle creates, consumes, drops, and leaves no attest slots", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  const slotName = slotNameFor({ runId: uniquePart("live"), scenarioId: "lifecycle" });
  await withClient(live.target, async (client) => {
    try {
      await withSlot(live.target, slotName, async ({ client: slotClient }) => {
        const created = await slotNames(slotClient);
        assert(created.includes(slotName));
        const drained = await drainSlot(slotClient, slotName);
        assert.equal(Array.isArray(drained.rows), true);
      }, { client });
    } finally {
      await dropSlot(client, slotName);
      assert.equal((await slotNames(client)).includes(slotName), false);
    }
  });
});

test("live Postgres SIGINT cleanup drops an open slot before child exit", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  const slotName = slotNameFor({ runId: uniquePart("sigint"), scenarioId: "cleanup" });
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript({ useWithSlot: false })], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ATTEST_PG_URL: live.url,
      ATTEST_CHILD_SLOT: slotName
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  try {
    await waitForStdout(child, /ready/u);
    await withClient(live.target, async (client) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await slotNames(client)).includes(slotName)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("slot was not created before SIGINT");
    });

    child.stdin.write("sigint\n");
    await waitForExit(child);

    await withClient(live.target, async (client) => {
      assert.equal((await slotNames(client)).includes(slotName), false);
    });
  } finally {
    child.kill("SIGKILL");
    await withClient(live.target, async (client) => {
      await dropSlot(client, slotName);
    });
  }
});

test("live Postgres hard kill orphan is removed by the next sweep", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  const slotName = slotNameFor({ runId: uniquePart("kill"), scenarioId: "orphan" });
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript({ useWithSlot: false })], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ATTEST_PG_URL: live.url,
      ATTEST_CHILD_SLOT: slotName
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForStdout(child, /ready/u);
    await withClient(live.target, async (client) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await slotNames(client)).includes(slotName)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("slot was not created before SIGKILL");
    });

    child.kill("SIGKILL");
    await waitForExit(child);

    await withClient(live.target, async (client) => {
      assert((await slotNames(client)).includes(slotName));
      const dropped = await sweepOrphanSlots(client, { logger: null });
      assert(dropped.includes(slotName));
      assert.equal((await slotNames(client)).includes(slotName), false);
    });
  } finally {
    child.kill("SIGKILL");
    await withClient(live.target, async (client) => {
      await dropSlot(client, slotName);
    });
  }
});

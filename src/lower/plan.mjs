import { createHash } from "node:crypto";

import stringify from "json-stable-stringify";

import { isSemanticRef } from "../ir/semantic-ref.mjs";
import { OPS } from "../ir/ops.mjs";

export const PLAN_VERSION = 1;

export const PLAN_OP_KINDS = Object.freeze({
  open: "navigate",
  back: "back",
  background: "app_background",
  foreground: "app_foreground",
  tap: "click",
  long_press: "long_press",
  fill: "fill",
  clear: "clear",
  press_key: "press_key",
  swipe: "swipe",
  scroll_until_visible: "scroll_until_visible",
  select_option: "select_option",
  upload_file: "upload_file",
  set_permission: "set_permission",
  set_network: "set_network",
  set_clipboard: "set_clipboard",
  expect_visible: "expect_visible",
  expect_hidden: "expect_hidden",
  expect_text: "expect_text",
  expect_state: "expect_state",
  expect_count: "expect_count",
  checkpoint: "checkpoint",
  delta_window: Object.freeze({ open: "db_window_open", close: "db_window_close" }),
  run_flow: null,
  raw: "raw"
});

const PLAN_KIND_SET = new Set(
  Object.values(PLAN_OP_KINDS).flatMap((kind) => {
    if (kind === null) {
      return [];
    }
    if (typeof kind === "string") {
      return [kind];
    }
    return Object.values(kind);
  })
);

function assertPlanKindsCoverOps() {
  const mapped = Object.keys(PLAN_OP_KINDS).toSorted();
  const ops = [...OPS].toSorted();

  if (mapped.length !== ops.length || mapped.some((op, index) => op !== ops[index])) {
    throw new Error("PLAN_OP_KINDS must cover every IR op exactly once");
  }
}

assertPlanKindsCoverOps();

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function assertString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non empty string`);
  }
}

function assertStringArray(value, field) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }

  for (const item of value) {
    assertString(item, field);
  }
}

function assertJsonData(value, path = "plan") {
  if (value === undefined) {
    throw new TypeError(`${path} cannot contain undefined`);
  }

  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`${path} must be JSON serializable`);
  }

  if (typeof value === "string" && isSemanticRef(value)) {
    throw new TypeError(`${path} contains unresolved SemanticRef ${value}`);
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonData(item, `${path}[${index}]`));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    assertJsonData(child, `${path}.${key}`);
  }
}

function assertDenseOps(ops) {
  if (!Array.isArray(ops)) {
    throw new TypeError("ExecutionPlan ops must be an array");
  }

  ops.forEach((op, index) => {
    if (op === null || typeof op !== "object" || Array.isArray(op)) {
      throw new TypeError("ExecutionPlan ops must contain objects");
    }
    if (op.i !== index) {
      throw new TypeError("ExecutionPlan op indices must be dense 0..n-1");
    }
    if (!PLAN_KIND_SET.has(op.kind)) {
      throw new TypeError(`Unknown plan op kind ${op.kind}`);
    }
  });
}

function withoutPlanHash(plan) {
  const { planHash: _planHash, ...hashable } = plan;
  return hashable;
}

export function hashPlan(plan) {
  const canonical = stringify(withoutPlanHash(plan));
  return createHash("sha256").update(canonical).digest("hex");
}

export function createExecutionPlan(fields) {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new TypeError("ExecutionPlan fields must be an object");
  }

  assertString(fields.scenarioId, "ExecutionPlan scenarioId");
  assertString(fields.surface, "ExecutionPlan surface");
  assertString(fields.app, "ExecutionPlan app");
  assertString(fields.bindingsHash, "ExecutionPlan bindingsHash");
  assertStringArray(fields.requirements, "ExecutionPlan requirements");
  assertDenseOps(fields.ops);

  const capabilities = fields.capabilities;
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new TypeError("ExecutionPlan capabilities must be an object");
  }
  assertStringArray(capabilities.demanded, "ExecutionPlan capabilities.demanded");
  assertStringArray(capabilities.satisfiedBy?.surface, "ExecutionPlan capabilities.satisfiedBy.surface");
  assertStringArray(capabilities.satisfiedBy?.db, "ExecutionPlan capabilities.satisfiedBy.db");

  const rawOpCount = fields.rawOpCount;
  if (!Number.isInteger(rawOpCount) || rawOpCount < 0) {
    throw new TypeError("ExecutionPlan rawOpCount must be a non negative integer");
  }

  const planBase = {
    planVersion: PLAN_VERSION,
    scenarioId: fields.scenarioId,
    surface: fields.surface,
    app: fields.app,
    bindingsHash: fields.bindingsHash,
    rulesetHash: fields.rulesetHash ?? null,
    seedDigest: fields.seedDigest ?? null,
    requirements: [...fields.requirements],
    capabilities: {
      demanded: [...capabilities.demanded],
      satisfiedBy: {
        surface: [...capabilities.satisfiedBy.surface],
        db: [...capabilities.satisfiedBy.db]
      }
    },
    rawOpCount,
    planHash: null,
    ops: fields.ops.map((op) => ({ ...op }))
  };

  assertJsonData(planBase);

  const planHash = hashPlan(planBase);
  const plan = { ...planBase, planHash };

  assertJsonData(plan);
  return deepFreeze(plan);
}

import { dirname, resolve } from "node:path";
import { promises as fs } from "node:fs";

import { hashRule } from "./hash.mjs";

export const DEAD_RULE_RUNS = 3;

const DEFAULT_STORE_PATH = ".attest/rule-health.json";
const EXPIRING_SOON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function freeze(value) {
  return Object.freeze(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function defaultClock() {
  return new Date();
}

function nowValue(now) {
  return typeof now === "function" ? now() : now;
}

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("now must be a Date or a date parseable value");
  }

  return date.toISOString().slice(0, 10);
}

function dateToUtcMs(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.getTime();
}

function emptyState() {
  return freeze({ rules: freeze({}) });
}

function normalizeState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return emptyState();
  }

  const rules = value.rules;
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
    return emptyState();
  }

  return deepFreeze({
    rules: Object.fromEntries(
      Object.entries(rules).filter(([, entry]) => entry !== null && typeof entry === "object")
    )
  });
}

async function readJsonFile(path) {
  try {
    const body = await fs.readFile(path, "utf8");
    return normalizeState(JSON.parse(body));
  } catch {
    return emptyState();
  }
}

async function atomicWriteJson(path, value) {
  const absolute = resolve(path);
  const folder = dirname(absolute);
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(temporary, body, "utf8");
  await fs.rename(temporary, absolute);
}

function storePath(inputPath) {
  return inputPath ?? DEFAULT_STORE_PATH;
}

export function createRuleHealthStore({ path } = {}) {
  const file = storePath(path);

  return freeze({
    path: file,
    async read() {
      return readJsonFile(file);
    },
    async write(value) {
      await atomicWriteJson(file, normalizeState(value));
    }
  });
}

function rulesFromRuleset(ruleset) {
  if (Array.isArray(ruleset?.rules)) {
    return ruleset.rules;
  }

  if (Array.isArray(ruleset)) {
    return ruleset;
  }

  return [];
}

function statsById(ruleStats) {
  return new Map((Array.isArray(ruleStats) ? ruleStats : []).map((stat) => [stat.id, stat]));
}

function stateKey(rule, ruleHash) {
  return `${rule.id}:${ruleHash}`;
}

function fireCount(stat) {
  if (stat === undefined) {
    return 0;
  }

  const suppressed = Number.isFinite(stat.suppressed) ? stat.suppressed : 0;
  const overBudget = Number.isFinite(stat.overBudget) ? stat.overBudget : 0;
  return suppressed + overBudget;
}

function assessDeadRules({ rules, ruleStats, previous }) {
  const byId = statsById(ruleStats);
  const nextRules = {};
  const dead = [];

  for (const rule of rules) {
    const ruleHash = hashRule(rule);
    const key = stateKey(rule, ruleHash);
    const stat = byId.get(rule.id);
    const fired = fireCount(stat);
    const prior = previous.rules[key];
    const zeroRunCount = fired > 0 ? 0 : Number.isInteger(prior?.consecutiveZeroRuns)
      ? prior.consecutiveZeroRuns + 1
      : 1;

    nextRules[key] = {
      ruleId: rule.id,
      ruleHash,
      consecutiveZeroRuns: zeroRunCount,
      lastFireCount: fired
    };

    if (zeroRunCount >= DEAD_RULE_RUNS) {
      dead.push({
        ruleId: rule.id,
        id: rule.id,
        ruleHash,
        consecutiveZeroRuns: zeroRunCount,
        proposedAction: "delete_rule"
      });
    }
  }

  return {
    dead,
    state: { rules: nextRules }
  };
}

function assessExpiry(rules, now) {
  const today = dateOnly(nowValue(now));
  const todayMs = dateToUtcMs(today);
  const expired = [];
  const expiringSoon = [];

  for (const rule of rules) {
    if (rule.kind !== "ignore") {
      continue;
    }

    const expires = rule.expires;
    const expiresMs = dateToUtcMs(expires);
    const daysUntilExpiry = Math.floor((expiresMs - todayMs) / DAY_MS);

    if (expires < today) {
      expired.push({
        ruleId: rule.id,
        id: rule.id,
        expires
      });
      continue;
    }

    if (daysUntilExpiry <= EXPIRING_SOON_DAYS) {
      expiringSoon.push({
        ruleId: rule.id,
        id: rule.id,
        expires,
        daysUntilExpiry
      });
    }
  }

  return {
    expired,
    expiringSoon
  };
}

export async function assessRuleHealth({
  ruleStats = [],
  ruleset = { rules: [] },
  store = createRuleHealthStore(),
  now = defaultClock
} = {}) {
  const rules = rulesFromRuleset(ruleset);
  const previous = normalizeState(await store.read());
  const deadAssessment = assessDeadRules({ rules, ruleStats, previous });
  const expiry = assessExpiry(rules, now);

  await store.write(deadAssessment.state);

  return deepFreeze({
    dead: deadAssessment.dead,
    expired: expiry.expired,
    expiringSoon: expiry.expiringSoon,
    failed: expiry.expired.length > 0,
    state: deadAssessment.state
  });
}

import { createHash } from "node:crypto";

import stringify from "json-stable-stringify";

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }

  return value;
}

function requireRulesArray(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("ruleset rules must be an array");
  }

  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRule(rule) {
  return Object.freeze({ ...requireObject(rule, "rule") });
}

function sortedRules(rules) {
  return [...requireRulesArray(rules)]
    .map(canonicalRule)
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function hashRulesPayload(ruleset) {
  const checkedRuleset = requireObject(ruleset, "ruleset");

  return {
    version: checkedRuleset.version,
    rules: sortedRules(checkedRuleset.rules ?? [])
  };
}

export function hashRule(rule) {
  return sha256(stringify(canonicalRule(rule)));
}

export function hashRuleset(ruleset) {
  return sha256(stringify(hashRulesPayload(ruleset)));
}

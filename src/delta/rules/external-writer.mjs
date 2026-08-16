import { AttestError } from "../../errors.mjs";

export const IDENTITY_PREDICATES = Object.freeze({
  transaction: "transaction",
  applicationName: "application_name"
});

function freeze(value) {
  return Object.freeze(value);
}

function tableName(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity;
}

function entityMatches(ruleEntity, eventEntity) {
  return ruleEntity === eventEntity || ruleEntity === tableName(eventEntity);
}

function driverName(dbCaps) {
  return typeof dbCaps?.driver === "string" ? dbCaps.driver : "unknown";
}

function supportsTransactionIdentity(dbCaps) {
  return dbCaps?.txAttribution === true;
}

function supportsApplicationNameIdentity(dbCaps) {
  if (dbCaps?.applicationNameAttribution === true) {
    return true;
  }

  if (Array.isArray(dbCaps?.identityPredicates)) {
    return dbCaps.identityPredicates.includes(IDENTITY_PREDICATES.applicationName);
  }

  if (Array.isArray(dbCaps?.attribution)) {
    return dbCaps.attribution.includes(IDENTITY_PREDICATES.applicationName);
  }

  return dbCaps?.attribution?.applicationName === true;
}

function unsupportedIdentity(rule, dbCaps) {
  return new AttestError(
    "E_RULE_IDENTITY_UNSUPPORTED",
    `Rule ${rule.id} uses identity predicate ${rule.identity.by} unsupported by driver ${driverName(dbCaps)}`,
    {
      ruleId: rule.id,
      driver: driverName(dbCaps),
      predicate: rule.identity.by
    }
  );
}

function assertSupportedIdentity(rule, dbCaps) {
  if (rule.identity.by === IDENTITY_PREDICATES.transaction && !supportsTransactionIdentity(dbCaps)) {
    throw unsupportedIdentity(rule, dbCaps);
  }

  if (
    rule.identity.by === IDENTITY_PREDICATES.applicationName &&
    !supportsApplicationNameIdentity(dbCaps)
  ) {
    throw unsupportedIdentity(rule, dbCaps);
  }
}

function applicationName(actor) {
  const candidate = actor?.applicationName ?? actor?.application_name;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function normalizeTransactionSet(value) {
  if (value instanceof Set) {
    return value;
  }

  if (Array.isArray(value)) {
    return new Set(value);
  }

  return new Set();
}

export function createExternalWriterMatcher(rule, { dbCaps } = {}) {
  assertSupportedIdentity(rule, dbCaps);

  let suppressed = 0;
  let scenarioTransactions = new Set();

  function reset() {
    suppressed = 0;
    scenarioTransactions = new Set();
  }

  function prime({ scenarioTransactions: transactions } = {}) {
    scenarioTransactions = normalizeTransactionSet(transactions);
  }

  function identityMatches(event) {
    if (rule.identity.by === IDENTITY_PREDICATES.transaction) {
      return event.txId !== null && !scenarioTransactions.has(event.txId);
    }

    if (rule.identity.by === IDENTITY_PREDICATES.applicationName) {
      const name = applicationName(event.actor);
      return name !== null && name !== rule.identity.not_equals;
    }

    return false;
  }

  function match(event) {
    if (!entityMatches(rule.entity, event.entity) || !identityMatches(event)) {
      return freeze({ explained: false });
    }

    suppressed += 1;
    return freeze({
      explained: true,
      ruleId: rule.id,
      kind: rule.kind
    });
  }

  reset();

  return freeze({
    id: rule.id,
    kind: rule.kind,
    entity: rule.entity,
    rule,
    prime,
    match,
    reset,
    stats() {
      return freeze({
        id: rule.id,
        kind: rule.kind,
        entity: rule.entity,
        suppressed,
        overBudget: 0,
        cap: rule.cap
      });
    }
  });
}

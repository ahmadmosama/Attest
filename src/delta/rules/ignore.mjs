function freeze(value) {
  return Object.freeze(value);
}

function tableName(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity;
}

function entityMatches(ruleEntity, eventEntity) {
  return ruleEntity === eventEntity || ruleEntity === tableName(eventEntity);
}

function dateOnly(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("now must be a Date or a date parseable value");
  }

  return date.toISOString().slice(0, 10);
}

function defaultClock() {
  return new Date();
}

export function createIgnoreMatcher(rule, { now = defaultClock } = {}) {
  const clock = typeof now === "function" ? now : () => now;
  let suppressed = 0;

  function isExpired(value = clock()) {
    return rule.expires < dateOnly(value);
  }

  function match(event) {
    const opMatches = rule.op === undefined || rule.op === event.op;
    if (isExpired() || !entityMatches(rule.entity, event.entity) || !opMatches) {
      return freeze({ explained: false });
    }

    suppressed += 1;
    return freeze({
      explained: true,
      ruleId: rule.id,
      kind: rule.kind
    });
  }

  return freeze({
    id: rule.id,
    kind: rule.kind,
    entity: rule.entity,
    rule,
    isExpired,
    match,
    reset() {
      suppressed = 0;
    },
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

function freeze(value) {
  return Object.freeze(value);
}

function tableName(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity;
}

function entityMatches(ruleEntity, eventEntity) {
  return ruleEntity === eventEntity || ruleEntity === tableName(eventEntity);
}

function sourceMatches(rule, event) {
  return entityMatches(rule.caused_by.entity, event.entity) && rule.caused_by.op === event.op;
}

function targetMatches(rule, event) {
  return entityMatches(rule.entity, event.entity);
}

function eventOrder(left, right) {
  const leftSeq = Number.isInteger(left.event.seq) ? left.event.seq : null;
  const rightSeq = Number.isInteger(right.event.seq) ? right.event.seq : null;

  if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return left.index - right.index;
}

function countSources(rule, events) {
  return events.filter((event) => sourceMatches(rule, event)).length;
}

function orderedTargets(rule, events) {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => targetMatches(rule, event))
    .toSorted(eventOrder);
}

function weakSetFrom(values) {
  const set = new WeakSet();
  for (const value of values) {
    set.add(value);
  }
  return set;
}

export function createDerivedMatcher(rule) {
  let budget = 0;
  let remaining = 0;
  let suppressed = 0;
  let overBudget = 0;
  let primed = false;
  let deterministicAllowed = new WeakSet();
  let deterministicTargets = new WeakSet();
  let seenExplained = new WeakSet();
  let seenOverBudget = new WeakSet();

  function reset() {
    budget = 0;
    remaining = 0;
    suppressed = 0;
    overBudget = 0;
    primed = false;
    deterministicAllowed = new WeakSet();
    deterministicTargets = new WeakSet();
    seenExplained = new WeakSet();
    seenOverBudget = new WeakSet();
  }

  function prime(sourceEvents = []) {
    const events = Array.isArray(sourceEvents) ? sourceEvents : [];
    const sourceCount = countSources(rule, events);
    const targets = orderedTargets(rule, events);
    const allowedTargets = targets.slice(0, sourceCount * rule.per_source).map(({ event }) => event);

    budget = sourceCount * rule.per_source;
    remaining = budget;
    primed = true;
    deterministicTargets = weakSetFrom(targets.map(({ event }) => event));
    deterministicAllowed = weakSetFrom(allowedTargets);
  }

  function explain(event) {
    suppressed += 1;
    if (remaining > 0) {
      remaining -= 1;
    }

    seenExplained.add(event);
    return freeze({
      explained: true,
      ruleId: rule.id,
      kind: rule.kind,
      mechanism: rule.mechanism
    });
  }

  function rejectOverBudget(event) {
    if (!seenOverBudget.has(event)) {
      overBudget += 1;
      seenOverBudget.add(event);
    }

    return freeze({
      explained: false,
      ruleId: rule.id,
      overBudget: true
    });
  }

  function match(event) {
    if (!targetMatches(rule, event)) {
      return freeze({ explained: false });
    }

    if (seenExplained.has(event)) {
      return freeze({
        explained: true,
        ruleId: rule.id,
        kind: rule.kind,
        mechanism: rule.mechanism
      });
    }

    if (primed && deterministicTargets.has(event)) {
      return deterministicAllowed.has(event) ? explain(event) : rejectOverBudget(event);
    }

    if (remaining <= 0) {
      return rejectOverBudget(event);
    }

    return explain(event);
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
        overBudget,
        cap: rule.cap
      });
    }
  });
}

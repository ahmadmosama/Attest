const PATH_SEPARATOR = ".";

function freeze(value) {
  return Object.freeze(value);
}

function tableName(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity;
}

function entityMatches(ruleEntity, eventEntity) {
  return ruleEntity === eventEntity || ruleEntity === tableName(eventEntity);
}

function escapeRegex(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function compileSegment(segment) {
  if (!segment.includes("*")) {
    return (value) => value === segment;
  }

  const pattern = `^${segment.split("*").map(escapeRegex).join(".*")}$`;
  const regex = new RegExp(pattern, "u");
  return (value) => regex.test(value);
}

function compilePathPattern(pattern) {
  const segments = pattern.split(PATH_SEPARATOR);
  const matchers = segments.map(compileSegment);

  return (path) =>
    Array.isArray(path) &&
    path.length === matchers.length &&
    matchers.every((matcher, index) => matcher(path[index]));
}

function pathKey(path) {
  return path.join(PATH_SEPARATOR);
}

function clonePath(path) {
  return freeze(path.slice());
}

function strippedEvent(event, retainedPaths, volatileStripped) {
  return freeze({
    ...event,
    paths: freeze(retainedPaths.map(clonePath)),
    volatileStripped: freeze([
      ...new Set([...(event.volatileStripped ?? []), ...volatileStripped])
    ])
  });
}

function emptyResult(event) {
  return freeze({
    explained: false,
    touched: false,
    event,
    volatileStripped: freeze([])
  });
}

/**
 * Volatile columns suppress value comparison only.
 *
 * An updated_at moving is not a license for the row to change. The row still
 * counts as touched and still has to be explained by something else.
 */
export function createVolatileMatcher(rule) {
  const pathMatchers = rule.paths.map(compilePathPattern);
  let suppressed = 0;

  function isVolatilePath(path) {
    return pathMatchers.some((matcher) => matcher(path));
  }

  function match(event) {
    if (event.op !== "update" || !entityMatches(rule.entity, event.entity)) {
      return emptyResult(event);
    }

    const retained = [];
    const stripped = [];
    for (const path of event.paths) {
      if (isVolatilePath(path)) {
        stripped.push(pathKey(path));
      } else {
        retained.push(path);
      }
    }

    if (stripped.length === 0) {
      return emptyResult(event);
    }

    suppressed += stripped.length;
    return freeze({
      explained: false,
      touched: true,
      ruleId: rule.id,
      event: strippedEvent(event, retained, stripped),
      volatileStripped: freeze(stripped)
    });
  }

  return freeze({
    id: rule.id,
    kind: rule.kind,
    entity: rule.entity,
    rule,
    match,
    transform(event) {
      return match(event).event;
    },
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

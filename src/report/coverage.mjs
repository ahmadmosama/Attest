function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function asRequirementList(scenario) {
  const value = scenario?.requirements ?? scenario?.requirement ?? [];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function scenarioId(scenario, index) {
  return typeof scenario?.id === "string" && scenario.id.length > 0 ? scenario.id : `scenario-${index}`;
}

function sortedUnique(values) {
  return [...new Set(values)].toSorted();
}

function declaredSet(declaredRequirements) {
  return new Set(
    Array.isArray(declaredRequirements)
      ? declaredRequirements.filter((item) => typeof item === "string" && item.length > 0)
      : []
  );
}

export function computeCoverage({ scenarios, declaredRequirements = [] } = {}) {
  if (!Array.isArray(scenarios)) {
    throw new TypeError("scenarios must be an array");
  }

  const declared = declaredSet(declaredRequirements);
  const entries = scenarios
    .map((scenario, index) => [scenarioId(scenario, index), sortedUnique(asRequirementList(scenario))])
    .toSorted(([left], [right]) => left.localeCompare(right));
  const covered = sortedUnique(entries.flatMap(([, requirements]) => requirements));
  const byScenario = Object.fromEntries(entries);
  const hasDeclaredList = declared.size > 0;
  const uncovered = hasDeclaredList
    ? [...declared].filter((requirement) => !covered.includes(requirement)).toSorted()
    : [];
  const unknown = hasDeclaredList
    ? covered.filter((requirement) => !declared.has(requirement)).toSorted()
    : [];

  return deepFreeze({
    covered,
    byScenario,
    uncovered,
    unknown
  });
}

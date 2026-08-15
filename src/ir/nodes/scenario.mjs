function sortedUnique(values) {
  return [...new Set(values)].toSorted();
}

function rawSurfaces(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value)
    .filter((key) => key !== "reason")
    .toSorted();
}

export function createScenarioNode({ ast, steps }) {
  const scenario = ast.value;
  const stepCapabilities = steps.flatMap((step) => step.capabilities);
  const scenarioCapabilities = Array.isArray(scenario.capabilities) ? scenario.capabilities : [];

  return {
    irVersion: 1,
    id: scenario.id,
    file: ast.file,
    requirements: [...scenario.requirement],
    tags: Array.isArray(scenario.tags) ? [...scenario.tags] : [],
    capabilities: sortedUnique([...scenarioCapabilities, ...stepCapabilities]),
    refs: sortedUnique(steps.flatMap((step) => step.refs)),
    seed: scenario.data?.seed ?? null,
    suppressions: Array.isArray(scenario.suppressions)
      ? scenario.suppressions.map((suppression) => ({ ...suppression }))
      : [],
    rawUses: steps
      .filter((step) => step.op === "raw")
      .map((step) => ({
        stepIndex: step.index,
        reason: step.value.reason,
        surfaces: rawSurfaces(step.value)
      })),
    steps
  };
}

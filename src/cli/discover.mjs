import { glob } from "tinyglobby";

import { UsageError } from "../errors.mjs";

function uniqueSorted(values) {
  return [...new Set(values)].toSorted();
}

function asList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export async function discoverScenarios({ globs, cwd }) {
  const patterns = asList(globs);
  if (patterns.length === 0) {
    throw new UsageError("E_NO_SCENARIO_GLOB", "At least one scenario glob is required");
  }

  const matches = await glob(patterns, {
    cwd,
    onlyFiles: true,
    absolute: false,
    ignore: ["**/node_modules/**", "**/proposed/**"]
  });

  return uniqueSorted(matches.map((match) => match.replaceAll("\\", "/")));
}

export function applyFilters(scenarios, { ids = [], tags = [], surfaces = [] } = {}) {
  if (!Array.isArray(scenarios)) {
    throw new TypeError("scenarios must be an array");
  }

  const idSet = new Set(ids);
  const tagSet = new Set(tags);
  const surfaceList = surfaces.length > 0 ? uniqueSorted(surfaces) : null;

  const selected = scenarios
    .filter((scenario) => idSet.size === 0 || idSet.has(scenario.id))
    .filter(
      (scenario) =>
        tagSet.size === 0 || [...tagSet].every((tag) => Array.isArray(scenario.tags) && scenario.tags.includes(tag))
    )
    .map((scenario) =>
      Object.freeze({
        ...scenario,
        selectedSurfaces: Object.freeze(surfaceList ?? uniqueSorted(scenario.surfaces ?? []))
      })
    );

  if (selected.every((scenario) => scenario.selectedSurfaces.length === 0)) {
    throw new UsageError("E_EMPTY_SCENARIO_SELECTION", "Scenario selection is empty");
  }

  return selected;
}

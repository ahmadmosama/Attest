import { create } from "xmlbuilder2";

import { RunRecordSchema } from "./run-record.mjs";

function seconds(durationMs) {
  return (durationMs / 1000).toFixed(3);
}

function firstStepError(scenario, status) {
  return scenario.steps.find((step) => step.status === status && step.error !== null)?.error;
}

function firstStepIndex(scenario, status) {
  return scenario.steps.find((step) => step.status === status)?.index ?? 0;
}

function groupBySurface(scenarios) {
  const grouped = new Map();

  for (const scenario of scenarios) {
    const items = grouped.get(scenario.surface) ?? [];
    items.push(scenario);
    grouped.set(scenario.surface, items);
  }

  return [...grouped.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([surface, items]) => [
      surface,
      items.toSorted((left, right) => left.id.localeCompare(right.id))
    ]);
}

function suiteCounts(scenarios) {
  return Object.freeze({
    tests: scenarios.length,
    failures: scenarios.filter((scenario) => scenario.result === "fail").length,
    errors: scenarios.filter((scenario) => scenario.result === "infra_error").length,
    skipped: scenarios.filter((scenario) => scenario.result === "skipped").length
  });
}

function addScenario(testcase, scenario) {
  if (scenario.result === "fail") {
    const error = scenario.error ?? firstStepError(scenario, "fail");
    const code = error?.code ?? "E_SCENARIO_FAILED";
    testcase.ele("failure", {
      message: `step ${firstStepIndex(scenario, "fail")} ${code}`,
      type: code
    });
  }

  if (scenario.result === "infra_error") {
    const code = scenario.error?.code ?? "E_INFRA_ERROR";
    testcase.ele("error", {
      message: `step ${firstStepIndex(scenario, "timed_out")} ${code}`,
      type: code
    });
  }

  if (scenario.result === "skipped") {
    testcase.ele("skipped", {
      message: scenario.skipped.capabilities.join(", ")
    });
  }
}

export function toJUnitXml(runRecord) {
  const record = RunRecordSchema.parse(runRecord);
  const document = create({ version: "1.0", encoding: "UTF-8" }).ele("testsuites", {
    tests: record.counts.total,
    failures: record.counts.failed,
    errors: record.counts.infra_error,
    skipped: record.counts.skipped
  });

  for (const [surface, scenarios] of groupBySurface(record.scenarios)) {
    const counts = suiteCounts(scenarios);
    const suite = document.ele("testsuite", {
      name: surface,
      tests: counts.tests,
      failures: counts.failures,
      errors: counts.errors,
      skipped: counts.skipped
    });

    for (const scenario of scenarios) {
      const testcase = suite.ele("testcase", {
        classname: surface,
        name: scenario.id,
        time: seconds(scenario.durationMs)
      });
      addScenario(testcase, scenario);
    }
  }

  return document.end({ prettyPrint: true });
}

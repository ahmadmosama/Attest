import Table from "cli-table3";
import pc from "picocolors";

import { RunRecordSchema } from "./run-record.mjs";
import { buildDeltaView, formatBucketHeader, formatRuleTable } from "./delta-view.mjs";

const TABLE_CHARS = Object.freeze({
  top: "-",
  "top-mid": "+",
  "top-left": "+",
  "top-right": "+",
  bottom: "-",
  "bottom-mid": "+",
  "bottom-left": "+",
  "bottom-right": "+",
  left: "|",
  "left-mid": "+",
  mid: "-",
  "mid-mid": "+",
  right: "|",
  "right-mid": "+",
  middle: "|"
});

function colorResult(result, colors) {
  if (result === "pass") {
    return colors.green(result);
  }

  if (result === "fail") {
    return colors.red(result);
  }

  if (result === "infra_error") {
    return colors.magenta(result);
  }

  if (result === "skipped") {
    return colors.yellow(result);
  }

  return colors.dim(result);
}

function sortedScenarios(scenarios) {
  return [...scenarios].toSorted((left, right) => {
    const surfaceOrder = left.surface.localeCompare(right.surface);
    return surfaceOrder === 0 ? left.id.localeCompare(right.id) : surfaceOrder;
  });
}

function tableFor(record, colors, width) {
  const idWidth = Math.max(18, Math.floor(width * 0.32));
  const table = new Table({
    chars: TABLE_CHARS,
    head: ["Scenario", "Surface", "Result", "ms"],
    colWidths: [idWidth, 14, 14, 10],
    style: {
      head: [],
      border: []
    }
  });

  for (const scenario of sortedScenarios(record.scenarios)) {
    table.push([
      scenario.id,
      scenario.surface,
      colorResult(scenario.result, colors),
      String(scenario.durationMs)
    ]);
  }

  return table.toString();
}

function escapeHatchLines(record) {
  if (record.escapeHatch.rawOpUses === 0) {
    return [];
  }

  const lines = [`Raw escape hatch uses: ${record.escapeHatch.rawOpUses}`];

  for (const use of record.escapeHatch.uses) {
    lines.push(`${use.scenarioId} [${use.surface}] step ${use.stepIndex}: ${use.reason}`);
  }

  return lines;
}

function healthLines(view, colors) {
  const lines = [];

  for (const rule of view.health.dead) {
    lines.push(colors.yellow(`Dead rule: ${rule.ruleId} proposed ${rule.proposedAction ?? "delete_rule"}`));
  }

  for (const rule of view.health.expired) {
    lines.push(colors.red(`Expired ignore: ${rule.ruleId} expired ${rule.expires ?? "unknown"}`));
  }

  for (const rule of view.health.expiringSoon) {
    lines.push(colors.yellow(`Expiring ignore: ${rule.ruleId} expires ${rule.expires ?? "unknown"}`));
  }

  return lines;
}

function deltaLines(record, colors, width) {
  const view = buildDeltaView(record);
  if (!view.present) {
    return null;
  }

  return [
    colors.bold(formatBucketHeader(view.counts)),
    tableFor(record, colors, width),
    "Delta rule suppressions:",
    formatRuleTable(view.rules),
    ...healthLines(view, colors),
    `Run ID: ${record.runId} | Ruleset hash: ${view.rulesetHash}`
  ];
}

export function renderConsoleSummary(runRecord, { color = false, width = 80 } = {}) {
  const record = RunRecordSchema.parse(runRecord);
  const colors = pc.createColors(color);
  const header = `${record.counts.total} scenarios: ${record.counts.passed} passed, ${record.counts.failed} failed, ${record.counts.skipped} skipped, ${record.counts.infra_error} infra`;
  const delta = deltaLines(record, colors, width);
  const parts = delta === null
    ? [header, tableFor(record, colors, width), ...escapeHatchLines(record)]
    : [header, ...delta, ...escapeHatchLines(record)];

  return `${parts.join("\n")}\n`;
}
